const cron = require('node-cron');
const pool = require('../config/db');
const { buildIcs } = require('../lib/calendar');
const { sendEventUpdate, sendEventCancellation } = require('../lib/mailer');

const MAX_ATTEMPTS = 3;
let running = false;

const SENDERS = {
  event_updated: ({ recipient, event, rsvp, changes, icsContent }) => sendEventUpdate({
    to: recipient, event, rsvp, changes, icsContent
  }),
  event_cancelled: ({ recipient, event, rsvp, icsContent }) => sendEventCancellation({
    to: recipient, event, rsvp, icsContent
  })
};

async function finalizeBatch(batchId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status='sent')::int AS sent,
            COUNT(*) FILTER (WHERE status='failed')::int AS failed,
            COUNT(*) FILTER (WHERE status <> 'sent' AND attempt_count < $2)::int AS retryable
       FROM message_log WHERE notification_batch_id=$1`,
    [batchId, MAX_ATTEMPTS]
  );
  const counts = rows[0];
  const complete = counts.retryable === 0;
  const status = counts.total === 0 || counts.sent === counts.total
    ? 'sent'
    : complete
      ? (counts.sent > 0 ? 'partial_failed' : 'failed')
      : (counts.sent > 0 ? 'partial_failed' : 'pending');
  await pool.query(
    `UPDATE event_notification_batches
        SET status=$2, sent_count=$3, failed_count=$4,
            completed_at=CASE WHEN $5 THEN NOW() ELSE NULL END
      WHERE id=$1`,
    [batchId, status, counts.sent, counts.failed, complete]
  );
  return { ...counts, status };
}

async function processEventNotificationBatch(batchId) {
  const { rows: batchRows } = await pool.query(
    `SELECT b.id AS notification_batch_id, b.kind, b.changes,
            e.*, o.org_name, o.public_slug AS organizer_public_slug
       FROM event_notification_batches b
       JOIN events e ON e.id=b.event_id
       JOIN organizers o ON o.id=e.organizer_id
      WHERE b.id=$1 AND b.status IN ('pending','processing','partial_failed')`,
    [batchId]
  );
  if (!batchRows.length) return null;
  const event = batchRows[0];
  const messageType = event.kind;
  const sender = SENDERS[messageType];
  if (!sender) return null;

  await pool.query(
    `UPDATE event_notification_batches SET status='processing' WHERE id=$1`,
    [batchId]
  );
  const icsContent = buildIcs(event);
  const { rows: deliveries } = await pool.query(
    `SELECT ml.id AS log_id, ml.recipient, r.id AS rsvp_id2, r.manage_token,
            r.first_name, r.last_name, r.wants_reminders
       FROM message_log ml
       JOIN rsvps r ON r.id=ml.rsvp_id
      WHERE ml.notification_batch_id=$1
        AND ml.status <> 'sent'
        AND ml.attempt_count < $2
        AND (ml.last_attempt_at IS NULL OR ml.last_attempt_at < NOW() - INTERVAL '2 minutes')
      ORDER BY ml.id`,
    [batchId, MAX_ATTEMPTS]
  );

  for (const delivery of deliveries) {
    const { rows: claimed } = await pool.query(
      `UPDATE message_log
          SET status='pending', attempt_count=attempt_count+1, last_attempt_at=NOW()
        WHERE id=$1 AND status <> 'sent' AND attempt_count < $2
          AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - INTERVAL '2 minutes')
        RETURNING id`,
      [delivery.log_id, MAX_ATTEMPTS]
    );
    if (!claimed.length) continue;
    try {
      const result = await sender({
        recipient: delivery.recipient,
        event,
        rsvp: {
          id: delivery.rsvp_id2,
          manage_token: delivery.manage_token,
          first_name: delivery.first_name,
          last_name: delivery.last_name,
          wants_reminders: delivery.wants_reminders
        },
        changes: Array.isArray(event.changes) ? event.changes : [],
        icsContent
      });
      await pool.query(
        `UPDATE message_log SET status='sent', sent_at=NOW(), provider_id=$2, error=NULL WHERE id=$1`,
        [delivery.log_id, result?.id || null]
      );
    } catch (error) {
      console.error(`[event-notifications] ${messageType} to ${delivery.recipient} failed:`, error.message);
      await pool.query(
        `UPDATE message_log SET status='failed', error=$2 WHERE id=$1`,
        [delivery.log_id, String(error.message).slice(0, 500)]
      );
    }
  }
  return finalizeBatch(batchId);
}

function queueEventNotificationBatch(batchId) {
  if (!batchId) return;
  setImmediate(() => {
    processEventNotificationBatch(batchId).catch(error => {
      console.error(`[event-notifications] batch ${batchId} failed:`, error.message);
    });
  });
}

async function runEventNotificationPass() {
  if (running) return;
  running = true;
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT b.id
         FROM event_notification_batches b
         JOIN message_log ml ON ml.notification_batch_id=b.id
        WHERE b.status IN ('pending','processing','partial_failed')
          AND ml.status <> 'sent'
          AND ml.attempt_count < $1
          AND (ml.last_attempt_at IS NULL OR ml.last_attempt_at < NOW() - INTERVAL '2 minutes')
        ORDER BY b.id LIMIT 25`,
      [MAX_ATTEMPTS]
    );
    for (const row of rows) await processEventNotificationBatch(row.id);
  } catch (error) {
    console.error('[event-notifications] retry pass failed:', error.message);
  } finally {
    running = false;
  }
}

function startEventNotificationCron() {
  cron.schedule('* * * * *', () => runEventNotificationPass());
  const initial = setTimeout(() => runEventNotificationPass(), 1500);
  initial.unref?.();
  console.log('[event-notifications] minute retry cron scheduled');
}

module.exports = {
  MAX_ATTEMPTS,
  processEventNotificationBatch,
  queueEventNotificationBatch,
  runEventNotificationPass,
  startEventNotificationCron
};
