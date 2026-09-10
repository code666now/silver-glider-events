const express = require('express');
const pool = require('../config/db');
const requireOrganizer = require('../middleware/requireOrganizer');
const { createRateLimiter, clientIp } = require('../lib/rate-limit');
const paypal = require('../lib/paypal');
const stripeSms = require('../lib/stripe-sms');
const ledger = require('../lib/sms-credit-ledger');

const router = express.Router();
const purchaseLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  rules: [
    { name: 'organizer', max: 20, key: context => context.organizerId },
    { name: 'ip', max: 40, key: context => context.ip }
  ]
});

function stripePaymentReady() {
  return stripeSms.stripeSmsClient.isConfigured({ requireWebhook: true });
}

function requireCreditAccess(req, res, provider = 'stripe') {
  if (!ledger.canAccessSmsCredits(req.organizer)) {
    res.status(404).json({ error: 'SMS credits are not available', code: 'sms_credits_disabled' });
    return false;
  }
  const ready = provider === 'paypal'
    ? paypal.paypalClient.isConfigured({ requireWebhook: true })
    : stripePaymentReady();
  if (!ready) {
    res.status(503).json({ error: 'SMS credit checkout is not ready', code: 'sms_credits_not_configured' });
    return false;
  }
  return true;
}

function handleKnownError(error, res, next) {
  if (!(error instanceof paypal.PayPalError) &&
      !(error instanceof stripeSms.StripeSmsError) &&
      !(error instanceof ledger.SmsCreditError)) {
    return next(error);
  }
  const detail = {
    code: error.code,
    status: error.status,
    ...(error.debugId ? { paypalDebugId: error.debugId } : {})
  };
  console.warn('[sms-credits] request failed', detail);
  res.status(error.status).json({
    error: error.message,
    code: error.code,
    ...(error.debugId ? { paypalDebugId: error.debugId } : {})
  });
}

router.get('/api/sms-credits', requireOrganizer, async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const allowed = ledger.canAccessSmsCredits(req.organizer);
    if (!allowed) return res.json({ enabled: false });
    const summary = await ledger.creditSummary(pool, req.organizer.id);
    const configured = stripeSms.stripeSmsClient.isConfigured();
    const ready = stripePaymentReady();
    const publicConfig = configured ? stripeSms.stripeSmsClient.publicConfig() : null;
    res.json({
      enabled: true,
      checkoutReady: ready,
      setupRequired: !ready,
      balance: summary.balance,
      transactions: summary.transactions,
      packs: ledger.publicPacks(),
      environment: publicConfig?.environment || null
    });
  } catch (error) {
    handleKnownError(error, res, next);
  }
});

function checkoutReturnUrl(req, result) {
  const configured = String(process.env.APP_URL || '').trim();
  const fallback = `${req.protocol}://${req.get('host')}`;
  let origin;
  try {
    const url = new URL(configured || fallback);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid protocol');
    origin = url.origin;
  } catch (_) {
    throw new ledger.SmsCreditError('Application checkout URL is not configured', {
      code: 'sms_credit_return_url_invalid', status: 503
    });
  }
  return `${origin}/settings/messaging?checkout=${result}`;
}

router.post('/api/sms-credits/checkout-sessions', requireOrganizer, async (req, res, next) => {
  let purchase = null;
  try {
    res.setHeader('Cache-Control', 'no-store');
    if (!requireCreditAccess(req, res)) return;
    const limit = purchaseLimiter.consume({
      organizerId: String(req.organizer.id),
      ip: clientIp(req)
    });
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
      return res.status(429).json({
        error: 'Too many checkout attempts. Try again later.',
        code: 'sms_credit_checkout_rate_limited'
      });
    }
    const pack = ledger.packForKey(req.body?.packKey);
    purchase = await ledger.createPendingPurchase(pool, req.organizer.id, pack, 'stripe');
    const checkout = await stripeSms.stripeSmsClient.createCheckoutSession({
      purchase,
      pack,
      organizerEmail: req.organizer.email,
      successUrl: checkoutReturnUrl(req, 'success'),
      cancelUrl: checkoutReturnUrl(req, 'cancelled')
    });
    const checkoutUrl = new URL(checkout.url);
    if (checkoutUrl.protocol !== 'https:' || checkoutUrl.hostname !== 'checkout.stripe.com') {
      throw new stripeSms.StripeSmsError('Stripe returned an invalid checkout destination', {
        code: 'stripe_sms_destination_invalid', status: 502
      });
    }
    await ledger.attachProviderOrder(pool, purchase.id, req.organizer.id, checkout.id, 'stripe');
    res.status(201).json({ checkoutUrl: checkoutUrl.toString() });
  } catch (error) {
    if (purchase) await ledger.markPurchaseFailed(pool, purchase.id, error.code).catch(() => {});
    handleKnownError(error, res, next);
  }
});

// Legacy PayPal endpoints remain available for rollback and already-open orders.
router.post('/api/sms-credits/orders', requireOrganizer, async (req, res, next) => {
  let purchase = null;
  try {
    res.setHeader('Cache-Control', 'no-store');
    if (!requireCreditAccess(req, res, 'paypal')) return;
    const limit = purchaseLimiter.consume({
      organizerId: String(req.organizer.id),
      ip: clientIp(req)
    });
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
      return res.status(429).json({
        error: 'Too many checkout attempts. Try again later.',
        code: 'sms_credit_checkout_rate_limited'
      });
    }
    const pack = ledger.packForKey(req.body?.packKey);
    const paymentSource = paypal.cleanPaymentSource(req.body?.paymentMethod || 'paypal');
    purchase = await ledger.createPendingPurchase(pool, req.organizer.id, pack);
    const order = await paypal.paypalClient.createOrder({
      reference: purchase.reference,
      description: `${pack.credits.toLocaleString('en-US')} Silver Glider SMS credits`,
      amountCents: pack.amountCents,
      currency: pack.currency,
      idempotencyKey: `sms-credit-order-${purchase.reference}`,
      paymentSource
    });
    const orderId = paypal.cleanOrderId(order?.id);
    await ledger.attachProviderOrder(pool, purchase.id, req.organizer.id, orderId);
    res.status(201).json({ orderId });
  } catch (error) {
    if (purchase) await ledger.markPurchaseFailed(pool, purchase.id, error.code).catch(() => {});
    handleKnownError(error, res, next);
  }
});

router.post('/api/sms-credits/orders/:orderId/capture', requireOrganizer, async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    if (!requireCreditAccess(req, res, 'paypal')) return;
    const orderId = paypal.cleanOrderId(req.params.orderId);
    const purchase = await ledger.purchaseForOrganizerOrder(pool, req.organizer.id, orderId);
    if (['completed', 'partially_refunded', 'refunded', 'reversed'].includes(purchase.status)) {
      const summary = await ledger.creditSummary(pool, req.organizer.id);
      return res.json({ completed: true, duplicate: true, ...summary });
    }

    let order = await paypal.paypalClient.getOrder(orderId);
    const unit = Array.isArray(order?.purchase_units) ? order.purchase_units[0] : null;
    if (String(unit?.custom_id || unit?.reference_id || '') !== purchase.reference ||
        ledger.centsFromPayPal(unit?.amount?.value) !== Number(purchase.amount_cents) ||
        String(unit?.amount?.currency_code || '').toUpperCase() !== purchase.currency) {
      throw new ledger.SmsCreditError('PayPal order does not match this credit purchase', {
        code: 'sms_credit_payment_mismatch', status: 409
      });
    }
    if (String(order.status || '').toUpperCase() !== 'COMPLETED') {
      order = await paypal.paypalClient.captureOrder(
        orderId,
        `sms-credit-capture-${purchase.reference}`
      );
    }
    const captured = ledger.completedCapture(order);
    const result = await ledger.completePurchase(pool, captured);
    const summary = await ledger.creditSummary(pool, req.organizer.id);
    res.json({ completed: true, duplicate: result.duplicate, ...summary });
  } catch (error) {
    handleKnownError(error, res, next);
  }
});

module.exports = router;
