const Stripe = require('stripe');

const PRICE_ENV_BY_PACK = Object.freeze({
  starter: 'STRIPE_SMS_300_PRICE_ID',
  standard: 'STRIPE_SMS_500_PRICE_ID',
  pro: 'STRIPE_SMS_1000_PRICE_ID'
});

class StripeSmsError extends Error {
  constructor(message, { code = 'stripe_sms_error', status = 502 } = {}) {
    super(message);
    this.name = 'StripeSmsError';
    this.code = code;
    this.status = status;
  }
}

function cleanSecretKey(value) {
  const key = String(value || '').trim();
  if (!/^sk_(?:test|live)_[A-Za-z0-9_]{8,}$/.test(key)) {
    throw new StripeSmsError('Stripe SMS checkout is not configured', {
      code: 'stripe_sms_not_configured', status: 503
    });
  }
  return key;
}

function cleanPriceId(value) {
  const priceId = String(value || '').trim();
  if (!/^price_[A-Za-z0-9]{8,}$/.test(priceId)) {
    throw new StripeSmsError('Stripe SMS prices are not configured', {
      code: 'stripe_sms_prices_not_configured', status: 503
    });
  }
  return priceId;
}

function cleanSessionId(value) {
  const sessionId = String(value || '').trim();
  if (!/^cs_(?:test_|live_)?[A-Za-z0-9]{8,220}$/.test(sessionId)) {
    throw new StripeSmsError('Invalid Stripe checkout session', {
      code: 'invalid_stripe_checkout_session', status: 400
    });
  }
  return sessionId;
}

function readConfig(env = process.env, { requireWebhook = false } = {}) {
  const secretKey = cleanSecretKey(env.STRIPE_SMS_SECRET_KEY);
  const prices = {};
  for (const [packKey, variable] of Object.entries(PRICE_ENV_BY_PACK)) {
    prices[packKey] = cleanPriceId(env[variable]);
  }
  const uniquePrices = new Set(Object.values(prices));
  if (uniquePrices.size !== Object.keys(prices).length) {
    throw new StripeSmsError('Each SMS credit pack needs its own Stripe Price', {
      code: 'stripe_sms_duplicate_prices', status: 503
    });
  }
  const webhookSecret = String(env.STRIPE_SMS_WEBHOOK_SECRET || '').trim();
  if (requireWebhook && !/^whsec_[A-Za-z0-9_]{8,}$/.test(webhookSecret)) {
    throw new StripeSmsError('Stripe SMS webhook is not configured', {
      code: 'stripe_sms_webhook_not_configured', status: 503
    });
  }
  return {
    secretKey,
    webhookSecret,
    prices,
    environment: secretKey.startsWith('sk_live_') ? 'live' : 'sandbox'
  };
}

function providerError(error) {
  if (error instanceof StripeSmsError) return error;
  if (error?.type === 'StripeSignatureVerificationError') {
    return new StripeSmsError('Invalid Stripe webhook signature', {
      code: 'stripe_sms_signature_invalid', status: 400
    });
  }
  const providerStatus = Number(error?.statusCode) || 0;
  if (providerStatus >= 400 && providerStatus < 500) {
    return new StripeSmsError('Stripe could not open this checkout', {
      code: 'stripe_sms_checkout_rejected', status: 422
    });
  }
  return new StripeSmsError('Stripe checkout is temporarily unavailable', {
    code: 'stripe_sms_unavailable', status: 502
  });
}

class StripeSmsClient {
  constructor({ env = process.env, client = null } = {}) {
    this.env = env;
    this.clientOverride = client;
    this.cachedClient = null;
  }

  config(options) {
    return readConfig(this.env, options);
  }

  isConfigured(options) {
    try {
      this.config(options);
      return true;
    } catch (_) {
      return false;
    }
  }

  publicConfig() {
    return { environment: this.config().environment };
  }

  client() {
    if (this.clientOverride) return this.clientOverride;
    if (!this.cachedClient) this.cachedClient = new Stripe(this.config().secretKey);
    return this.cachedClient;
  }

  priceForPack(packKey) {
    const priceId = this.config().prices[String(packKey || '')];
    if (!priceId) {
      throw new StripeSmsError('Choose a valid SMS credit pack', {
        code: 'invalid_sms_credit_pack', status: 400
      });
    }
    return priceId;
  }

  packForPrice(priceId) {
    const cleanId = cleanPriceId(priceId);
    const match = Object.entries(this.config().prices).find(([, configured]) => configured === cleanId);
    if (!match) {
      throw new StripeSmsError('Stripe checkout contains an unapproved SMS price', {
        code: 'stripe_sms_price_mismatch', status: 409
      });
    }
    return match[0];
  }

  async createCheckoutSession({ purchase, pack, organizerEmail, successUrl, cancelUrl }) {
    try {
      const metadata = {
        purchaseId: String(purchase.id),
        purchaseReference: String(purchase.reference),
        organizerId: String(purchase.organizer_id),
        packKey: String(pack.key)
      };
      const session = await this.client().checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [{ price: this.priceForPack(pack.key), quantity: 1 }],
        client_reference_id: purchase.reference,
        customer_email: String(organizerEmail || '').trim() || undefined,
        metadata,
        payment_intent_data: { metadata },
        success_url: successUrl,
        cancel_url: cancelUrl,
        submit_type: 'pay'
      }, { idempotencyKey: `sms-credit-checkout-${purchase.reference}` });
      return {
        id: cleanSessionId(session?.id),
        url: String(session?.url || '')
      };
    } catch (error) {
      throw providerError(error);
    }
  }

  constructWebhookEvent(rawBody, signature) {
    try {
      const config = this.config({ requireWebhook: true });
      return this.client().webhooks.constructEvent(rawBody, signature, config.webhookSecret);
    } catch (error) {
      throw providerError(error);
    }
  }

  async retrieveCheckoutSession(value) {
    try {
      return await this.client().checkout.sessions.retrieve(cleanSessionId(value), {
        expand: ['line_items.data.price']
      });
    } catch (error) {
      throw providerError(error);
    }
  }
}

const stripeSmsClient = new StripeSmsClient();

module.exports = {
  PRICE_ENV_BY_PACK,
  StripeSmsClient,
  StripeSmsError,
  cleanPriceId,
  cleanSessionId,
  readConfig,
  stripeSmsClient
};
