const cron = require('node-cron');
const pool = require('../config/db');
const { sendPreviousGuestInvitation } = require('../lib/mailer');
const { signOptout } = require('../lib/followers');

const MAX_ATTEMPTS = 3;
let running = false;

async function finalizeBatch(batchId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status='sent')::int AS sent,
            COUNT(*) FILTER (WHERE status='failed')::int AS failed,
            COUNT(*) FILTER (WHERE status <> 'sent' AND attempt_count < $2)::int AS retryable
       FROM message_log WHERE previous_guest_invitation_batch_id=$1`,
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
    `UPDATE previous_guest_invitation_batches
        SET status=$2, sent_count=$3, failed_count=$4,
            completed_at=CASE WHEN $5 THEN NOW() ELSE NULL END
      WHERE id=$1`,
    [batchId, status, counts.sent, counts.failed, complete]
  );
  return { ...counts, status };
}

async function processPreviousGuestInvitationBatch(batchId) {
  const { rows: batchRows } = await pool.query(
    `SELECT b.id AS invitation_batch_id, e.*, o.id AS host_id,
            COALESCE(o.org_name, o.name, 'Silver Glider Events') AS organizer_label
       FROM previous_guest_invitation_batches b
       JOIN events e ON e.id=b.target_event_id
       JOIN organizers o ON o.id=e.organizer_id
      WHERE b.id=$1 AND b.status IN ('pending','processing','partial_failed')`,
    [batchId]
  );
  if (!batchRows.length) return null;
  const event = batchRows[0];

  await pool.query(
    `UPDATE previous_guest_invitation_batches SET status='processing' WHERE id=$1`,
    [batchId]
  );
  const { rows: deliveries } = await pool.query(
    `SELECT id AS log_id, recipient, recipient_name
       FROM message_log
      WHERE previous_guest_invitation_batch_id=$1
        AND status <> 'sent'
        AND attempt_count < $2
        AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - INTERVAL '2 minutes')
      ORDER BY id`,
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
      const baseUrl = String(process.env.APP_URL || 'https://silvergliderevents.com').replace(/\/$/, '');
      const unsubscribeUrl = `${baseUrl}/unsubscribe?token=${signOptout(event.host_id, delivery.recipient)}`;
      const result = await sendPreviousGuestInvitation({
        to: delivery.recipient,
        recipientName: delivery.recipient_name,
        event,
        organizerLabel: event.organizer_label,
        unsubscribeUrl
      });
      await pool.query(
        `UPDATE message_log SET status='sent', sent_at=NOW(), provider_id=$2, error=NULL WHERE id=$1`,
        [delivery.log_id, result?.id || null]
      );
    } catch (error) {
      console.error(`[previous-guest-invitations] invite to ${delivery.recipient} failed:`, error.message);
      await pool.query(
        `UPDATE message_log SET status='failed', error=$2 WHERE id=$1`,
        [delivery.log_id, String(error.message).slice(0, 500)]
      );
    }
  }
  return finalizeBatch(batchId);
}

function queuePreviousGuestInvitationBatch(batchId) {
  if (!batchId) return;
  setImmediate(() => {
    processPreviousGuestInvitationBatch(batchId).catch(error => {
      console.error(`[previous-guest-invitations] batch ${batchId} failed:`, error.message);
    });
  });
}

async function runPreviousGuestInvitationPass() {
  if (running) return;
  running = true;
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT b.id
         FROM previous_guest_invitation_batches b
         JOIN message_log ml ON ml.previous_guest_invitation_batch_id=b.id
        WHERE b.status IN ('pending','processing','partial_failed')
          AND ml.status <> 'sent'
          AND ml.attempt_count < $1
          AND (ml.last_attempt_at IS NULL OR ml.last_attempt_at < NOW() - INTERVAL '2 minutes')
        ORDER BY b.id LIMIT 25`,
      [MAX_ATTEMPTS]
    );
    for (const row of rows) await processPreviousGuestInvitationBatch(row.id);
  } catch (error) {
    console.error('[previous-guest-invitations] retry pass failed:', error.message);
  } finally {
    running = false;
  }
}

function startPreviousGuestInvitationCron() {
  cron.schedule('* * * * *', () => runPreviousGuestInvitationPass());
  const initial = setTimeout(() => runPreviousGuestInvitationPass(), 1800);
  initial.unref?.();
  console.log('[previous-guest-invitations] minute retry cron scheduled');
}

module.exports = {
  MAX_ATTEMPTS,
  processPreviousGuestInvitationBatch,
  queuePreviousGuestInvitationBatch,
  runPreviousGuestInvitationPass,
  startPreviousGuestInvitationCron
};
