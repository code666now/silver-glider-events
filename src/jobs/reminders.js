const cron = require('node-cron');
const pool = require('../config/db');
const { sendDayBeforeReminder, sendDayOfReminder } = require('../lib/mailer');

let _running = false;

const SENDERS = {
  reminder_day_before: sendDayBeforeReminder,
  reminder_day_of: sendDayOfReminder
};

// Claim-then-send: the partial unique index on message_log makes double-sends
// impossible even across concurrent runs — only the run that wins the INSERT sends.
async function processReminders(messageType, targetHour, dayOffset) {
  const { rows: events } = await pool.query(
    `SELECT * FROM events
      WHERE status='published'
        AND event_date = ((NOW() AT TIME ZONE timezone)::date + $1::int)
        AND EXTRACT(HOUR FROM (NOW() AT TIME ZONE timezone)) = $2`,
    [dayOffset, targetHour]
  );

  for (const event of events) {
    const { rows: rsvps } = await pool.query(
      `SELECT * FROM rsvps WHERE event_id=$1 AND status='confirmed' AND wants_reminders=TRUE`,
      [event.id]
    );
    for (const rsvp of rsvps) {
      const { rows: claimed } = await pool.query(
        `INSERT INTO message_log (rsvp_id, event_id, recipient, message_type, channel, status)
         VALUES ($1,$2,$3,$4,'email','pending')
         ON CONFLICT (rsvp_id, message_type, channel) WHERE rsvp_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [rsvp.id, event.id, rsvp.email, messageType]
      );
      if (!claimed.length) continue;
      await deliver(claimed[0].id, messageType, event, rsvp);
    }
  }
}

async function deliver(logId, messageType, event, rsvp) {
  try {
    const result = await SENDERS[messageType]({ to: rsvp.email, event, rsvp });
    await pool.query(
      `UPDATE message_log SET status='sent', sent_at=NOW(), provider_id=$2, error=NULL WHERE id=$1`,
      [logId, result?.id || null]
    );
  } catch (err) {
    console.error(`[reminders] ${messageType} to ${rsvp.email} failed:`, err.message);
    await pool.query(
      `UPDATE message_log SET status='failed', error=$2 WHERE id=$1`,
      [logId, String(err.message).slice(0, 500)]
    );
  }
}

// One retry per failed reminder within 20h; after that the error is prefixed
// 'retried:' and the row is never picked up again.
async function retryFailed() {
  const { rows } = await pool.query(
    `SELECT ml.id AS log_id, ml.message_type, e.*, r.id AS rsvp_id2, r.email AS rsvp_email,
            r.manage_token, r.first_name, r.last_name
       FROM message_log ml
       JOIN rsvps r  ON r.id = ml.rsvp_id
       JOIN events e ON e.id = ml.event_id
      WHERE ml.status='failed'
        AND ml.message_type IN ('reminder_day_before','reminder_day_of')
        AND ml.created_at > NOW() - INTERVAL '20 hours'
        AND (ml.error IS NULL OR ml.error NOT LIKE 'retried:%')`
  );
  for (const row of rows) {
    const event = row;
    const rsvp = { id: row.rsvp_id2, email: row.rsvp_email, manage_token: row.manage_token };
    try {
      const result = await SENDERS[row.message_type]({ to: rsvp.email, event, rsvp });
      await pool.query(
        `UPDATE message_log SET status='sent', sent_at=NOW(), provider_id=$2, error=NULL WHERE id=$1`,
        [row.log_id, result?.id || null]
      );
    } catch (err) {
      await pool.query(
        `UPDATE message_log SET error=$2 WHERE id=$1`,
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
