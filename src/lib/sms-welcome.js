const crypto = require('crypto');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { canAccessSmsCredits, SmsCreditError } = require('./sms-credit-ledger');

const CAMPAIGN_KEY = 'welcome-texts-v1';
const WELCOME_CREDITS = 50;

function campaignConfig(env = process.env) {
  const cap = Number(env.SMS_WELCOME_CLAIM_CAP || 200);
  return {
    enabled: !['false', '0', 'off'].includes(String(env.SMS_WELCOME_ENABLED ?? 'true').trim().toLowerCase()),
    claimCap: Number.isInteger(cap) && cap >= 0 && cap <= 100000 ? cap : 200
  };
}

// Do not mistake every +1 destination for the United States (NANP also includes
// Canada and the Caribbean). Unsupported destinations can still use paid funds.
function isWelcomeSmsDestination(phone) {
  try {
    const parsed = parsePhoneNumberFromString(String(phone || ''));
    return Boolean(parsed && parsed.country === 'US' && parsed.isValid());
  } catch (_) { return false; }
}

function identityKey(secret, type, value) {
  return crypto.createHmac('sha256', secret).update(`${CAMPAIGN_KEY}:${type}:${value}`).digest('hex');
}

function fingerprint(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function loadAccount(db, organizerId, { lock = false } = {}) {
  const account = (await db.query(
    `SELECT o.id,o.user_id,o.sms_credits,o.sms_welcome_credits,o.public_slug,
            o.first_event_published_at,u.account_status
       FROM organizers o JOIN users u ON u.id=COALESCE(o.user_id,o.id)
      WHERE o.id=$1${lock ? ' FOR UPDATE OF u,o' : ''}`, [organizerId]
  )).rows[0];
  if (!account || account.account_status !== 'active') return null;
  const identities = (await db.query(
    `SELECT identity_type,normalized_value FROM user_identities
      WHERE user_id=$1 AND revoked_at IS NULL AND verification_scope='account'
        AND verified_at IS NOT NULL AND identity_type IN ('email','phone')
      ORDER BY is_primary DESC,id`, [account.user_id || account.id]
  )).rows;
  return { ...account,
    email: identities.find(row => row.identity_type === 'email')?.normalized_value || null,
    phone: identities.find(row => row.identity_type === 'phone')?.normalized_value || null,
    identities
  };
}

async function pendingReminders(db, organizerId) {
  // Lazy import avoids a circular dependency with the credit reservation path.
  const { eventForSms, makePreview } = require('./sms-reminder-fulfillment');
  const events = (await db.query(
    `SELECT e.id FROM events e
      WHERE e.organizer_id=$1 AND e.status='published' AND e.sms_reminder_enabled=TRUE
        AND e.secret_show_enabled=FALSE
        AND e.event_date >= ((CURRENT_TIMESTAMP AT TIME ZONE e.timezone)::date + 1)
        AND NOT EXISTS (SELECT 1 FROM sms_notification_batches b
          WHERE b.event_id=e.id AND b.kind='event_tomorrow')
      ORDER BY e.event_date,e.id`, [organizerId]
  )).rows;
  const reminders = [];
  for (const row of events) {
    const event = await eventForSms(db, row.id, organizerId);
    if (!event) continue;
    const preview = await makePreview(db, event, { requireTomorrow: false });
    reminders.push({
      eventId: String(event.id), title: event.title, eventDate: event.event_date,
      recipientCount: preview.recipientCount, creditCost: preview.creditCost,
      welcomeEligibleCredits: Number(preview.welcomeEligibleCredits),
      fingerprint: preview.fingerprint
    });
  }
  return reminders;
}

async function welcomeStatus(db, organizer, { env = process.env, lock = false } = {}) {
  const config = campaignConfig(env);
  const base = {
    enabled: config.enabled && canAccessSmsCredits(organizer, env), state: 'disabled',
    credits: WELCOME_CREDITS, availableCredits: 0, claimedAt: null,
    verificationUrl: '/settings/account', missingVerification: [],
    previewFingerprint: null, pendingReminders: [], pendingReminderCredits: 0,
    firstPublishedEventId: null, firstPublishedAt: null, firstEventRecentlyPublished: false,
    shareEventUrl: null, hostPageUrl: null, destinationNotice: 'Complimentary texts are for U.S. phone numbers.'
  };
  const account = await loadAccount(db, organizer.id, { lock });
  if (!account) return { ...base, state: 'unavailable' };
  base.availableCredits = Number(account.sms_welcome_credits || 0);
  base.hostPageUrl = account.public_slug ? `/h/${encodeURIComponent(account.public_slug)}` : null;
  const ownClaim = (await db.query(
    `SELECT id,claimed_at FROM sms_welcome_claims WHERE organizer_id=$1 AND campaign_key=$2`,
    [account.id, CAMPAIGN_KEY]
  )).rows[0];
  const firstEvent = (await db.query(
    `SELECT id,slug FROM events WHERE organizer_id=$1 AND status='published'
      ORDER BY created_at,id LIMIT 1`, [account.id]
  )).rows[0];
  base.firstPublishedEventId = firstEvent ? String(firstEvent.id) : null;
  base.firstPublishedAt = account.first_event_published_at || null;
  const publishedAge = Date.now() - new Date(base.firstPublishedAt || 0).getTime();
  base.firstEventRecentlyPublished = publishedAge >= 0 && publishedAge < 24 * 60 * 60 * 1000;
  base.shareEventUrl = firstEvent ? `/e/${encodeURIComponent(firstEvent.slug)}` : null;
  if (ownClaim) return { ...base, state: 'claimed', claimedAt: ownClaim.claimed_at };
  if (!base.enabled) return base;
  if (!firstEvent) return { ...base, state: 'needs_event' };
  base.missingVerification = ['email', 'phone'].filter(type => !account[type]);
  if (base.missingVerification.length) return { ...base, state: 'needs_verification' };
  const campaign = (await db.query(
    'SELECT identity_hmac_key FROM sms_welcome_campaigns WHERE campaign_key=$1', [CAMPAIGN_KEY]
  )).rows[0];
  if (campaign) {
    const keys = account.identities.map(identity => identityKey(
      campaign.identity_hmac_key, identity.identity_type, identity.normalized_value
    ));
    const claimed = (await db.query(
      `SELECT 1 FROM sms_welcome_claims WHERE campaign_key=$1 AND
        (account_key=$2 OR email_key=ANY($3::text[]) OR phone_key=ANY($3::text[])) LIMIT 1`,
      [CAMPAIGN_KEY, identityKey(campaign.identity_hmac_key, 'account', account.user_id || account.id), keys]
    )).rows.length > 0;
    if (claimed) return { ...base, state: 'unavailable' };
  }
  const count = Number((await db.query(
    'SELECT COUNT(*)::int AS count FROM sms_welcome_claims WHERE campaign_key=$1', [CAMPAIGN_KEY]
  )).rows[0].count);
  if (count >= config.claimCap) return { ...base, state: 'unavailable' };
  const reminders = await pendingReminders(db, account.id, { lock });
  base.pendingReminders = reminders.map(({ fingerprint: ignored, ...item }) => item);
  base.pendingReminderCredits = reminders.reduce((sum, reminder) => sum + reminder.creditCost, 0);
  base.previewFingerprint = fingerprint({
    campaign: CAMPAIGN_KEY, account: account.user_id || account.id, balance: Number(account.sms_credits || 0),
    email: account.email, phone: account.phone, reminders
  });
  return { ...base, state: 'eligible' };
}

async function claimWelcomeCredits(db, organizer, { confirm, previewFingerprint, env = process.env } = {}) {
  if (confirm !== true) throw new SmsCreditError('Confirm your welcome texts before claiming.', {
    code: 'welcome_confirmation_required', status: 400
  });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO sms_welcome_campaigns(campaign_key,identity_hmac_key)
       VALUES ($1,$2) ON CONFLICT (campaign_key) DO NOTHING`,
      [CAMPAIGN_KEY, crypto.randomBytes(32).toString('hex')]
    );
    const campaign = (await client.query(
      'SELECT * FROM sms_welcome_campaigns WHERE campaign_key=$1 FOR UPDATE', [CAMPAIGN_KEY]
    )).rows[0];
    const state = await welcomeStatus(client, organizer, { env, lock: true });
    if (state.state === 'claimed') {
      const balance = Number((await client.query('SELECT sms_credits FROM organizers WHERE id=$1', [organizer.id])).rows[0].sms_credits);
      await client.query('COMMIT');
      return { claimed: true, duplicate: true, balance, welcome: state };
    }
    if (state.state !== 'eligible') {
      const error = new SmsCreditError('The welcome-text offer is not available for this account yet.', {
        code: `welcome_${state.state}`, status: state.state === 'disabled' ? 404 : 409
      });
      error.welcome = state;
      throw error;
    }
    if (!previewFingerprint || previewFingerprint !== state.previewFingerprint) {
      const error = new SmsCreditError('Your reminder estimate changed. Review it before claiming.', {
        code: 'welcome_preview_changed', status: 409
      });
      error.welcome = state;
      throw error;
    }
    const account = await loadAccount(client, organizer.id);
    const claim = (await client.query(
      `INSERT INTO sms_welcome_claims(campaign_key,organizer_id,account_key,email_key,phone_key)
       VALUES ($1,$2,$3,$4,$5) RETURNING id,claimed_at`,
      [CAMPAIGN_KEY, organizer.id,
        identityKey(campaign.identity_hmac_key, 'account', account.user_id || account.id),
        identityKey(campaign.identity_hmac_key, 'email', account.email),
        identityKey(campaign.identity_hmac_key, 'phone', account.phone)]
    )).rows[0];
    const balance = Number((await client.query(
      `UPDATE organizers SET sms_credits=sms_credits+$2,sms_welcome_credits=sms_welcome_credits+$2,
        updated_at=NOW() WHERE id=$1 RETURNING sms_credits`, [organizer.id, WELCOME_CREDITS]
    )).rows[0].sms_credits);
    await client.query(
      `INSERT INTO sms_credit_transactions(organizer_id,kind,credits_delta,balance_after,external_key,metadata)
       VALUES ($1,'adjustment',$2,$3,$4,$5::jsonb)`,
      [organizer.id, WELCOME_CREDITS, balance, `${CAMPAIGN_KEY}:claim:${claim.id}`,
        JSON.stringify({ reason: 'welcome_credit', campaignKey: CAMPAIGN_KEY, welcomeCredits: WELCOME_CREDITS })]
    );
    await client.query('COMMIT');
    return { claimed: true, duplicate: false, balance, welcome: {
      ...state, state: 'claimed', claimedAt: claim.claimed_at, availableCredits: WELCOME_CREDITS
    } };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function getWelcomeCampaignSummary(db, { env = process.env } = {}) {
  const row = (await db.query(
    `SELECT COUNT(*)::int AS claims,COALESCE(SUM(c.granted_credits),0)::int AS granted,
            COALESCE(SUM(c.funded_credits),0)::int AS reserved,
            COALESCE(SUM(c.accepted_credits),0)::int AS accepted,
            COALESCE(SUM(o.sms_welcome_credits) FILTER (WHERE u.account_status<>'deleted'),0)::int AS remaining,
            COALESCE(SUM(c.granted_credits-c.funded_credits)
              FILTER (WHERE o.id IS NULL OR u.account_status='deleted'),0)::int AS deleted_remaining,
            MIN(c.claimed_at) AS started_at
       FROM sms_welcome_claims c LEFT JOIN organizers o ON o.id=c.organizer_id
       LEFT JOIN users u ON u.id=COALESCE(o.user_id,o.id)
      WHERE c.campaign_key=$1`, [CAMPAIGN_KEY]
  )).rows[0];
  const config = campaignConfig(env);
  return { claims: Number(row.claims), creditsGranted: Number(row.granted), creditsRemaining: Number(row.remaining),
    creditsReserved: Number(row.reserved), acceptedCredits: Number(row.accepted),
    deletedRemainingCredits: Number(row.deleted_remaining), cap: config.claimCap,
    enabled: config.enabled, startedAt: row.started_at };
}

module.exports = { CAMPAIGN_KEY, WELCOME_CREDITS, campaignConfig, isWelcomeSmsDestination,
  identityKey, pendingReminders, welcomeStatus, claimWelcomeCredits, getWelcomeCampaignSummary };
