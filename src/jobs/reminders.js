const cron = require('node-cron');
const pool = require('../config/db');
const { sendDayBeforeReminder, sendDayOfReminder } = require('../lib/mailer');
const { HOST_ACCOUNT_INACTIVE, withActiveHostAccount } = require('../lib/outbound-account-status');

let _running = false;

const SENDERS = {
  reminder_day_before: sendDayBeforeReminder,
  reminder_day_of: sendDayOfReminder
};

// Claim-then-send: the partial unique index on message_log makes double-sends
// impossible even across concurrent runs — only the run that wins the INSERT sends.
async function processReminders(messageType, targetHour, dayOffset) {
  const { rows: events } = await pool.query(
    `SELECT e.*, o.org_name, o.public_slug AS organizer_public_slug
       FROM events e
       JOIN organizers o ON o.id=e.organizer_id
      WHERE e.status='published'
        AND ((e.event_date + e.start_time) AT TIME ZONE e.timezone) > NOW()
        AND e.event_date = ((NOW() AT TIME ZONE e.timezone)::date + $1::int)
        AND EXTRACT(HOUR FROM (NOW() AT TIME ZONE e.timezone)) = $2`,
    [dayOffset, targetHour]
  );

  for (const event of events) {
    const { rows: rsvps } = await pool.query(
      `SELECT * FROM rsvps WHERE event_id=$1 AND status='confirmed' AND wants_reminders=TRUE`,
      [event.id]
    );
    for (const rsvp of rsvps) {
      const { rows: claimed } = await pool.query(
        `INSERT INTO message_log
           (rsvp_id, event_id, recipient, recipient_user_id, message_type, channel, status)
         VALUES ($1,$2,$3,$4,$5,'email','pending')
         ON CONFLICT (rsvp_id, message_type, channel)
           WHERE rsvp_id IS NOT NULL AND notification_batch_id IS NULL DO NOTHING
         RETURNING id`,
        [rsvp.id, event.id, rsvp.email, rsvp.user_id, messageType]
      );
      if (!claimed.length) continue;
      await deliver(claimed[0].id, messageType, event, rsvp);
    }
  }
}

async function deliver(logId, messageType, event, rsvp) {
  try {
    const deliveryResult = await withActiveHostAccount(
      pool,
      event.organizer_id,
      client => sendCurrentReminder(client, logId, messageType, event.organizer_id)
    );
    if (!deliveryResult.allowed) {
      await pool.query(
        `UPDATE message_log SET status='failed', error=$2 WHERE id=$1`,
        [logId, `cancelled: ${HOST_ACCOUNT_INACTIVE}`]
      );
      return;
    }
    if (deliveryResult.result?.suppressed) return;
    await pool.query(
      `UPDATE message_log SET status='sent', sent_at=NOW(), provider_id=$2, error=NULL WHERE id=$1`,
      [logId, deliveryResult.result?.id || null]
    );
  } catch (err) {
    console.error(`[reminders] ${messageType} to ${rsvp.email} failed:`, err.message);
    await pool.query(
      `UPDATE message_log SET status='failed', error=$2 WHERE id=$1`,
      [logId, String(err.message).slice(0, 500)]
    );
  }
}

// The candidate list can become stale while a previous email is being sent.
// Re-read consent, response, publication and the actual start immediately before
// every delivery, including retries. Legacy reminder consent remains sufficient.
async function sendCurrentReminder(client, logId, messageType, organizerId) {
  const { rows } = await client.query(
    `SELECT e.*, o.org_name, o.public_slug AS organizer_public_slug,
            r.id AS current_rsvp_id, r.email AS current_email,
            r.user_id AS current_user_id, r.manage_token AS current_manage_token,
            r.first_name AS current_first_name, r.last_name AS current_last_name
       FROM message_log ml
       JOIN rsvps r ON r.id=ml.rsvp_id AND r.event_id=ml.event_id
       JOIN events e ON e.id=ml.event_id
       JOIN organizers o ON o.id=e.organizer_id
      WHERE ml.id=$1 AND ml.message_type=$2 AND ml.status='pending'
        AND ml.channel='email' AND e.organizer_id=$3
        AND LOWER(TRIM(r.email))=LOWER(TRIM(ml.recipient))
        AND r.status='confirmed' AND r.wants_reminders=TRUE
        AND e.status='published'
        AND e.event_date = ((NOW() AT TIME ZONE e.timezone)::date + $4::int)
        AND ((e.event_date + e.start_time) AT TIME ZONE e.timezone) > NOW()`,
    [logId, messageType, organizerId, messageType === 'reminder_day_before' ? 1 : 0]
  );
  if (!rows.length) {
    await client.query(
      `UPDATE message_log SET status='failed', error='cancelled: reminder no longer eligible' WHERE id=$1 AND status='pending'`,
      [logId]
    );
    return { suppressed: true };
  }
  const event = rows[0];
  const rsvp = {
    id: event.current_rsvp_id,
    email: event.current_email,
    user_id: event.current_user_id,
    manage_token: event.current_manage_token,
    first_name: event.current_first_name,
    last_name: event.current_last_name,
    wants_reminders: true
  };
  await client.query(
    `UPDATE message_log SET recipient=$2, recipient_user_id=$3 WHERE id=$1`,
    [logId, rsvp.email, rsvp.user_id]
  );
  return SENDERS[messageType]({ to: rsvp.email, event, rsvp, idempotencyKey: `reminder:${messageType}:${logId}` });
}

// One retry per failed reminder within 20h; after that the error is prefixed
// 'retried:' and the row is never picked up again.
async function retryFailed() {
  const { rows } = await pool.query(
    `SELECT ml.id AS log_id, ml.message_type, e.*, r.id AS rsvp_id2, r.email AS rsvp_email,
            r.manage_token, r.first_name, r.last_name,
            o.org_name, o.public_slug AS organizer_public_slug
       FROM message_log ml
       JOIN rsvps r  ON r.id = ml.rsvp_id
       JOIN events e ON e.id = ml.event_id
       JOIN organizers o ON o.id = e.organizer_id
      WHERE ml.status='failed'
        AND ml.message_type IN ('reminder_day_before','reminder_day_of')
        AND ml.created_at > NOW() - INTERVAL '20 hours'
        AND (ml.error IS NULL OR (ml.error NOT LIKE 'retried:%' AND ml.error NOT LIKE 'cancelled:%'))`
  );
  for (const row of rows) {
    // Claim atomically before contacting the provider. Another worker that read
    // the same failed row cannot send it again. An interrupted/unknown retry is
    // intentionally not blindly resent.
    const { rows: claimed } = await pool.query(
      `UPDATE message_log
          SET status='pending', error='retried: delivery pending',
              attempt_count=attempt_count+1, last_attempt_at=NOW()
        WHERE id=$1 AND status='failed'
          AND created_at > NOW() - INTERVAL '20 hours'
          AND (error IS NULL OR (error NOT LIKE 'retried:%' AND error NOT LIKE 'cancelled:%'))
        RETURNING id`,
      [row.log_id]
    );
    if (!claimed.length) continue;
    const event = row;
    try {
      const deliveryResult = await withActiveHostAccount(
        pool,
        event.organizer_id,
        client => sendCurrentReminder(client, row.log_id, row.message_type, event.organizer_id)
      );
      if (!deliveryResult.allowed) {
        await pool.query(
          `UPDATE message_log SET status='failed', error=$2 WHERE id=$1`,
          [row.log_id, `cancelled: ${HOST_ACCOUNT_INACTIVE}`]
        );
        continue;
      }
      if (deliveryResult.result?.suppressed) continue;
      await pool.query(
        `UPDATE message_log SET status='sent', sent_at=NOW(), provider_id=$2, error=NULL WHERE id=$1`,
        [row.log_id, deliveryResult.result?.id || null]
      );
    } catch (err) {
      await pool.query(
        `UPDATE message_log SET status='failed', error=$2 WHERE id=$1`,
        [row.log_id, 'retried: ' + String(err.message).slice(0, 490)]
      );
    }
  }
}

// Hours are injectable so a test run can match the current wall clock.
async function runReminderPass({ dayBeforeHour = 16, dayOfHour = 9 } = {}) {
  if (_running) return;
  _running = true;
  try {
    await retryFailed();
    await processReminders('reminder_day_before', dayBeforeHour, 1);
    await processReminders('reminder_day_of', dayOfHour, 0);
  } catch (err) {
    console.error('[reminders] pass failed:', err.message);
  } finally {
    _running = false;
  }
}

function startReminderCron() {
  if (process.env.REMINDERS_ENABLED === 'false') {
    console.log('[reminders] disabled via REMINDERS_ENABLED=false');
    return;
  }
  cron.schedule('0 * * * *', () => runReminderPass());
  console.log('[reminders] hourly cron scheduled (day-before 4pm, day-of 9am, event-local)');
}

module.exports = { startReminderCron, runReminderPass };
