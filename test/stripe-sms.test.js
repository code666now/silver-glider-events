const test = require('node:test');
const assert = require('node:assert/strict');
const {
  StripeSmsClient,
  StripeSmsError,
  cleanPriceId,
  cleanSessionId,
  readConfig
} = require('../src/lib/stripe-sms');

const validEnv = {
  STRIPE_SMS_SECRET_KEY: 'sk_test_sms_checkout_test_key',
  STRIPE_SMS_300_PRICE_ID: 'price_starter12345',
  STRIPE_SMS_500_PRICE_ID: 'price_standard12345',
  STRIPE_SMS_1000_PRICE_ID: 'price_pro123456789',
  STRIPE_SMS_WEBHOOK_SECRET: 'whsec_sms_checkout_test_secret'
};

test('Stripe SMS configuration keeps dedicated prices server-side', () => {
  assert.deepEqual(readConfig(validEnv), {
    secretKey: validEnv.STRIPE_SMS_SECRET_KEY,
    webhookSecret: validEnv.STRIPE_SMS_WEBHOOK_SECRET,
    prices: {
      starter: validEnv.STRIPE_SMS_300_PRICE_ID,
      standard: validEnv.STRIPE_SMS_500_PRICE_ID,
      pro: validEnv.STRIPE_SMS_1000_PRICE_ID
    },
    environment: 'sandbox'
  });
  assert.equal(new StripeSmsClient({ env: validEnv }).publicConfig().environment, 'sandbox');
  assert.throws(
    () => readConfig({ ...validEnv, STRIPE_SMS_500_PRICE_ID: validEnv.STRIPE_SMS_300_PRICE_ID }),
    /own Stripe Price/
  );
  assert.throws(
    () => readConfig({ ...validEnv, STRIPE_SMS_WEBHOOK_SECRET: '' }, { requireWebhook: true }),
    /webhook is not configured/
  );
});

test('Stripe Checkout uses one trusted Price and authoritative purchase metadata', async () => {
  let request;
  let options;
  const client = new StripeSmsClient({
    env: validEnv,
    client: {
      checkout: { sessions: {
        create: async (payload, createOptions) => {
          request = payload;
          options = createOptions;
          return { id: 'cs_test_checkout12345678', url: 'https://checkout.stripe.com/c/pay/test' };
        }
      } }
    }
  });
  const session = await client.createCheckoutSession({
    purchase: { id: 42, reference: 'sgsms_reference', organizer_id: 7 },
    pack: { key: 'standard', credits: 500, amountCents: 3500, currency: 'USD' },
    organizerEmail: 'host@example.test',
    successUrl: 'https://events.example/settings/messaging?checkout=success',
    cancelUrl: 'https://events.example/settings/messaging?checkout=cancelled'
  });
  assert.equal(session.id, 'cs_test_checkout12345678');
  assert.deepEqual(request.line_items, [{ price: validEnv.STRIPE_SMS_500_PRICE_ID, quantity: 1 }]);
  assert.equal(request.mode, 'payment');
  assert.deepEqual(request.payment_method_types, ['card']);
  assert.equal(request.client_reference_id, 'sgsms_reference');
  assert.equal(request.customer_email, 'host@example.test');
  assert.deepEqual(request.metadata, {
    purchaseId: '42', purchaseReference: 'sgsms_reference', organizerId: '7', packKey: 'standard'
  });
  assert.deepEqual(request.payment_intent_data.metadata, request.metadata);
  assert.equal(options.idempotencyKey, 'sms-credit-checkout-sgsms_reference');
  assert.equal(JSON.stringify(request).includes(validEnv.STRIPE_SMS_SECRET_KEY), false);
});

test('Stripe webhook verification receives exact raw bytes and the configured signing secret', () => {
  const raw = Buffer.from('{"id":"evt_checkout12345678"}');
  let received;
  const client = new StripeSmsClient({
    env: validEnv,
    client: {
      webhooks: {
        constructEvent(body, signature, secret) {
          received = { body, signature, secret };
          return { id: 'evt_checkout12345678', type: 'checkout.session.completed' };
        }
      }
    }
  });
  const event = client.constructWebhookEvent(raw, 't=123,v1=signature');
  assert.equal(event.type, 'checkout.session.completed');
  assert.equal(received.body, raw);
  assert.equal(received.signature, 't=123,v1=signature');
  assert.equal(received.secret, validEnv.STRIPE_SMS_WEBHOOK_SECRET);
});

test('Stripe identifiers and provider errors are rejected without leaking secrets', async () => {
  assert.equal(cleanPriceId('price_valid123456'), 'price_valid123456');
  assert.equal(cleanSessionId('cs_test_valid123456'), 'cs_test_valid123456');
  assert.throws(() => cleanPriceId('prod_not_a_price'), /prices are not configured/);
  assert.throws(() => cleanSessionId('../bad'), /Invalid Stripe checkout session/);

  const client = new StripeSmsClient({
    env: validEnv,
    client: { checkout: { sessions: { retrieve: async () => {
      const error = new Error(`bad ${validEnv.STRIPE_SMS_SECRET_KEY}`);
      error.statusCode = 500;
      throw error;
    } } } }
  });
  await assert.rejects(client.retrieveCheckoutSession('cs_test_valid123456'), error => {
    assert.ok(error instanceof StripeSmsError);
    assert.equal(error.code, 'stripe_sms_unavailable');
    assert.equal(error.message.includes(validEnv.STRIPE_SMS_SECRET_KEY), false);
    return true;
  });
});
