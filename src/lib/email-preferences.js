const crypto = require('crypto');

const SECRET = String(process.env.SESSION_SECRET || '').trim();
if (!SECRET) throw new Error('SESSION_SECRET is required');

const EMAIL_PREFERENCE_SCOPES = Object.freeze({
  host_recaps: Object.freeze({
    label: 'Morning-after host recaps',
    description: 'Receive one recap after an event with confirmed RSVPs. RSVP counts are not verified attendance.'
  }),
  product_updates: Object.freeze({
    label: 'Silver Glider product announcements',
    description: 'Receive occasional announcements about new Silver Glider tools and services.'
  }),
  host_onboarding: Object.freeze({
    label: 'Host Page setup tips',
    description: 'Receive up to two optional emails that help you finish your Host Page and publish your first event.'
  }),
  host_followups: Object.freeze({
    label: 'A nudge toward your next event',
    description: 'Receive one optional email about three days after a recap when you have no upcoming event. At most once every 30 days. Off until you turn it on.',
    consentVersion: 'host_followups_v1'
  }),
  host_drafts: Object.freeze({
    label: 'Saved event draft reminders',
    description: 'Receive one optional reminder for a saved event draft, at most once every seven days. Your draft stays private until you publish.',
    consentVersion: 'host_drafts_v1'
  })
});

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validScope(scope) {
  return Object.prototype.hasOwnProperty.call(EMAIL_PREFERENCE_SCOPES, scope);
}

function signEmailPreference(email, scope) {
  const normalized = normalizeEmail(email);
  if (!normalized || !validScope(scope)) throw new Error('Invalid email preference');
  const payload = Buffer.from(JSON.stringify({ version: 1, email: normalized, scope })).toString('base64url');
  const signature = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyEmailPreference(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  if (signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const email = normalizeEmail(decoded.email);
    const scope = String(decoded.scope || '');
    if (decoded.version !== 1 || !email || !validScope(scope)) return null;
    return { email, scope };
  } catch (_) {
    return null;
  }
}

function emailPreferenceUrls(email, scope) {
  const baseUrl = String(process.env.APP_URL || 'https://silvergliderevents.com').replace(/\/$/, '');
  const token = encodeURIComponent(signEmailPreference(email, scope));
  return {
    manageUrl: `${baseUrl}/email-settings?token=${token}`,
    unsubscribeUrl: `${baseUrl}/unsubscribe-email?token=${token}`
  };
}

async function emailOptedOut(db, email, scope) {
  const normalized = normalizeEmail(email);
  if (!normalized || !validScope(scope)) return false;
  if (scope === 'host_drafts') {
    // A direct draft opt-out always wins. Other explicit host-nudge opt-outs
    // carry forward unless drafts were deliberately enabled more recently.
    const { rows } = await db.query(
      `SELECT 1 FROM email_optouts optout
        WHERE optout.email=$1 AND (optout.scope=$2 OR (
          optout.scope IN ('host_onboarding','host_followups') AND NOT EXISTS (
            SELECT 1 FROM email_optins optin
             WHERE optin.email=$1 AND optin.scope=$2 AND optin.consent_version=$3
               AND optin.updated_at > optout.updated_at
          )
        )) LIMIT 1`,
      [normalized, scope, EMAIL_PREFERENCE_SCOPES.host_drafts.consentVersion]
    );
    return rows.length > 0;
  }
  if (scope === 'host_followups') {
    const { rows } = await db.query(
      `SELECT 1 FROM email_optins optin
        WHERE optin.email=$1 AND optin.scope=$2 AND optin.consent_version=$3
          AND NOT EXISTS (
            SELECT 1 FROM email_optouts optout WHERE optout.email=$1 AND optout.scope=$2
          )`,
      [normalized, scope, EMAIL_PREFERENCE_SCOPES.host_followups.consentVersion]
    );
    return rows.length === 0;
  }
  const { rows } = await db.query(
    'SELECT 1 FROM email_optouts WHERE email=$1 AND scope=$2',
    [normalized, scope]
  );
  return rows.length > 0;
}

async function setEmailPreference(db, email, scope, enabled) {
  const normalized = normalizeEmail(email);
  if (!normalized || !validScope(scope)) throw new Error('Invalid email preference');
  if (enabled) {
    await db.query('DELETE FROM email_optouts WHERE email=$1 AND scope=$2', [normalized, scope]);
    if (scope === 'host_followups' || scope === 'host_drafts') {
      await db.query(
        `INSERT INTO email_optins (email,scope,consent_version,consent_text)
         VALUES ($1,$2,$3,$4) ON CONFLICT (email,scope)
         DO UPDATE SET consent_version=EXCLUDED.consent_version,consent_text=EXCLUDED.consent_text,updated_at=NOW()`,
        [normalized, scope, EMAIL_PREFERENCE_SCOPES[scope].consentVersion,
          EMAIL_PREFERENCE_SCOPES[scope].description]
      );
    }
  } else {
    await db.query(
      `INSERT INTO email_optouts (email,scope)
       VALUES ($1,$2)
       ON CONFLICT (email,scope) DO UPDATE SET updated_at=NOW()`,
      [normalized, scope]
    );
    if (scope === 'host_followups' || scope === 'host_drafts') {
      await db.query('DELETE FROM email_optins WHERE email=$1 AND scope=$2', [normalized, scope]);
    }
  }
}

module.exports = {
  EMAIL_PREFERENCE_SCOPES,
  normalizeEmail,
  signEmailPreference,
  verifyEmailPreference,
  emailPreferenceUrls,
  emailOptedOut,
  setEmailPreference
};
