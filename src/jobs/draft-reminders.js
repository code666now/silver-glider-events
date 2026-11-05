const cron = require('node-cron');
const pool = require('../config/db');
const { sendOptionalHostEmail } = require('../lib/mailer');
const { buildDraftReminderEmail } = require('../lib/draft-reminder-email');
const { emailOptedOut, emailPreferenceUrls } = require('../lib/email-preferences');
const { withActiveHostAccount } = require('../lib/outbound-account-status');
const {
  DRAFT_REMINDER_SCOPE, DRAFT_REMINDER_MAX_ATTEMPTS, draftRemindersEnabled, eligibleDraftSql
} = require('../lib/draft-reminders');

const MAX_PER_PASS = 25;

function eligibleDraftReminderSql({ eventOnly = false } = {}) {
  return `SELECT draft.id,draft.organizer_id,draft.title,draft.draft_host_activity_at,
                 draft.draft_host_activity_at::text AS draft_activity_version,account_email.email
    FROM organizers host
    JOIN users account ON account.id=host.user_id AND account.account_status='active'
    JOIN LATERAL (
      SELECT identity.value AS email FROM user_identities identity
       WHERE identity.user_id=host.user_id AND identity.identity_type='email'
         AND identity.verification_scope='account' AND identity.verified_at IS NOT NULL
         AND identity.revoked_at IS NULL
       ORDER BY identity.is_primary DESC,identity.id ASC LIMIT 1
    ) account_email ON TRUE
    JOIN LATERAL (
      SELECT candidate.* FROM events candidate
       WHERE candidate.organizer_id=host.id AND ${eligibleDraftSql('candidate')}
       ORDER BY candidate.draft_host_activity_at DESC,candidate.id DESC LIMIT 1
    ) draft ON TRUE
    LEFT JOIN event_draft_reminders delivery ON delivery.event_id=draft.id
    WHERE draft.draft_host_activity_at <= NOW() - INTERVAL '24 hours'
      AND (delivery.event_id IS NULL OR (
        delivery.status IN ('pending','failed') AND delivery.attempt_count < ${DRAFT_REMINDER_MAX_ATTEMPTS}
        AND (delivery.first_attempt_at IS NULL OR delivery.first_attempt_at >= NOW() - INTERVAL '23 hours')
        AND (delivery.last_attempt_at IS NULL OR delivery.last_attempt_at <= NOW() - INTERVAL '2 minutes')
      ))
      AND (host.last_draft_reminder_attempt_at IS NULL
        OR host.last_draft_reminder_attempt_at <= NOW() - INTERVAL '7 days'
        OR delivery.first_attempt_at=host.last_draft_reminder_attempt_at)
      AND (host.host_profile_nudge_sent_at IS NULL OR host.host_profile_nudge_sent_at <= NOW() - INTERVAL '7 days')
      AND (host.first_event_nudge_sent_at IS NULL OR host.first_event_nudge_sent_at <= NOW() - INTERVAL '7 days')
      AND NOT EXISTS (
        SELECT 1 FROM host_event_follow_ups followup WHERE followup.organizer_id=host.id
          AND followup.first_attempt_at > NOW() - INTERVAL '7 days'
      )
      AND NOT EXISTS (
        SELECT 1 FROM events recap WHERE recap.organizer_id=host.id
          AND recap.host_recap_delivered_at > NOW() - INTERVAL '24 hours'
      )
      AND NOT EXISTS (
        SELECT 1 FROM email_optouts optout
         WHERE optout.email=LOWER(BTRIM(account_email.email)) AND optout.scope='host_drafts'
      )
      AND NOT EXISTS (
        SELECT 1 FROM email_optouts inherited
         WHERE inherited.email=LOWER(BTRIM(account_email.email))
           AND inherited.scope IN ('host_onboarding','host_followups')
           AND NOT EXISTS (
             SELECT 1 FROM email_optins explicit_choice
              WHERE explicit_choice.email=inherited.email AND explicit_choice.scope='host_drafts'
                AND explicit_choice.consent_version='host_drafts_v1'
                AND explicit_choice.updated_at > inherited.updated_at
           )
      )
      ${eventOnly ? 'AND draft.id=$1 AND host.id=$2' : ''}
    ORDER BY draft.draft_host_activity_at,draft.id
    ${eventOnly ? 'LIMIT 1' : 'LIMIT $1'}`;
}

function activityTimestamp(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function createDraftReminderWorker({ db = pool, sendEmail = sendOptionalHostEmail, withAccount = withActiveHostAccount } = {}) {
  let running = false;

  async function pendingDraftReminders() {
    if (!draftRemindersEnabled()) return [];
    return (await db.query(eligibleDraftReminderSql(), [MAX_PER_PASS])).rows;
  }

  async function suppress(connection, eventId, error) {
    await connection.query(
      `UPDATE event_draft_reminders SET status='suppressed',error=$2,updated_at=NOW()
        WHERE event_id=$1 AND status IN ('pending','failed')`, [eventId, error]
    );
  }

  async function deliverDraftReminder(candidate) {
    if (!draftRemindersEnabled()) return false;
    try {
      const guarded = await withAccount(db, candidate.organizer_id, async client => {
        const connection = client || db;
        const { rows } = await connection.query(eligibleDraftReminderSql({ eventOnly: true }), [candidate.id, candidate.organizer_id]);
        const current = rows[0];
        if (!current || Number(current.organizer_id) !== Number(candidate.organizer_id)) return false;
        const recipient = String(current.email || '').trim().toLowerCase();
        if (!recipient || await emailOptedOut(connection, recipient, DRAFT_REMINDER_SCOPE)) return false;
        const activityAt = activityTimestamp(current.draft_host_activity_at);
        if (!activityAt) return false;
        const preferences = emailPreferenceUrls(recipient, DRAFT_REMINDER_SCOPE);
        const snapshot = {
          version: 1, eventId: Number(current.id), title: String(current.title || ''), activityAt,
          activityVersion: String(current.draft_activity_version || activityAt),
          email: buildDraftReminderEmail({ event: { id: current.id, title: current.title }, ...preferences }),
          unsubscribeUrl: preferences.unsubscribeUrl
        };
        await connection.query(
          `INSERT INTO event_draft_reminders (event_id,organizer_id,recipient,activity_at,render_snapshot)
           VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (event_id) DO NOTHING`,
          [current.id, current.organizer_id, recipient, snapshot.activityVersion, JSON.stringify(snapshot)]
        );
        const stored = (await connection.query(
          'SELECT * FROM event_draft_reminders WHERE event_id=$1 AND organizer_id=$2',
          [current.id, current.organizer_id]
        )).rows[0];
        const saved = stored?.render_snapshot;
        if (!stored || stored.recipient !== recipient || !saved?.email?.subject || !saved?.email?.html
            || !saved?.email?.text || !saved?.unsubscribeUrl
            || saved.version !== 1 || saved.eventId !== Number(current.id)
            || saved.title !== snapshot.title || saved.activityAt !== activityAt
            || saved.activityVersion !== snapshot.activityVersion) {
          if (stored) await suppress(connection, current.id, 'context_changed');
          return false;
        }

        // Persist the first attempt and host-wide cooldown atomically BEFORE
        // handing anything to the provider. Deleting a draft cannot erase them.
        const claimed = (await connection.query(
          `WITH claimed AS (
             UPDATE event_draft_reminders
                SET attempt_count=attempt_count+1,first_attempt_at=COALESCE(first_attempt_at,NOW()),
                    last_attempt_at=NOW(),updated_at=NOW(),status='pending'
              WHERE event_id=$1 AND organizer_id=$2 AND status IN ('pending','failed')
                AND attempt_count < $3
                AND (first_attempt_at IS NULL OR first_attempt_at >= NOW() - INTERVAL '23 hours')
                AND (last_attempt_at IS NULL OR last_attempt_at <= NOW() - INTERVAL '2 minutes')
              RETURNING event_id,first_attempt_at
           )
           UPDATE organizers host
              SET first_draft_reminder_attempt_at=COALESCE(host.first_draft_reminder_attempt_at,claimed.first_attempt_at),
                  last_draft_reminder_attempt_at=claimed.first_attempt_at
             FROM claimed WHERE host.id=$2 RETURNING claimed.event_id`,
          [current.id, current.organizer_id, DRAFT_REMINDER_MAX_ATTEMPTS]
        )).rows;
        if (!claimed.length) return false;

        // The durable attempt above is already committed. A separate short
        // transaction locks the event through the bounded provider handoff, so
        // publication, archive, deletion and host edits cannot pass this gate.
        // Rolling this transaction back must NEVER roll back the attempt claim.
        await connection.query('BEGIN');
        try {
          const live = (await connection.query(
            `SELECT event.id,event.title,event.draft_host_activity_at,
                    event.draft_host_activity_at::text AS draft_activity_version
               FROM events event WHERE event.id=$1 AND event.organizer_id=$2
                 AND ${eligibleDraftSql('event')}
                 AND EXISTS (
                   SELECT 1 FROM event_draft_reminders attempt
                    WHERE attempt.event_id=event.id AND attempt.status='pending'
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM events newer WHERE newer.organizer_id=event.organizer_id
                     AND ${eligibleDraftSql('newer')}
                     AND (newer.draft_host_activity_at,newer.id) > (event.draft_host_activity_at,event.id)
                 )
               FOR UPDATE OF event`,
            [current.id, current.organizer_id]
          )).rows[0];
          const address = (await connection.query(
            `SELECT identity.value AS email FROM organizers host
               JOIN user_identities identity ON identity.user_id=host.user_id
              WHERE host.id=$1 AND identity.identity_type='email' AND identity.verification_scope='account'
                AND identity.verified_at IS NOT NULL AND identity.revoked_at IS NULL
              ORDER BY identity.is_primary DESC,identity.id ASC LIMIT 1`, [current.organizer_id]
          )).rows[0]?.email;
          if (!live || String(live.title || '') !== saved.title
              || activityTimestamp(live.draft_host_activity_at) !== saved.activityAt
              || String(live.draft_activity_version || activityTimestamp(live.draft_host_activity_at)) !== saved.activityVersion
              || String(address || '').trim().toLowerCase() !== recipient
              || await emailOptedOut(connection, recipient, DRAFT_REMINDER_SCOPE)) {
            await suppress(connection, current.id, 'context_or_permission_changed');
            await connection.query('COMMIT');
            return false;
          }
          const result = await sendEmail({
            to: recipient, ...saved.email, unsubscribeUrl: saved.unsubscribeUrl,
            idempotencyKey: `sge-draft-reminder-v1-${current.id}`
          });
          await connection.query(
            `UPDATE event_draft_reminders SET status='sent',sent_at=NOW(),provider_id=$2,error=NULL,updated_at=NOW()
              WHERE event_id=$1`, [current.id, result?.id || null]
          );
          await connection.query('COMMIT');
          return true;
        } catch (error) {
          await connection.query('ROLLBACK');
          await connection.query(
            `UPDATE event_draft_reminders SET status='failed',error='delivery_failed',updated_at=NOW()
              WHERE event_id=$1 AND status='pending'`, [current.id]
          );
          throw error;
        }
      });
      return Boolean(guarded.allowed && guarded.result);
    } catch (error) {
      console.error('[draft-reminders] delivery failed', { eventId: candidate.id, error: 'delivery_failed' });
      return false;
    }
  }

  async function runDraftReminderPass() {
    if (running || !draftRemindersEnabled()) return 0;
    running = true;
    let sent = 0;
    try {
      // The same frozen provider key is safe only inside its retention window.
      // Unknown interrupted outcomes remain terminal outside that horizon.
      await db.query(
        `UPDATE event_draft_reminders SET status='failed',attempt_count=$1,
             error='delivery_outcome_unknown',updated_at=NOW()
          WHERE status IN ('pending','failed') AND attempt_count > 0 AND attempt_count < $1
            AND first_attempt_at < NOW() - INTERVAL '23 hours'`, [DRAFT_REMINDER_MAX_ATTEMPTS]
      );
      for (const candidate of await pendingDraftReminders()) {
        if (await deliverDraftReminder(candidate)) sent += 1;
      }
    } catch (error) {
      console.error('[draft-reminders] pass failed:', 'draft_reminder_pass_failed');
    } finally { running = false; }
    return sent;
  }

  return { pendingDraftReminders, deliverDraftReminder, runDraftReminderPass };
}

const worker = createDraftReminderWorker();

function startDraftReminderCron() {
  if (process.env.REMINDERS_ENABLED === 'false' || !draftRemindersEnabled()) return;
  cron.schedule('7 * * * *', () => worker.runDraftReminderPass());
  console.log('[draft-reminders] hourly cron scheduled');
}

module.exports = { ...worker, createDraftReminderWorker, eligibleDraftReminderSql, startDraftReminderCron, MAX_PER_PASS };
