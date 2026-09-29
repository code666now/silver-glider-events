const crypto = require('crypto');

const SECRET = String(process.env.SESSION_SECRET || '').trim();
if (!SECRET) throw new Error('SESSION_SECRET is required');

const EMAIL_PREFERENCE_SCOPES = Object.freeze({
  host_recaps: Object.freeze({
    label: 'Morning-after host recaps',
    description: 'Receive one recap after an event when confirmed guests attended.'
  }),
  product_updates: Object.freeze({
    label: 'Silver Glider product announcements',
    description: 'Receive occasional announcements about new Silver Glider tools and services.'
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
  } else {
    await db.query(
      `INSERT INTO email_optouts (email,scope)
       VALUES ($1,$2)
       ON CONFLICT (email,scope) DO UPDATE SET updated_at=NOW()`,
      [normalized, scope]
    );
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
