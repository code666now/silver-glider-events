const cron = require('node-cron');
const pool = require('../config/db');
const { sendHostProfileNudge, sendFirstEventNudge } = require('../lib/mailer');
const { emailOptedOut, emailPreferenceUrls } = require('../lib/email-preferences');
const { HOST_ACCOUNT_INACTIVE, withActiveHostAccount } = require('../lib/outbound-account-status');

const EMAIL_SCOPE = 'host_onboarding';
const MAX_PER_PASS = 25;
let running = false;

const verifiedEmailJoin = `
  JOIN LATERAL (
    SELECT identity.value AS email
      FROM user_identities identity
     WHERE identity.user_id=host.user_id
       AND identity.identity_type='email'
       AND identity.verification_scope='account'
       AND identity.verified_at IS NOT NULL
       AND identity.revoked_at IS NULL
     ORDER BY identity.is_primary DESC, identity.id ASC
     LIMIT 1
  ) account_email ON TRUE`;

async function pendingProfileNudges(limit = MAX_PER_PASS) {
  const { rows } = await pool.query(
    `SELECT host.id,host.org_name,host.public_slug,account_email.email
       FROM organizers host
       JOIN users account ON account.id=host.user_id AND account.account_status='active'
       ${verifiedEmailJoin}
      WHERE host.host_page_created_at IS NOT NULL
        AND host.host_page_created_at <= NOW() - INTERVAL '24 hours'
        AND host.host_profile_nudge_sent_at IS NULL
        AND NULLIF(BTRIM(host.logo_url),'') IS NULL
        AND NULLIF(BTRIM(host.bio),'') IS NULL
        AND NULLIF(BTRIM(host.instagram_handle),'') IS NULL
        AND NULLIF(BTRIM(host.website_url),'') IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM email_optouts optout
           WHERE optout.email=LOWER(BTRIM(account_email.email))
             AND optout.scope=$1
        )
      ORDER BY host.host_page_created_at,host.id
      LIMIT $2`,
    [EMAIL_SCOPE, limit]
  );
  return rows;
}

async function pendingFirstEventNudges(limit = MAX_PER_PASS) {
  const { rows } = await pool.query(
    `SELECT host.id,host.org_name,host.public_slug,account_email.email,
            draft.id AS draft_event_id,draft.title AS draft_event_title
       FROM organizers host
       JOIN users account ON account.id=host.user_id AND account.account_status='active'
       ${verifiedEmailJoin}
       LEFT JOIN LATERAL (
         SELECT event.id,event.title
           FROM events event
          WHERE event.organizer_id=host.id AND event.status='draft'
          ORDER BY event.updated_at DESC,event.id DESC
          LIMIT 1
       ) draft ON TRUE
      WHERE host.host_page_created_at IS NOT NULL
        AND host.host_page_created_at <= NOW() - INTERVAL '72 hours'
        AND host.first_event_nudge_sent_at IS NULL
        AND host.first_event_published_at IS NULL
        AND (
          (
            host.host_profile_nudge_sent_at IS NULL
            AND NOT (
              NULLIF(BTRIM(host.logo_url),'') IS NULL
              AND NULLIF(BTRIM(host.bio),'') IS NULL
              AND NULLIF(BTRIM(host.instagram_handle),'') IS NULL
              AND NULLIF(BTRIM(host.website_url),'') IS NULL
            )
          )
          OR host.host_profile_nudge_sent_at <= NOW() - INTERVAL '24 hours'
        )
        AND NOT EXISTS (
          SELECT 1 FROM email_optouts optout
           WHERE optout.email=LOWER(BTRIM(account_email.email))
             AND optout.scope=$1
        )
      ORDER BY host.host_page_created_at,host.id
      LIMIT $2`,
    [EMAIL_SCOPE, limit]
  );
  return rows;
}

async function eligibleProfileNudge(organizerId) {
  const { rows } = await pool.query(
    `SELECT host.id,host.org_name,host.public_slug,account_email.email
       FROM organizers host
       JOIN users account ON account.id=host.user_id AND account.account_status='active'
       ${verifiedEmailJoin}
      WHERE host.id=$1
        AND host.host_page_created_at IS NOT NULL
        AND host.host_page_created_at <= NOW() - INTERVAL '24 hours'
        AND host.host_profile_nudge_sent_at IS NULL
        AND NULLIF(BTRIM(host.logo_url),'') IS NULL
        AND NULLIF(BTRIM(host.bio),'') IS NULL
        AND NULLIF(BTRIM(host.instagram_handle),'') IS NULL
        AND NULLIF(BTRIM(host.website_url),'') IS NULL`,
    [organizerId]
  );
  return rows[0] || null;
}

async function eligibleFirstEventNudge(organizerId) {
  const { rows } = await pool.query(
    `SELECT host.id,host.org_name,host.public_slug,account_email.email,
            draft.id AS draft_event_id,draft.title AS draft_event_title
       FROM organizers host
       JOIN users account ON account.id=host.user_id AND account.account_status='active'
       ${verifiedEmailJoin}
       LEFT JOIN LATERAL (
         SELECT event.id,event.title
           FROM events event
          WHERE event.organizer_id=host.id AND event.status='draft'
          ORDER BY event.updated_at DESC,event.id DESC
          LIMIT 1
       ) draft ON TRUE
      WHERE host.id=$1
        AND host.host_page_created_at IS NOT NULL
        AND host.host_page_created_at <= NOW() - INTERVAL '72 hours'
        AND host.first_event_nudge_sent_at IS NULL
        AND host.first_event_published_at IS NULL
        AND (
          (
            host.host_profile_nudge_sent_at IS NULL
            AND NOT (
              NULLIF(BTRIM(host.logo_url),'') IS NULL
              AND NULLIF(BTRIM(host.bio),'') IS NULL
              AND NULLIF(BTRIM(host.instagram_handle),'') IS NULL
              AND NULLIF(BTRIM(host.website_url),'') IS NULL
            )
          )
          OR host.host_profile_nudge_sent_at <= NOW() - INTERVAL '24 hours'
        )`,
    [organizerId]
  );
  return rows[0] || null;
}

async function markNudgeSent(organizerId, column) {
  const allowedColumns = new Set(['host_profile_nudge_sent_at', 'first_event_nudge_sent_at']);
  if (!allowedColumns.has(column)) throw new Error('Invalid host onboarding timestamp');
  const result = await pool.query(
    `UPDATE organizers SET ${column}=NOW() WHERE id=$1 AND ${column} IS NULL`,
    [organizerId]
  );
  return result.rowCount === 1;
}

async function deliverProfileNudge(host) {
  try {
    const delivery = await withActiveHostAccount(pool, host.id, async () => {
      const current = await eligibleProfileNudge(host.id);
      const email = String(current?.email || '').trim();
      if (!current || !email || await emailOptedOut(pool, email, EMAIL_SCOPE)) return false;

      const baseUrl = String(process.env.APP_URL || 'https://silvergliderevents.com').replace(/\/$/, '');
      const preferences = emailPreferenceUrls(email, EMAIL_SCOPE);
      await sendHostProfileNudge({
        to: email,
        hostName: current.org_name,
        hostPageUrl: `${baseUrl}/h/${encodeURIComponent(current.public_slug)}`,
        ...preferences,
        idempotencyKey: `sge-host-onboarding-profile-v1-${host.id}`
      });
      return markNudgeSent(host.id, 'host_profile_nudge_sent_at');
    });
    if (!delivery.allowed) {
      console.log(`[host-onboarding] profile skipped for host ${host.id}: ${HOST_ACCOUNT_INACTIVE}`);
      return false;
    }
    return Boolean(delivery.result);
  } catch (error) {
    console.error('[host-onboarding] profile send failed', { organizerId: host.id, error: error.message });
    return false;
  }
}

async function deliverFirstEventNudge(host) {
  try {
    const delivery = await withActiveHostAccount(pool, host.id, async () => {
      const current = await eligibleFirstEventNudge(host.id);
      const email = String(current?.email || '').trim();
      if (!current || !email || await emailOptedOut(pool, email, EMAIL_SCOPE)) return false;

      const preferences = emailPreferenceUrls(email, EMAIL_SCOPE);
      await sendFirstEventNudge({
        to: email,
        draftEvent: current.draft_event_id
          ? { id: current.draft_event_id, title: current.draft_event_title }
          : null,
        ...preferences,
        idempotencyKey: `sge-host-onboarding-first-event-v1-${host.id}`
      });
      return markNudgeSent(host.id, 'first_event_nudge_sent_at');
    });
    if (!delivery.allowed) {
      console.log(`[host-onboarding] event skipped for host ${host.id}: ${HOST_ACCOUNT_INACTIVE}`);
      return false;
    }
    return Boolean(delivery.result);
  } catch (error) {
    console.error('[host-onboarding] event send failed', { organizerId: host.id, error: error.message });
    return false;
  }
}

async function runHostOnboardingPass() {
  if (running) return { profile: 0, event: 0 };
  running = true;
  const sent = { profile: 0, event: 0 };
  try {
    for (const host of await pendingProfileNudges()) {
      if (await deliverProfileNudge(host)) sent.profile += 1;
    }
    // Query after profile delivery. A newly sent profile tip pushes the event
    // tip back at least 24 hours, so a delayed worker never sends both at once.
    for (const host of await pendingFirstEventNudges()) {
      if (await deliverFirstEventNudge(host)) sent.event += 1;
    }
  } catch (error) {
    console.error('[host-onboarding] pass failed:', error.message);
  } finally {
    running = false;
  }
  return sent;
}

function startHostOnboardingCron() {
  if (process.env.REMINDERS_ENABLED === 'false') {
    console.log('[host-onboarding] disabled via REMINDERS_ENABLED=false');
    return;
  }
  cron.schedule('17 * * * *', () => runHostOnboardingPass());
  const initial = setTimeout(() => runHostOnboardingPass(), 2500);
  initial.unref?.();
  console.log('[host-onboarding] hourly cron scheduled');
}

module.exports = {
  EMAIL_SCOPE,
  MAX_PER_PASS,
  deliverFirstEventNudge,
  deliverProfileNudge,
  pendingFirstEventNudges,
  pendingProfileNudges,
  runHostOnboardingPass,
  startHostOnboardingCron
};
