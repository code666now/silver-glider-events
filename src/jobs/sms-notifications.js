const cron = require('node-cron');
const pool = require('../config/db');
const sms = require('../lib/sms');
const { refundSendCredits } = require('../lib/sms-credit-ledger');

const MAX_ATTEMPTS = 3;
const ACCEPTED_STATUSES = ['accepted', 'queued', 'sending', 'sent', 'delivered'];
let running = false;

function callbackUrl(token) {
  const baseUrl = String(process.env.APP_URL || 'https://silvergliderevents.com').replace(/\/$/, '');
  return `${baseUrl}/api/webhooks/twilio/status/${token}`;
}

async function finalizeSmsBatch(batchId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batch = (await client.query(
      'SELECT * FROM sms_notification_batches WHERE id=$1 FOR UPDATE', [batchId]
    )).rows[0];
    if (!batch) {
      await client.query('ROLLBACK');
      return null;
    }
    const counts = (await client.query(
      `SELECT COUNT(*) FILTER (WHERE status=ANY($2::text[]))::int AS accepted,
              COUNT(*) FILTER (WHERE status='delivered')::int AS delivered,
              COUNT(*) FILTER (WHERE status IN ('undelivered','failed') AND
                (provider_message_sid IS NOT NULL OR attempt_count >= $3))::int AS failed,
              COUNT(*) FILTER (WHERE status IN ('pending','processing') OR
                (status='failed' AND provider_message_sid IS NULL AND attempt_count < $3))::int AS outstanding,
              COALESCE(SUM(segment_count) FILTER (WHERE status='failed' AND
                provider_message_sid IS NULL AND attempt_count >= $3),0)::int AS refundable
         FROM sms_notification_recipients WHERE batch_id=$1`,
      [batchId, ACCEPTED_STATUSES, MAX_ATTEMPTS]
    )).rows[0];
    const complete = Number(counts.outstanding) === 0;
    const accepted = Number(counts.accepted);
    const failed = Number(counts.failed);
    const status = !complete ? (accepted ? 'partial_failed' : 'processing')
      : failed === 0 ? 'sent'
        : accepted > 0 ? 'partial_failed' : 'failed';
    const refundable = complete
      ? Math.max(0, Number(counts.refundable) - Number(batch.refunded_credits))
      : 0;
    if (refundable > 0) {
      await refundSendCredits(client, {
        organizerId: batch.organizer_id,
        batchId,
        credits: refundable,
        metadata: { eventId: batch.event_id, reason: 'provider_not_accepted' }
      });
    }
    await client.query(
      `UPDATE sms_notification_batches
          SET status=$2,accepted_count=$3,delivered_count=$4,failed_count=$5,
              refunded_credits=refunded_credits+$6,
              completed_at=CASE WHEN $7 THEN COALESCE(completed_at,NOW()) ELSE NULL END
        WHERE id=$1`,
      [batchId, status, accepted, Number(counts.delivered), failed, refundable, complete]
    );
    await client.query('COMMIT');
    return { status, accepted, delivered: Number(counts.delivered), failed, complete, refundable };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function processSmsBatch(batchId) {
  const batch = (await pool.query(
    `SELECT b.* FROM sms_notification_batches b
      WHERE b.id=$1 AND b.status IN ('pending','processing','partial_failed')`,
    [batchId]
  )).rows[0];
  if (!batch) return null;
  await pool.query("UPDATE sms_notification_batches SET status='processing' WHERE id=$1", [batchId]);
  const { rows: deliveries } = await pool.query(
    `SELECT sr.id, sr.rsvp_id, sr.recipient, sr.status_token
       FROM sms_notification_recipients sr
      WHERE sr.batch_id=$1 AND sr.provider_message_sid IS NULL
        AND sr.status IN ('pending','failed') AND sr.attempt_count < $2
        AND (sr.last_attempt_at IS NULL OR sr.last_attempt_at < NOW() - INTERVAL '2 minutes')
      ORDER BY sr.id`,
    [batchId, MAX_ATTEMPTS]
  );
  for (const delivery of deliveries) {
    const claimed = (await pool.query(
      `UPDATE sms_notification_recipients
          SET status='processing',attempt_count=attempt_count+1,last_attempt_at=NOW(),updated_at=NOW()
        WHERE id=$1 AND provider_message_sid IS NULL AND status IN ('pending','failed')
          AND attempt_count < $2
          AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - INTERVAL '2 minutes')
        RETURNING attempt_count`,
      [delivery.id, MAX_ATTEMPTS]
    )).rows[0];
    if (!claimed) continue;
    const eligible = (await pool.query(
      `SELECT 1 FROM rsvps WHERE id=$1 AND status='confirmed' AND sms_optin=TRUE
        AND sms_consent_at IS NOT NULL AND sms_opted_out_at IS NULL AND phone=$2`,
      [delivery.rsvp_id, delivery.recipient]
    )).rows.length > 0;
    if (!eligible) {
      await pool.query(
        `UPDATE sms_notification_recipients
            SET status='failed',attempt_count=$2,provider_error_code='consent_revoked',
                failed_at=NOW(),updated_at=NOW()
          WHERE id=$1`,
        [delivery.id, MAX_ATTEMPTS]
      );
      continue;
    }
    try {
      const result = await sms.sendSms({
        to: delivery.recipient,
        body: batch.message_body,
        statusCallback: callbackUrl(delivery.status_token)
      });
      const providerStatus = ACCEPTED_STATUSES.includes(result.status) ? result.status : 'accepted';
      await pool.query(
        `UPDATE sms_notification_recipients
            SET status=CASE WHEN provider_message_sid IS NOT NULL THEN status ELSE $2 END,
                provider_status=CASE WHEN provider_message_sid IS NOT NULL THEN provider_status ELSE $3 END,
                provider_message_sid=COALESCE(provider_message_sid,$4),
                accepted_at=COALESCE(accepted_at,NOW()),updated_at=NOW(),
                provider_error_code=CASE WHEN provider_message_sid IS NOT NULL THEN provider_error_code ELSE NULL END
          WHERE id=$1 AND (provider_message_sid IS NULL OR provider_message_sid=$4)`,
        [delivery.id, providerStatus, result.status, result.sid]
      );
    } catch (error) {
      const permanent = error.code === 'sms_rejected';
      if (Number(error.providerCode) === 21610) {
        await pool.query(
          `UPDATE rsvps SET sms_optin=FALSE,sms_opted_out_at=COALESCE(sms_opted_out_at,NOW())
            WHERE phone=$1`,
          [delivery.recipient]
        );
      }
      await pool.query(
        `UPDATE sms_notification_recipients
            SET status='failed',attempt_count=CASE WHEN $2 THEN $3 ELSE attempt_count END,
                provider_error_code=$4,failed_at=CASE WHEN $2 THEN NOW() ELSE failed_at END,updated_at=NOW()
          WHERE id=$1`,
        [delivery.id, permanent, MAX_ATTEMPTS, String(error.providerCode || error.code || 'sms_error').slice(0, 80)]
      );
      console.error(`[sms-notifications] recipient ${delivery.id} failed:`, error.code || 'sms_error');
    }
  }
  return finalizeSmsBatch(batchId);
}

function queueSmsBatch(batchId) {
  if (!batchId) return;
  setImmediate(() => processSmsBatch(batchId).catch(error => {
    console.error(`[sms-notifications] batch ${batchId} failed:`, error.message);
  }));
}

async function runSmsPass() {
  if (running) return;
  running = true;
  try {
    const { rows } = await pool.query(
      `SELECT id FROM sms_notification_batches
        WHERE status IN ('pending','processing','partial_failed')
        ORDER BY id LIMIT 25`
    );
    for (const row of rows) await processSmsBatch(row.id);
  } catch (error) {
    console.error('[sms-notifications] retry pass failed:', error.message);
  } finally {
    running = false;
  }
}

function startSmsNotificationCron() {
  cron.schedule('* * * * *', () => runSmsPass());
  const initial = setTimeout(() => runSmsPass(), 2200);
  initial.unref?.();
  console.log('[sms-notifications] minute retry cron scheduled');
}

module.exports = {
  MAX_ATTEMPTS,
  finalizeSmsBatch,
  processSmsBatch,
  queueSmsBatch,
  runSmsPass,
  startSmsNotificationCron
};
