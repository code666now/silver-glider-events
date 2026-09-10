const express = require('express');
const pool = require('../config/db');
const ledger = require('../lib/sms-credit-ledger');
const stripeSms = require('../lib/stripe-sms');

const router = express.Router();
const SUPPORTED_EVENTS = new Set(['checkout.session.completed']);

function cleanEventId(value) {
  const eventId = String(value || '').trim();
  if (!/^evt_[A-Za-z0-9]{8,220}$/.test(eventId)) {
    throw new stripeSms.StripeSmsError('Invalid Stripe webhook event', {
      code: 'invalid_stripe_sms_webhook', status: 400
    });
  }
  return eventId;
}

async function claimEvent(event) {
  const { rows } = await pool.query(
    `INSERT INTO stripe_sms_webhook_events (id,event_type,resource_id,status)
     VALUES ($1,$2,$3,'processing')
     ON CONFLICT (id) DO UPDATE
       SET status='processing',error=NULL
       WHERE stripe_sms_webhook_events.status='failed'
     RETURNING id`,
    [event.id, event.type, event.data?.object?.id || null]
  );
  return Boolean(rows.length);
}

async function finishEvent(eventId, status) {
  await pool.query(
    `UPDATE stripe_sms_webhook_events
        SET status=$2,error=NULL,processed_at=NOW()
      WHERE id=$1`,
    [eventId, status]
  );
}

async function failEvent(eventId, error) {
  await pool.query(
    `UPDATE stripe_sms_webhook_events
        SET status='failed',error=$2
      WHERE id=$1`,
    [eventId, String(error?.code || error?.message || 'webhook_processing_failed').slice(0, 500)]
  ).catch(() => {});
}

function paymentIntentId(session) {
  const value = typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent?.id;
  const id = String(value || '').trim();
  if (!/^pi_[A-Za-z0-9]{8,220}$/.test(id)) {
    throw new stripeSms.StripeSmsError('Stripe payment reference is invalid', {
      code: 'invalid_stripe_sms_payment', status: 409
    });
  }
  return id;
}

async function processCheckoutCompleted(event) {
  const eventSessionId = stripeSms.cleanSessionId(event.data?.object?.id);
  const session = await stripeSms.stripeSmsClient.retrieveCheckoutSession(eventSessionId);
  if (session.payment_status !== 'paid') return { ignored: true };
  if (session.mode !== 'payment' || session.status !== 'complete') {
    throw new stripeSms.StripeSmsError('Stripe checkout is not complete', {
      code: 'stripe_sms_checkout_incomplete', status: 409
    });
  }

  const items = Array.isArray(session.line_items?.data) ? session.line_items.data : [];
  if (items.length !== 1 || Number(items[0]?.quantity) !== 1) {
    throw new stripeSms.StripeSmsError('Stripe checkout contains invalid SMS items', {
      code: 'stripe_sms_items_mismatch', status: 409
    });
  }
  const priceId = typeof items[0]?.price === 'string' ? items[0].price : items[0]?.price?.id;
  const packKey = stripeSms.stripeSmsClient.packForPrice(priceId);
  const pack = ledger.packForKey(packKey);
  const metadata = session.metadata || {};
  if (metadata.packKey !== pack.key ||
      metadata.purchaseReference !== session.client_reference_id ||
      !/^\d+$/.test(String(metadata.organizerId || '')) ||
      !/^\d+$/.test(String(metadata.purchaseId || ''))) {
    throw new stripeSms.StripeSmsError('Stripe checkout metadata is invalid', {
      code: 'stripe_sms_metadata_mismatch', status: 409
    });
  }
  if (Number(session.amount_total) !== pack.amountCents ||
      String(session.currency || '').toUpperCase() !== pack.currency) {
    throw new stripeSms.StripeSmsError('Stripe checkout amount does not match the SMS pack', {
      code: 'stripe_sms_amount_mismatch', status: 409
    });
  }

  return ledger.completePurchase(pool, {
    provider: 'stripe',
    orderId: eventSessionId,
    captureId: paymentIntentId(session),
    reference: String(session.client_reference_id || ''),
    purchaseId: Number(metadata.purchaseId),
    organizerId: Number(metadata.organizerId),
    packKey,
    amountCents: Number(session.amount_total),
    currency: String(session.currency || '').toUpperCase()
  });
}

router.post('/', async (req, res, next) => {
  let event = null;
  try {
    res.setHeader('Cache-Control', 'no-store');
    if (!Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: 'Expected a Stripe webhook payload' });
    }
    event = stripeSms.stripeSmsClient.constructWebhookEvent(
      req.body,
      req.headers['stripe-signature']
    );
    cleanEventId(event?.id);
    const eventType = String(event?.type || '').trim().slice(0, 100);
    if (!eventType) return res.status(400).json({ error: 'Invalid Stripe webhook event' });

    const claimed = await claimEvent(event);
    if (!claimed) return res.json({ received: true, duplicate: true });
    if (!SUPPORTED_EVENTS.has(eventType)) {
      await finishEvent(event.id, 'ignored');
      return res.json({ received: true, ignored: true });
    }

    const result = await processCheckoutCompleted(event);
    await finishEvent(event.id, result?.ignored ? 'ignored' : 'processed');
    console.info('[stripe-sms:webhook] processed', {
      eventId: event.id,
      eventType,
      sessionId: event.data?.object?.id || null,
      ignored: Boolean(result?.ignored)
    });
    res.json({ received: true, ignored: Boolean(result?.ignored) });
  } catch (error) {
    if (event?.id) await failEvent(event.id, error);
    if (error instanceof stripeSms.StripeSmsError || error instanceof ledger.SmsCreditError) {
      console.warn('[stripe-sms:webhook] failed', {
        eventId: event?.id || null,
        eventType: event?.type || null,
        code: error.code,
        status: error.status
      });
      const signatureFailure = error.code === 'stripe_sms_signature_invalid';
      return res.status(signatureFailure ? 400 : 500).json({
        error: signatureFailure ? 'Invalid Stripe webhook signature' : 'Stripe webhook could not be processed'
      });
    }
    next(error);
  }
});

module.exports = router;
