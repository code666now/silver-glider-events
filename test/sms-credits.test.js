const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PayPalClient, PayPalError, cleanOrderId } = require('../src/lib/paypal');
const {
  SMS_CREDIT_PACKS,
  canAccessSmsCredits,
  centsFromPayPal,
  completedCapture,
  packForKey,
  publicPacks
} = require('../src/lib/sms-credit-ledger');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const validEnv = {
  PAYPAL_CLIENT_ID: 'sandbox-client-id',
  PAYPAL_CLIENT_SECRET: 'sandbox-client-secret',
  PAYPAL_ENV: 'sandbox',
  PAYPAL_WEBHOOK_ID: '8AB123456789'
};

function response(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: key => headers[String(key).toLowerCase()] || null },
    json: async () => payload
  };
}

test('SMS credit packs are fixed server-side and feature access protects sandbox users', () => {
  assert.deepEqual(publicPacks(), [
    { key: 'starter', credits: 300, amountCents: 2000, currency: 'USD' },
    { key: 'standard', credits: 1000, amountCents: 5000, currency: 'USD' },
    { key: 'pro', credits: 5000, amountCents: 20000, currency: 'USD' }
  ]);
  assert.equal(packForKey('starter'), SMS_CREDIT_PACKS.starter);
  assert.throws(() => packForKey('made-up'), /valid SMS credit pack/);
  assert.equal(canAccessSmsCredits({ is_admin: false }, { SMS_CREDITS_ENABLED: 'false' }), false);
  assert.equal(canAccessSmsCredits({ is_admin: true }, { SMS_CREDITS_ENABLED: 'admin', PAYPAL_ENV: 'sandbox' }), true);
  assert.equal(canAccessSmsCredits({ is_admin: false }, { SMS_CREDITS_ENABLED: 'true', PAYPAL_ENV: 'sandbox' }), false);
  assert.equal(canAccessSmsCredits({ is_admin: false }, { SMS_CREDITS_ENABLED: 'true', PAYPAL_ENV: 'live' }), true);
});

test('PayPal client creates fixed orders with server credentials and no secret in the payload', async () => {
  const requests = [];
  const client = new PayPalClient({
    env: validEnv,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith('/v1/oauth2/token')) {
        return response(200, { access_token: 'access-token', expires_in: 3600 });
      }
      return response(201, { id: 'ORDER123456789', status: 'CREATED' });
    }
  });
  const order = await client.createOrder({
    reference: 'sgsms_reference',
    description: '300 Silver Glider SMS credits',
    amountCents: 2000,
    currency: 'USD',
    idempotencyKey: 'purchase-reference'
  });
  assert.equal(order.id, 'ORDER123456789');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://api-m.sandbox.paypal.com/v1/oauth2/token');
  assert.match(requests[0].options.headers.Authorization, /^Basic /);
  const orderRequest = requests[1];
  assert.equal(orderRequest.url, 'https://api-m.sandbox.paypal.com/v2/checkout/orders');
  assert.equal(orderRequest.options.headers.Authorization, 'Bearer access-token');
  assert.equal(orderRequest.options.headers['PayPal-Request-Id'], 'purchase-reference');
  const body = JSON.parse(orderRequest.options.body);
  assert.equal(body.intent, 'CAPTURE');
  assert.equal(body.purchase_units[0].custom_id, 'sgsms_reference');
  assert.equal(body.purchase_units[0].amount.value, '20.00');
  assert.equal(body.purchase_units[0].amount.currency_code, 'USD');
  assert.doesNotMatch(orderRequest.options.body, /sandbox-client-secret/);
});

test('PayPal capture sends an explicit JSON body and keeps its idempotency key', async () => {
  const requests = [];
  const client = new PayPalClient({
    env: validEnv,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith('/v1/oauth2/token')) {
        return response(200, { access_token: 'access-token', expires_in: 3600 });
      }
      return response(201, { id: 'ORDER123456789', status: 'COMPLETED' });
    }
  });

  const order = await client.captureOrder('ORDER123456789', 'capture-reference');
  assert.equal(order.status, 'COMPLETED');
  const captureRequest = requests[1];
  assert.equal(captureRequest.url, 'https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER123456789/capture');
  assert.equal(captureRequest.options.method, 'POST');
  assert.equal(captureRequest.options.headers['Content-Type'], 'application/json');
  assert.equal(captureRequest.options.headers['PayPal-Request-Id'], 'capture-reference');
  assert.equal(captureRequest.options.body, '{}');
});

test('PayPal webhook verification uses the configured webhook ID', async () => {
  const requests = [];
  const client = new PayPalClient({
    env: validEnv,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith('/v1/oauth2/token')) {
        return response(200, { access_token: 'access-token', expires_in: 3600 });
      }
      return response(200, { verification_status: 'SUCCESS' });
    }
  });
  const event = { id: 'WH-12345678', event_type: 'PAYMENT.CAPTURE.COMPLETED' };
  const verified = await client.verifyWebhook({
    'paypal-transmission-id': 'transmission-id',
    'paypal-transmission-time': '2026-09-09T12:00:00Z',
    'paypal-cert-url': 'https://api-m.sandbox.paypal.com/cert',
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-transmission-sig': 'signature'
  }, event);
  assert.equal(verified, true);
  const payload = JSON.parse(requests[1].options.body);
  assert.equal(payload.webhook_id, validEnv.PAYPAL_WEBHOOK_ID);
  assert.deepEqual(payload.webhook_event, event);
});

test('PayPal errors are sanitized and IDs and captured amounts are validated', async () => {
  const client = new PayPalClient({
    env: validEnv,
    fetchImpl: async url => String(url).endsWith('/v1/oauth2/token')
      ? response(401, { error: `bad ${validEnv.PAYPAL_CLIENT_SECRET}` }, { 'paypal-debug-id': 'debug-safe' })
      : assert.fail('order request should not run')
  });
  await assert.rejects(client.getOrder('ORDER123456789'), error => {
    assert.ok(error instanceof PayPalError);
    assert.equal(error.code, 'paypal_auth_failed');
    assert.equal(error.debugId, 'debug-safe');
    assert.equal(error.message.includes(validEnv.PAYPAL_CLIENT_SECRET), false);
    return true;
  });
  assert.equal(cleanOrderId('ORDER123456789'), 'ORDER123456789');
  assert.throws(() => cleanOrderId('../bad'), /Invalid PayPal order/);
  assert.equal(centsFromPayPal('50.00'), 5000);
  assert.throws(() => centsFromPayPal('-1.00'), /invalid payment amount/);
  assert.deepEqual(completedCapture({
    id: 'ORDER123456789',
    purchase_units: [{
      custom_id: 'sgsms_reference',
      payments: { captures: [{
        id: 'CAPTURE12345678', status: 'COMPLETED',
        amount: { value: '20.00', currency_code: 'USD' }
      }] }
    }]
  }), {
    captureId: 'CAPTURE12345678',
    orderId: 'ORDER123456789',
    reference: 'sgsms_reference',
    amountCents: 2000,
    currency: 'USD'
  });
});

test('SMS credit persistence is additive, auditable, and separate from ticket commerce', () => {
  const migration = read('src/db/migrations/030_sms_credit_purchases.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS sms_credit_purchases/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS sms_credit_transactions/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS paypal_webhook_events/);
  assert.match(migration, /provider_order_id\s+TEXT UNIQUE/);
  assert.match(migration, /provider_capture_id\s+TEXT UNIQUE/);
  assert.match(migration, /external_key\s+TEXT UNIQUE/);
  assert.match(migration, /REFERENCES organizers\(id\) ON DELETE CASCADE/);
  assert.doesNotMatch(migration, /ALTER TABLE events|commerce_event_id|ticket_id/);
});

test('Host Settings owns the feature while secrets remain server-only', () => {
  const settings = read('src/views/settings.html');
  const route = read('src/routes/sms-credits.js');
  const webhook = read('src/routes/paypal-webhook.js');
  const index = read('src/index.js');
  const publicFiles = [settings, ...['public/js/api.js', 'public/css/main.css'].map(read)].join('\n');
  assert.match(settings, /id="sms-credits-title">SMS credits/);
  assert.match(settings, /Credits belong to this host and never expire/);
  assert.match(settings, /id="sms-credit-packs"/);
  assert.match(settings, /Venmo appears automatically/);
  assert.match(route, /requireOrganizer/);
  assert.match(route, /publicPacks\(\)/);
  assert.match(route, /packForKey\(req\.body\?\.packKey\)/);
  assert.match(route, /purchaseForOrganizerOrder\(pool, req\.organizer\.id, orderId\)/);
  assert.match(index, /express\.raw\(\{ type: 'application\/json'/);
  assert.match(index, /routes\/paypal-webhook/);
  assert.match(webhook, /verifyWebhook\(req\.headers, event\)/);
  assert.match(webhook, /PAYMENT\.CAPTURE\.COMPLETED/);
  assert.match(webhook, /PAYMENT\.CAPTURE\.REFUNDED/);
  assert.match(webhook, /PAYMENT\.CAPTURE\.REVERSED/);
  assert.doesNotMatch(publicFiles, /PAYPAL_CLIENT_SECRET|PAYPAL_WEBHOOK_ID/);
});
