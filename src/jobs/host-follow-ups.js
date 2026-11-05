const cron = require('node-cron');
const pool = require('../config/db');
const { sendOptionalHostEmail } = require('../lib/mailer');
const { withActiveHostAccount } = require('../lib/outbound-account-status');
const { emailOptedOut, emailPreferenceUrls } = require('../lib/email-preferences');
const { eventEndAtSql } = require('../lib/post-event');
const { draftNudgeSuppressionSql } = require('../lib/draft-reminders');
const {
  FOLLOW_UP_SCOPE, FOLLOW_UP_MAX_ATTEMPTS, followUpSnapshot, buildHostFollowUpEmail
} = require('../lib/host-follow-up');

const FOLLOW_UP_HOURS = [10, 11, 12, 13];
const MAX_PER_PASS = 25;

// The positive permission, recent successful recap, local time, and bounded
// eligibility window all apply again immediately before a provider handoff.
// No historical claim timestamps or RSVP guest permissions enroll a host.
function eligibleFollowUpSql({ eventOnly = false } = {}) {
  return `SELECT e.id,e.organizer_id,e.title,account_email.email,
                 draft.id AS draft_event_id,draft.title AS draft_event_title
    FROM events e
    JOIN organizers host ON host.id=e.organizer_id
    JOIN users account ON account.id=host.user_id AND account.account_status='active'
    JOIN LATERAL (
      SELECT identity.value AS email FROM user_identities identity
       WHERE identity.user_id=host.user_id AND identity.identity_type='email'
         AND identity.verification_scope='account' AND identity.verified_at IS NOT NULL
         AND identity.revoked_at IS NULL
       ORDER BY identity.is_primary DESC,identity.id ASC LIMIT 1
    ) account_email ON TRUE
    LEFT JOIN LATERAL (
      SELECT d.id,d.title FROM events d
       WHERE d.organizer_id=host.id AND d.status='draft' AND d.archived_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM admin_flyer_requests flyer_request
            WHERE flyer_request.event_id=d.id AND flyer_request.status NOT IN ('published','rejected')
         )
       ORDER BY d.updated_at DESC,d.id DESC LIMIT 1
    ) draft ON TRUE
    WHERE e.status='published' AND NOW() >= (${eventEndAtSql('e')})
      ${draftNudgeSuppressionSql('host')}
      AND e.host_recap_delivered_at IS NOT NULL
      AND e.host_recap_delivered_at >= (
        SELECT applied_at FROM schema_migrations WHERE filename='074_host_follow_ups.sql'
      )
      AND e.host_recap_delivered_at <= NOW() - INTERVAL '3 days'
      AND e.host_recap_delivered_at > NOW() - INTERVAL '7 days'
      AND EXTRACT(HOUR FROM (NOW() AT TIME ZONE e.timezone)) = ANY($1::int[])
      AND EXISTS (
        SELECT 1 FROM email_optins optin
         WHERE optin.email=LOWER(BTRIM(account_email.email)) AND optin.scope='host_followups'
           AND optin.consent_version='host_followups_v1'
      )
      AND NOT EXISTS (
        SELECT 1 FROM email_optouts optout
         WHERE optout.email=LOWER(BTRIM(account_email.email)) AND optout.scope='host_followups'
      )
      AND NOT EXISTS (
        SELECT 1 FROM events upcoming
         WHERE upcoming.organizer_id=host.id AND upcoming.status='published'
           AND (${eventEndAtSql('upcoming')}) > NOW()
      )
      AND NOT EXISTS (
        SELECT 1 FROM host_event_follow_ups prior
         WHERE prior.organizer_id=host.id AND prior.event_id <> e.id
           AND prior.first_attempt_at > NOW() - INTERVAL '30 days'
      )
      AND NOT EXISTS (
        SELECT 1 FROM events recent_recap
         WHERE recent_recap.organizer_id=host.id
           AND recent_recap.host_recap_delivered_at > NOW() - INTERVAL '24 hours'
      )
      AND (host.host_profile_nudge_sent_at IS NULL OR host.host_profile_nudge_sent_at <= NOW() - INTERVAL '24 hours')
      AND (host.first_event_nudge_sent_at IS NULL OR host.first_event_nudge_sent_at <= NOW() - INTERVAL '24 hours')
      ${eventOnly ? 'AND e.id=$2' : ''}
      AND NOT EXISTS (
        SELECT 1 FROM host_event_follow_ups done
         WHERE done.event_id=e.id AND (done.status IN ('sent','suppressed')
           OR done.attempt_count >= ${FOLLOW_UP_MAX_ATTEMPTS}
           OR done.first_attempt_at < NOW() - INTERVAL '23 hours')
      )
    ORDER BY e.host_recap_delivered_at DESC,e.id DESC
    ${eventOnly ? 'LIMIT 1' : 'LIMIT $2'}`;
}

function createHostFollowUpWorker({
  db = pool,
  sendEmail = sendOptionalHostEmail,
  withAccount = withActiveHostAccount
} = {}) {
  let running = false;

  async function pendingFollowUpEvents(hours = FOLLOW_UP_HOURS) {
    const { rows } = await db.query(eligibleFollowUpSql(), [hours, MAX_PER_PASS]);
    return rows;
  }

  async function deliverHostFollowUp(candidate, hours = FOLLOW_UP_HOURS) {
    try {
      const guarded = await withAccount(db, candidate.organizer_id, async client => {
        const connection = client || db;
        const { rows } = await connection.query(eligibleFollowUpSql({ eventOnly: true }), [hours, candidate.id]);
        const current = rows[0];
        if (!current || Number(current.organizer_id) !== Number(candidate.organizer_id)
            || await emailOptedOut(connection, current.email, FOLLOW_UP_SCOPE)) return false;

        const snapshot = followUpSnapshot(current);
        const recipient = String(current.email || '').trim().toLowerCase();
        const preferences = emailPreferenceUrls(recipient, FOLLOW_UP_SCOPE);
        const renderSnapshot = {
          ...snapshot,
          email: buildHostFollowUpEmail({ snapshot, ...preferences }),
          unsubscribeUrl: preferences.unsubscribeUrl
        };
        await connection.query(
          `INSERT INTO host_event_follow_ups (event_id,organizer_id,recipient,render_snapshot)
           VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (event_id) DO NOTHING`,
          [current.id, current.organizer_id, recipient, JSON.stringify(renderSnapshot)]
        );
        const { rows: stored } = await connection.query(
          'SELECT * FROM host_event_follow_ups WHERE event_id=$1 AND organizer_id=$2',
          [current.id, current.organizer_id]
        );
        const delivery = stored[0];
        // A changed verified address or changed draft destination must never
        // reuse an attempted provider key with a different payload.
        const saved = delivery?.render_snapshot;
        if (!delivery || delivery.recipient !== recipient || !saved?.email?.html
            || !saved?.email?.subject || !saved?.email?.text || !saved?.unsubscribeUrl
            || ['version', 'draftId', 'draftTitle', 'sourceTitle'].some(key => saved[key] !== snapshot[key])) {
          if (delivery) await connection.query(
            `UPDATE host_event_follow_ups SET status='suppressed',error='context_changed',updated_at=NOW() WHERE event_id=$1`,
            [current.id]
          );
          return false;
        }

        const { rows: claimed } = await connection.query(
          `UPDATE host_event_follow_ups
              SET attempt_count=attempt_count+1,first_attempt_at=COALESCE(first_attempt_at,NOW()),
                  last_attempt_at=NOW(),updated_at=NOW(),status='pending'
            WHERE event_id=$1 AND organizer_id=$2 AND status IN ('pending','failed')
              AND attempt_count < $3
              AND (first_attempt_at IS NULL OR first_attempt_at >= NOW() - INTERVAL '23 hours')
              AND (last_attempt_at IS NULL OR last_attempt_at <= NOW() - INTERVAL '2 minutes')
            RETURNING event_id`,
          [current.id, current.organizer_id, FOLLOW_UP_MAX_ATTEMPTS]
        );
        if (!claimed.length) return false;
        // Snapshot persistence and the claim involve additional round trips.
        // Honor an opt-out accepted during that preparation before handoff.
        if (await emailOptedOut(connection, recipient, FOLLOW_UP_SCOPE)) {
          await connection.query(
            `UPDATE host_event_follow_ups SET status='suppressed',error='permission_revoked',updated_at=NOW() WHERE event_id=$1`,
            [current.id]
          );
          return false;
        }
        try {
          const result = await sendEmail({
            to: recipient,
            ...saved.email,
            unsubscribeUrl: saved.unsubscribeUrl,
            idempotencyKey: `sge-host-follow-up-v1-${current.id}`
          });
          await connection.query(
            `UPDATE host_event_follow_ups SET status='sent',sent_at=NOW(),provider_id=$2,error=NULL,updated_at=NOW()
              WHERE event_id=$1`,
            [current.id, result?.id || null]
          );
          return true;
        } catch (error) {
          await connection.query(
            `UPDATE host_event_follow_ups SET status='failed',error='delivery_failed',updated_at=NOW() WHERE event_id=$1`,
            [current.id]
          );
          throw error;
        }
      });
      return Boolean(guarded.allowed && guarded.result);
    } catch (error) {
      console.error('[host-follow-ups] delivery failed', { eventId: candidate.id, error: error.message });
      return false;
    }
  }

  async function runHostFollowUpPass({ hours = FOLLOW_UP_HOURS } = {}) {
    if (running) return 0;
    running = true;
    let sent = 0;
    try {
      // Unknown outcomes beyond provider idempotency are terminal. Keeping the
      // attempted row also reserves the host's 30-day frequency budget.
      await db.query(
        `UPDATE host_event_follow_ups SET status='failed',attempt_count=$1,
             error='delivery_outcome_unknown',updated_at=NOW()
          WHERE status IN ('pending','failed') AND attempt_count > 0 AND attempt_count < $1
            AND first_attempt_at < NOW() - INTERVAL '23 hours'`,
        [FOLLOW_UP_MAX_ATTEMPTS]
      );
      for (const event of await pendingFollowUpEvents(hours)) {
        if (await deliverHostFollowUp(event, hours)) sent += 1;
      }
    } catch (error) {
      console.error('[host-follow-ups] pass failed:', error.message);
    } finally {
      running = false;
    }
    return sent;
  }

  return { pendingFollowUpEvents, deliverHostFollowUp, runHostFollowUpPass };
}

const worker = createHostFollowUpWorker();

function startHostFollowUpCron() {
  if (process.env.REMINDERS_ENABLED === 'false') {
    console.log('[host-follow-ups] disabled via REMINDERS_ENABLED=false');
    return;
  }
  cron.schedule('27 * * * *', () => worker.runHostFollowUpPass());
  console.log('[host-follow-ups] optional hourly cron scheduled (three days after recap, event-local)');
}

module.exports = { ...worker, createHostFollowUpWorker, eligibleFollowUpSql, startHostFollowUpCron, FOLLOW_UP_HOURS };
