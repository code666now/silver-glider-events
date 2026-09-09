const express = require('express');
const pool = require('../config/db');
const paypal = require('../lib/paypal');
const ledger = require('../lib/sms-credit-ledger');

const router = express.Router();
const SUPPORTED_EVENTS = new Set([
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED'
]);

function cleanProviderId(value, label) {
  const id = String(value || '').trim();
  if (!/^[A-Z0-9-]{8,80}$/i.test(id)) {
    throw new ledger.SmsCreditError(`Invalid PayPal ${label}`, {
      code: 'invalid_paypal_webhook', status: 400
    });
  }
  return id;
}

async function claimEvent(event) {
  const { rows } = await pool.query(
    `INSERT INTO paypal_webhook_events (id,event_type,resource_id,status)
     VALUES ($1,$2,$3,'processing')
     ON CONFLICT (id) DO UPDATE
       SET status='processing',error=NULL
       WHERE paypal_webhook_events.status='failed'
     RETURNING id`,
    [event.id, event.event_type, event.resource?.id || null]
  );
  return Boolean(rows.length);
}

async function finishEvent(eventId, status) {
  await pool.query(
    `UPDATE paypal_webhook_events
        SET status=$2,error=NULL,processed_at=NOW()
      WHERE id=$1`,
    [eventId, status]
  );
}

async function failEvent(eventId, error) {
  await pool.query(
    `UPDATE paypal_webhook_events
        SET status='failed',error=$2
      WHERE id=$1`,
    [eventId, String(error?.code || error?.message || 'webhook_processing_failed').slice(0, 500)]
  ).catch(() => {});
}

async function processCaptureCompleted(event) {
  const resource = event.resource || {};
  const orderId = cleanProviderId(resource?.supplementary_data?.related_ids?.order_id, 'order ID');
  const captureId = cleanProviderId(resource.id, 'capture ID');
  const { rows } = await pool.query(
    `SELECT reference FROM sms_credit_purchases
      WHERE provider='paypal' AND provider_order_id=$1`,
    [orderId]
  );
  if (!rows.length) {
    throw new ledger.SmsCreditError('SMS credit purchase was not found', {
      code: 'sms_credit_purchase_not_found', status: 404
    });
  }
  return ledger.completePurchase(pool, {
    orderId,
    captureId,
    reference: String(resource.custom_id || rows[0].reference),
    amountCents: ledger.centsFromPayPal(resource?.amount?.value),
    currency: String(resource?.amount?.currency_code || '').toUpperCase()
  });
}

async function processAdjustment(event, reversed) {
  const resource = event.resource || {};
  const related = resource?.supplementary_data?.related_ids || {};
  const captureId = cleanProviderId(related.capture_id || resource.id, 'capture ID');
  const providerTransactionId = cleanProviderId(
    reversed ? event.id : resource.id,
    reversed ? 'reversal ID' : 'refund ID'
  );
  return ledger.applyPurchaseAdjustment(pool, {
    captureId,
    providerTransactionId,
    amountCents: reversed ? 0 : ledger.centsFromPayPal(resource?.amount?.value),
    reversed
  });
}

router.post('/', async (req, res, next) => {
  let event = null;
  try {
    res.setHeader('Cache-Control', 'no-store');
    if (!Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: 'Expected a PayPal webhook payload' });
    }
    try {
      event = JSON.parse(req.body.toString('utf8'));
    } catch (_) {
      return res.status(400).json({ error: 'Invalid PayPal webhook payload' });
    }
    cleanProviderId(event?.id, 'event ID');
    const eventType = String(event?.event_type || '').trim().slice(0, 100);
    if (!eventType) return res.status(400).json({ error: 'Invalid PayPal webhook event' });

    const verified = await paypal.paypalClient.verifyWebhook(req.headers, event);
    if (!verified) {
      console.warn('[paypal:webhook] signature rejected', { eventId: event.id, eventType });
      return res.status(400).json({ error: 'Invalid PayPal webhook signature' });
    }
    const claimed = await claimEvent(event);
    if (!claimed) return res.json({ received: true, duplicate: true });

    if (!SUPPORTED_EVENTS.has(eventType)) {
      await finishEvent(event.id, 'ignored');
      return res.json({ received: true, ignored: true });
    }
    if (eventType === 'PAYMENT.CAPTURE.COMPLETED') await processCaptureCompleted(event);
    else if (eventType === 'PAYMENT.CAPTURE.REFUNDED') await processAdjustment(event, false);
    else await processAdjustment(event, true);

    await finishEvent(event.id, 'processed');
    console.info('[paypal:webhook] processed', {
      eventId: event.id,
      eventType,
      resourceId: event.resource?.id || null
    });
    res.json({ received: true });
  } catch (error) {
    if (event?.id) await failEvent(event.id, error);
    if (error instanceof paypal.PayPalError || error instanceof ledger.SmsCreditError) {
      console.warn('[paypal:webhook] failed', {
        eventId: event?.id || null,
        eventType: event?.event_type || null,
        code: error.code,
        status: error.status
      });
      return res.status(error.status >= 500 ? error.status : 500).json({
        error: 'PayPal webhook could not be processed'
      });
    }
    next(error);
  }
});

module.exports = router;
