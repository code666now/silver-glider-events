const cron = require('node-cron');
const pool = require('../config/db');
const sms = require('../lib/sms');
const { SMS_CONSENT_VERSION } = require('../lib/sms-consent');
const { FOLLOW_SMS_CONSENT_VERSION } = require('../lib/follow-consent');
const { refundSendCredits, accountWelcomeSmsAccepted, SmsCreditError } = require('../lib/sms-credit-ledger');
const { SINGLE_SEGMENT_TEMPLATE_VERSION, assertSingleSegmentMessage } = require('../lib/sms-lifecycle');
const {
  markWelcomeSmsCostOutcome, prepareWelcomeSmsCost,
  recordWelcomeSmsCost, reconcileWelcomeSmsCosts
} = require('../lib/sms-costs');
const {
  HOST_ACCOUNT_DELETED,
  HOST_ACCOUNT_INACTIVE,
  HOST_ACCOUNT_SUSPENDED,
  withActiveHostAccount
} = require('../lib/outbound-account-status');
const {
  createReminderBatch,
  eventForSms,
  makePreview
} = require('../lib/sms-reminder-fulfillment');

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
                provider_message_sid IS NULL AND attempt_count >= $3
                AND COALESCE(provider_error_code <> ALL($4::text[]),TRUE)),0)::int AS refundable,
              COALESCE(SUM(welcome_credits) FILTER (WHERE status='failed' AND
                provider_message_sid IS NULL AND attempt_count >= $3
                AND COALESCE(provider_error_code <> ALL($4::text[]),TRUE)),0)::int AS welcome_refundable
         FROM sms_notification_recipients WHERE batch_id=$1`,
      [batchId, ACCEPTED_STATUSES, MAX_ATTEMPTS, [HOST_ACCOUNT_DELETED, HOST_ACCOUNT_INACTIVE]]
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
        welcomeRefundCredits: Math.max(0, Number(counts.welcome_refundable || 0) - Number(batch.welcome_refunded_credits || 0)),
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

async function persistProviderAcceptance(db, recipientId, result) {
  const providerStatus = ACCEPTED_STATUSES.includes(result.status) ? result.status : 'accepted';
  const billing = sms.providerBillingFields(result);
  await db.query(
    `WITH accepted AS (UPDATE sms_notification_recipients
        SET status=CASE WHEN provider_message_sid IS NOT NULL THEN status ELSE $2 END,
            provider_status=CASE WHEN provider_message_sid IS NOT NULL THEN provider_status ELSE $3 END,
            provider_message_sid=COALESCE(provider_message_sid,$4),
            provider_price=COALESCE($5,provider_price),provider_price_unit=COALESCE($6,provider_price_unit),
            provider_num_segments=COALESCE($7,provider_num_segments),
            provider_price_checked_at=CASE WHEN $5::numeric IS NOT NULL THEN NOW() ELSE provider_price_checked_at END,
            accepted_at=COALESCE(accepted_at,NOW()),updated_at=NOW(),
            provider_error_code=CASE WHEN provider_message_sid IS NOT NULL THEN provider_error_code ELSE NULL END
      WHERE id=$1 AND (provider_message_sid IS NULL OR provider_message_sid=$4) RETURNING id)
     UPDATE sms_provider_cost_facts SET provider_message_sid=COALESCE(provider_message_sid,$4),
        acceptance_state='accepted',accepted_at=COALESCE(accepted_at,NOW())
      WHERE source_recipient_id=$1 AND (provider_message_sid IS NULL OR provider_message_sid=$4)`,
    [recipientId,providerStatus,result.status,result.sid,billing.price,billing.priceUnit,billing.numSegments]
  );
}

async function persistWelcomeAcceptance(db, batch, delivery, result) {
  if (!(Number(delivery.welcome_credits) > 0)) return;
  try {
    await db.query('BEGIN');
    await recordWelcomeSmsCost(db, {
      recipientId: delivery.id, welcomeClaimId: batch.welcome_claim_id,
      welcomeCredits: delivery.welcome_credits, result
    });
    await accountWelcomeSmsAccepted(db, delivery.id);
    await db.query('COMMIT');
  } catch (_) {
    await db.query('ROLLBACK').catch(() => {});
    // The SID has already been committed. Accounting can be reconciled later;
    // an unavailable price/ledger must never turn an accepted text into a retry.
    console.error('[sms-costs] acceptance accounting pending reconciliation');
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
    `SELECT sr.id, sr.rsvp_id, sr.host_follow_id, sr.recipient, sr.status_token, sr.message_body,sr.welcome_credits
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
    const eligible = batch.kind === 'follower_announcement'
      ? (await pool.query(
        `SELECT 1 FROM host_follows
          WHERE id=$1 AND host_organizer_id=$2 AND unsubscribed_at IS NULL
            AND sms_opted_in_at IS NOT NULL AND sms_opted_out_at IS NULL
            AND sms_consent_version=$4 AND sms_phone=$3`,
        [delivery.host_follow_id, batch.organizer_id, delivery.recipient, FOLLOW_SMS_CONSENT_VERSION]
      )).rows.length > 0
      : (await pool.query(
        `SELECT 1 FROM rsvps WHERE id=$1 AND status='confirmed' AND sms_optin=TRUE
          AND sms_consent_at IS NOT NULL AND sms_opted_out_at IS NULL
          AND sms_consent_version=$3 AND phone=$2`,
        [delivery.rsvp_id, delivery.recipient, SMS_CONSENT_VERSION]
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
    let acceptedResult = null;
    let providerAttempted = false;
    try {
      const body = delivery.message_body || batch.message_body;
      if (batch.template_version === SINGLE_SEGMENT_TEMPLATE_VERSION) assertSingleSegmentMessage(body);
      const deliveryResult = await withActiveHostAccount(pool, batch.organizer_id, async client => {
        // Reserve a durable, non-PII billing fact before the external side effect.
        // A timeout or deletion can then never erase a potentially charged text.
        await prepareWelcomeSmsCost(client, {
          recipientId: delivery.id, welcomeClaimId: batch.welcome_claim_id,
          welcomeCredits: delivery.welcome_credits
        });
        providerAttempted = true;
        const result = await sms.sendSms({
          to: delivery.recipient, body, statusCallback: callbackUrl(delivery.status_token)
        });
        acceptedResult = result;
        // Keep the account-deletion lock until the SID and durable, non-PII
        // cost attribution have been saved. Costs are always best effort.
        await persistProviderAcceptance(client, delivery.id, result);
        await persistWelcomeAcceptance(client, batch, delivery, result);
        return result;
      });
      if (!deliveryResult.allowed) {
        const inactiveCode = deliveryResult.accountStatus === 'suspended'
          ? HOST_ACCOUNT_SUSPENDED
          : deliveryResult.accountStatus === 'deleted'
            ? HOST_ACCOUNT_DELETED
            : HOST_ACCOUNT_INACTIVE;
        await pool.query(
          `UPDATE sms_notification_recipients
              SET status='failed',attempt_count=$2,provider_error_code=$3,
                  failed_at=NOW(),updated_at=NOW()
            WHERE id=$1 AND provider_message_sid IS NULL`,
          [delivery.id, MAX_ATTEMPTS, inactiveCode]
        );
        continue;
      }
    } catch (error) {
      if (acceptedResult) {
        // Even a connection/unlock failure after a successful provider response
        // must not send another text. Try to save its SID again; otherwise leave
        // it processing for investigation instead of marking it retryable.
        await persistProviderAcceptance(pool, delivery.id, acceptedResult).catch(() => {});
        await recordWelcomeSmsCost(pool, {
          recipientId: delivery.id, welcomeClaimId: batch.welcome_claim_id,
          welcomeCredits: delivery.welcome_credits, result: acceptedResult
        }).catch(() => {});
        console.error('[sms-notifications] accepted delivery persistence needs reconciliation');
        continue;
      }
      const acceptanceUnknown = error.acceptance === 'unknown' ||
        (providerAttempted && error.acceptance !== 'not_sent' && error.acceptance !== 'rejected' && error.code !== 'sms_rejected');
      if (acceptanceUnknown) {
        // A transport timeout/5xx is not proof that Twilio rejected a POST.
        // Hold it for its signed callback/manual investigation, without a
        // retry or automatic credit refund that could enable another send.
        await pool.query(
          `UPDATE sms_notification_recipients SET status='processing',attempt_count=$2,
             provider_error_code='sms_acceptance_unknown',updated_at=NOW()
            WHERE id=$1 AND provider_message_sid IS NULL`, [delivery.id,MAX_ATTEMPTS]
        );
        await markWelcomeSmsCostOutcome(pool, delivery.id, 'unknown').catch(() => {});
        console.error('[sms-notifications] provider acceptance unknown; automatic retry withheld');
        continue;
      }
      await markWelcomeSmsCostOutcome(pool, delivery.id, 'not_sent').catch(() => {});
      const permanent = error.code === 'sms_rejected' || error.code === 'sms_single_segment_required';
      if (Number(error.providerCode) === 21610) {
        await Promise.all([
          pool.query(
            `UPDATE rsvps SET sms_optin=FALSE,sms_opted_out_at=COALESCE(sms_opted_out_at,NOW())
              WHERE phone=$1`, [delivery.recipient]
          ),
          pool.query(
            `UPDATE host_follows SET sms_opted_out_at=COALESCE(sms_opted_out_at,NOW()),updated_at=NOW()
              WHERE sms_phone=$1 AND sms_opted_in_at IS NOT NULL`, [delivery.recipient]
          )
        ]);
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

async function runAutomaticReminderPass({ minimumLocalHour = 16 } = {}) {
  const { rows: dueEvents } = await pool.query(
    `SELECT e.id,e.organizer_id
       FROM events e
      WHERE e.sms_reminder_enabled=TRUE
        AND e.status='published'
        AND e.secret_show_enabled=FALSE
        AND e.event_date=((CURRENT_TIMESTAMP AT TIME ZONE e.timezone)::date + 1)
        AND EXTRACT(HOUR FROM (CURRENT_TIMESTAMP AT TIME ZONE e.timezone)) >= $1
        AND NOT EXISTS (
          SELECT 1 FROM sms_notification_batches b
           WHERE b.event_id=e.id AND b.kind='event_tomorrow'
        )
      ORDER BY e.id`,
    [minimumLocalHour]
  );
  for (const due of dueEvents) {
    const client = await pool.connect();
    let queuedBatchId = null;
    try {
      await client.query('BEGIN');
      const event = await eventForSms(client, due.id, due.organizer_id, { lock: true });
      const preview = event ? await makePreview(client, event) : null;
      if (!preview?.canSend) {
        await client.query('ROLLBACK');
        continue;
      }
      const { batch } = await createReminderBatch(client, event, preview);
      queuedBatchId = batch.id;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code !== '23505' && !(error instanceof SmsCreditError)) {
        console.error(`[sms-notifications] automatic reminder for event ${due.id} failed:`, error.message);
      }
    } finally {
      client.release();
    }
    if (queuedBatchId) queueSmsBatch(queuedBatchId);
  }
}

async function runSmsPass() {
  if (running) return;
  running = true;
  try {
    await runAutomaticReminderPass();
    const { rows } = await pool.query(
      `SELECT b.id FROM sms_notification_batches b
        WHERE b.status IN ('pending','processing','partial_failed')
          AND (NOT EXISTS (SELECT 1 FROM sms_notification_recipients held
                WHERE held.batch_id=b.id AND held.status='processing')
               OR EXISTS (SELECT 1 FROM sms_notification_recipients retry
                WHERE retry.batch_id=b.id AND retry.provider_message_sid IS NULL
                  AND retry.status IN ('pending','failed') AND retry.attempt_count<$1))
        ORDER BY b.id LIMIT 25`, [MAX_ATTEMPTS]
    );
    for (const row of rows) await processSmsBatch(row.id);
    // Provider price lookups run separately so delayed billing can never delay
    // the reminder queue. The reconciler bounds/leases its work and never sends.
    void reconcileWelcomeSmsCosts().catch(() => {
      console.error('[sms-costs] provider cost reconciliation unavailable');
    });
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
  console.log('[sms-notifications] automatic day-before and minute retry cron scheduled');
}

module.exports = {
  MAX_ATTEMPTS,
  finalizeSmsBatch,
  processSmsBatch,
  queueSmsBatch,
  runAutomaticReminderPass,
  runSmsPass,
  startSmsNotificationCron
};
