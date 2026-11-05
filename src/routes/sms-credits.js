const express = require('express');
const pool = require('../config/db');
const requireOrganizer = require('../middleware/requireOrganizer');
const { createRateLimiter, clientIp } = require('../lib/rate-limit');
const paypal = require('../lib/paypal');
const stripeSms = require('../lib/stripe-sms');
const ledger = require('../lib/sms-credit-ledger');
const welcome = require('../lib/sms-welcome');

const router = express.Router();
const purchaseLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  rules: [
    { name: 'organizer', max: 20, key: context => context.organizerId },
    { name: 'ip', max: 40, key: context => context.ip }
  ]
});
const welcomeLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  rules: [
    { name: 'organizer', max: 12, key: context => context.organizerId },
    { name: 'ip', max: 30, key: context => context.ip }
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
    ...(error.welcome ? { welcome: error.welcome } : {}),
    ...(error.debugId ? { paypalDebugId: error.debugId } : {})
  });
}

router.get('/api/sms-credits', requireOrganizer, async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const allowed = ledger.canAccessSmsCredits(req.organizer);
    if (!allowed) return res.json({ enabled: false });
    const [summary, welcomeState] = await Promise.all([
      ledger.creditSummary(pool, req.organizer.id),
      welcome.welcomeStatus(pool, req.organizer)
    ]);
    const configured = stripeSms.stripeSmsClient.isConfigured();
    const ready = stripePaymentReady();
    const publicConfig = configured ? stripeSms.stripeSmsClient.publicConfig() : null;
    res.json({
      enabled: true,
      checkoutReady: ready,
      setupRequired: !ready,
      balance: summary.balance,
      welcomeBalance: summary.welcomeBalance,
      welcome: welcomeState,
      transactions: summary.transactions,
      packs: ledger.publicPacks(),
      environment: publicConfig?.environment || null
    });
  } catch (error) {
    handleKnownError(error, res, next);
  }
});

router.get('/api/sms-credits/welcome', requireOrganizer, async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await welcome.welcomeStatus(pool, req.organizer));
  } catch (error) { handleKnownError(error, res, next); }
});

router.post(['/api/sms-credits/welcome/claim', '/api/sms-credits/welcome-claim'], requireOrganizer, async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const limit = welcomeLimiter.consume({ organizerId: String(req.organizer.id), ip: clientIp(req) });
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
      return res.status(429).json({ error: 'Too many claim attempts. Try again later.', code: 'welcome_rate_limited' });
    }
    res.json(await welcome.claimWelcomeCredits(pool, req.organizer, {
      confirm: req.body?.confirm, previewFingerprint: req.body?.previewFingerprint
    }));
  } catch (error) { handleKnownError(error, res, next); }
});

router.get('/api/sms-credits/checkout-sessions/:sessionId', requireOrganizer, async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    if (!ledger.canAccessSmsCredits(req.organizer)) {
      return res.status(404).json({ error: 'SMS credits are not available', code: 'sms_credits_disabled' });
    }
    const sessionId = String(req.params.sessionId || '');
    if (!/^cs_(?:test_|live_)?[A-Za-z0-9_]{8,240}$/.test(sessionId)) {
      return res.status(400).json({ error: 'Invalid checkout session', code: 'invalid_checkout_session' });
    }
    // Read only our webhook-confirmed purchase. Never capture a payment or trust
    // the browser's success return as proof of funds.
    const purchase = (await pool.query(
      `SELECT p.status,p.credits,p.completed_at,o.sms_credits
         FROM sms_credit_purchases p JOIN organizers o ON o.id=p.organizer_id
        WHERE p.organizer_id=$1 AND p.provider='stripe' AND p.provider_order_id=$2`,
      [req.organizer.id, sessionId]
    )).rows[0];
    if (!purchase) return res.status(404).json({ error: 'Checkout not found', code: 'checkout_not_found' });
    res.json({ status: purchase.status, credited: Boolean(purchase.completed_at),
      balance: Number(purchase.sms_credits), credits: Number(purchase.credits) });
  } catch (error) { handleKnownError(error, res, next); }
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
  return `${origin}/settings/messaging?checkout=${result}${result === 'success' ? '&session_id={CHECKOUT_SESSION_ID}' : ''}`;
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
    res.status(201).json({ checkoutUrl: checkoutUrl.toString(), sessionId: checkout.id });
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
