const cron = require('node-cron');
const pool = require('../config/db');
const { sendPostEventThankYou } = require('../lib/mailer');
const { eligibleThankYouAudience } = require('../lib/post-event');
const { signOptout } = require('../lib/followers');
const { HOST_ACCOUNT_INACTIVE, withActiveHostAccount } = require('../lib/outbound-account-status');

const MAX_ATTEMPTS = 3;
const SUPPRESSED_ERROR = 'recipient_suppressed';
const UNKNOWN_DELIVERY_ERROR = 'delivery_outcome_unknown';
let running = false;
const backgroundBatches = new Set();

async function finalizeBatch(batchId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status='sent')::int AS sent,
            COUNT(*) FILTER (
              WHERE status <> 'sent' AND COALESCE(error,'') <> $3 AND attempt_count >= $2
            )::int AS failed,
            COUNT(*) FILTER (WHERE error=$3)::int AS suppressed,
            COUNT(*) FILTER (
              WHERE status <> 'sent' AND COALESCE(error,'') <> $3 AND attempt_count < $2
            )::int AS retryable
       FROM message_log WHERE post_event_thank_you_batch_id=$1`,
    [batchId, MAX_ATTEMPTS, SUPPRESSED_ERROR]
  );
  const counts = rows[0];
  const complete = counts.retryable === 0;
  const status = !complete
    ? (counts.sent > 0 ? 'partial_failed' : 'pending')
    : counts.failed > 0
      ? (counts.sent > 0 ? 'partial_failed' : 'failed')
      : 'sent';
  await pool.query(
    `UPDATE post_event_thank_you_batches
        SET status=$2,sent_count=$3,failed_count=$4,
            completed_at=CASE WHEN $5 THEN NOW() ELSE NULL END,updated_at=NOW()
      WHERE id=$1`,
    [batchId, status, counts.sent, counts.failed, complete]
  );
  return { ...counts, status };
}

async function markSuppressed(logId) {
  await pool.query(
    `WITH skipped AS (
       UPDATE message_log
          SET status='failed',attempt_count=$2,last_attempt_at=NOW(),error=$3
        WHERE id=$1 AND status <> 'sent' AND error IS DISTINCT FROM $3
        RETURNING post_event_thank_you_batch_id
     )
     UPDATE post_event_thank_you_batches batch
        SET skipped_count=batch.skipped_count+1,updated_at=NOW()
       FROM skipped
      WHERE batch.id=skipped.post_event_thank_you_batch_id`,
    [logId, MAX_ATTEMPTS, SUPPRESSED_ERROR]
  );
}

async function expireAmbiguousDeliveries(batchId) {
  // Resend uses the same provider idempotency key, but that protection is only
  // guaranteed for 24 hours. If a worker died after handing a message to the
  // provider, its outcome is unknowable; once the safe retry window is nearly
  // over, fail closed instead of risking a duplicate email.
  await pool.query(
    `UPDATE message_log
        SET status='failed',attempt_count=$2,error=$3
      WHERE post_event_thank_you_batch_id=$1
        AND status <> 'sent'
        AND attempt_count > 0
        AND provider_id IS NULL
        AND created_at < NOW() - INTERVAL '23 hours'
        AND COALESCE(error,'') NOT IN ($3,$4)`,
    [batchId, MAX_ATTEMPTS, UNKNOWN_DELIVERY_ERROR, SUPPRESSED_ERROR]
  );
}

async function processPostEventThankYouBatch(batchId) {
  const { rows: batchRows } = await pool.query(
    `SELECT batch.id AS thank_you_batch_id,batch.subject AS thank_you_subject,
            batch.message AS thank_you_message,batch.include_follow,batch.render_snapshot,
            e.*,o.id AS host_id,o.user_id AS host_user_id,o.email AS host_email,
            o.name AS host_name,o.org_name AS host_org_name,
            o.public_slug AS host_public_slug,o.logo_url AS host_logo_url
       FROM post_event_thank_you_batches batch
       JOIN events e ON e.id=batch.event_id
       JOIN organizers o ON o.id=batch.organizer_id AND o.id=e.organizer_id
      WHERE batch.id=$1
        AND batch.status IN ('pending','processing','partial_failed')
        AND (batch.status <> 'partial_failed' OR batch.completed_at IS NULL)`,
    [batchId]
  );
  if (!batchRows.length) return null;
  const row = batchRows[0];
  await pool.query(
    `UPDATE post_event_thank_you_batches SET status='processing',updated_at=NOW() WHERE id=$1`,
    [batchId]
  );

  await expireAmbiguousDeliveries(batchId);

  const { rows: deliveries } = await pool.query(
    `SELECT id AS log_id,rsvp_id,recipient,recipient_name,recipient_user_id,
            post_event_already_following,post_event_consent_scope
       FROM message_log
      WHERE post_event_thank_you_batch_id=$1
        AND status <> 'sent'
        AND COALESCE(error,'') <> $3
        AND attempt_count < $2
        AND (attempt_count=0 OR created_at >= NOW() - INTERVAL '23 hours')
        AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - INTERVAL '2 minutes')
      ORDER BY id`,
    [batchId, MAX_ATTEMPTS, SUPPRESSED_ERROR]
  );

  const snapshot = row.render_snapshot;
  if (!snapshot?.event || !snapshot?.host) {
    await pool.query(
      `UPDATE message_log
          SET status='failed',attempt_count=$2,error='missing_render_snapshot'
        WHERE post_event_thank_you_batch_id=$1 AND status <> 'sent'`,
      [batchId, MAX_ATTEMPTS]
    );
    return finalizeBatch(batchId);
  }
  const event = snapshot.event;
  const host = snapshot.host;

  for (const delivery of deliveries) {
    const { rows: claimed } = await pool.query(
      `UPDATE message_log
          SET status='pending',attempt_count=attempt_count+1,last_attempt_at=NOW()
        WHERE id=$1 AND status <> 'sent' AND attempt_count < $2
          AND COALESCE(error,'') <> $3
          AND (attempt_count=0 OR created_at >= NOW() - INTERVAL '23 hours')
          AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - INTERVAL '2 minutes')
        RETURNING id`,
      [delivery.log_id, MAX_ATTEMPTS, SUPPRESSED_ERROR]
    );
    if (!claimed.length) continue;
    try {
      const baseUrl = String(process.env.APP_URL || 'https://silvergliderevents.com').replace(/\/$/, '');
      const unsubscribeUrl = `${baseUrl}/unsubscribe?token=${signOptout(row.organizer_id, delivery.recipient)}`;
      const deliveryResult = await withActiveHostAccount(pool, row.organizer_id, async lockedClient => {
        // Recheck recipient eligibility only after the host-account gate is
        // locked, immediately before delivery, so opt-outs accepted while this
        // job waited are observed. Unsubscribe writes use their existing route.
        const currentAudience = await eligibleThankYouAudience(lockedClient || pool, {
          eventId: row.id,
          organizerId: row.organizer_id,
          rsvpId: Number(delivery.rsvp_id)
        });
        const nowEligible = currentAudience.recipients[0];
        const consentScope = delivery.post_event_consent_scope || 'host';
        if (!nowEligible || nowEligible.email !== String(delivery.recipient || '').trim().toLowerCase()
            || (consentScope === 'host' && nowEligible.consentScope !== 'host')
            || (consentScope === 'event' && nowEligible.consentScope === 'event_rsvp')
            || !['host', 'event', 'event_rsvp'].includes(consentScope)) {
          return { recipientSuppressed: true };
        }
        return {
          recipientSuppressed: false,
          providerResult: await sendPostEventThankYou({
            to: delivery.recipient,
            event,
            host,
            subject: row.thank_you_subject,
            message: row.thank_you_message,
            includeFollow: Boolean(row.include_follow),
            alreadyFollowing: Boolean(delivery.post_event_already_following),
            templateVersion: snapshot.thankYouVersion || 1,
            consentScope,
            unsubscribeUrl,
            idempotencyKey: `post-event-thank-you:${batchId}:${delivery.log_id}`
          })
        };
      });
      if (!deliveryResult.allowed) {
        await pool.query(
          `UPDATE message_log SET status='failed',attempt_count=$2,error=$3 WHERE id=$1`,
          [delivery.log_id, MAX_ATTEMPTS, HOST_ACCOUNT_INACTIVE]
        );
        continue;
      }
      if (deliveryResult.result?.recipientSuppressed) {
        await markSuppressed(delivery.log_id);
        continue;
      }
      await pool.query(
        `UPDATE message_log
            SET status='sent',sent_at=NOW(),provider_id=$2,error=NULL
          WHERE id=$1`,
        [delivery.log_id, deliveryResult.result?.providerResult?.id || null]
      );
    } catch (error) {
      console.error(`[post-event-thank-yous] delivery ${delivery.log_id} failed:`, error.message);
      await pool.query(
        `UPDATE message_log SET status='failed',error=$2 WHERE id=$1`,
        [delivery.log_id, String(error.message).slice(0, 500)]
      );
    }
  }
  return finalizeBatch(batchId);
}

function queuePostEventThankYouBatch(batchId) {
  if (!batchId) return;
  const work = new Promise(resolve => setImmediate(resolve))
    .then(() => processPostEventThankYouBatch(batchId))
    .catch(error => {
      console.error(`[post-event-thank-yous] batch ${batchId} failed:`, error.message);
    });
  backgroundBatches.add(work);
  work.then(
    () => backgroundBatches.delete(work),
    () => backgroundBatches.delete(work)
  );
}

async function settlePostEventThankYouWork() {
  while (backgroundBatches.size) {
    await Promise.allSettled([...backgroundBatches]);
  }
}

async function runPostEventThankYouPass() {
  if (running) return;
  running = true;
  try {
    const { rows } = await pool.query(
      `SELECT batch.id
         FROM post_event_thank_you_batches batch
        WHERE batch.status IN ('pending','processing')
           OR (batch.status='partial_failed' AND batch.completed_at IS NULL)
        ORDER BY batch.id LIMIT 25`,
      []
    );
    for (const row of rows) await processPostEventThankYouBatch(row.id);
  } catch (error) {
    console.error('[post-event-thank-yous] retry pass failed:', error.message);
  } finally {
    running = false;
  }
}

function startPostEventThankYouCron() {
  cron.schedule('* * * * *', () => runPostEventThankYouPass());
  const initial = setTimeout(() => runPostEventThankYouPass(), 2100);
  initial.unref?.();
  console.log('[post-event-thank-yous] minute retry cron scheduled');
}

module.exports = {
  MAX_ATTEMPTS,
  SUPPRESSED_ERROR,
  UNKNOWN_DELIVERY_ERROR,
  processPostEventThankYouBatch,
  queuePostEventThankYouBatch,
  runPostEventThankYouPass,
  settlePostEventThankYouWork,
  startPostEventThankYouCron
};
