class PayPalError extends Error {
  constructor(message, { code = 'paypal_error', status = 502, providerStatus = null, debugId = null } = {}) {
    super(message);
    this.name = 'PayPalError';
    this.code = code;
    this.status = status;
    this.providerStatus = providerStatus;
    this.debugId = debugId;
  }
}

function cleanEnvironment(value) {
  return String(value || '').trim().toLowerCase() === 'live' ? 'live' : 'sandbox';
}

function readConfig(env = process.env) {
  const clientId = String(env.PAYPAL_CLIENT_ID || '').trim();
  const clientSecret = String(env.PAYPAL_CLIENT_SECRET || '').trim();
  const environment = cleanEnvironment(env.PAYPAL_ENV);
  const webhookId = String(env.PAYPAL_WEBHOOK_ID || '').trim();
  if (!clientId || !clientSecret) {
    throw new PayPalError('PayPal checkout is not configured', {
      code: 'paypal_not_configured',
      status: 503
    });
  }
  return {
    clientId,
    clientSecret,
    environment,
    webhookId,
    apiBaseUrl: environment === 'live'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com',
    sdkUrl: environment === 'live'
      ? 'https://www.paypal.com/web-sdk/v6/core'
      : 'https://www.sandbox.paypal.com/web-sdk/v6/core'
  };
}

function cleanOrderId(value) {
  const orderId = String(value || '').trim();
  if (!/^[A-Z0-9]{10,30}$/i.test(orderId)) {
    throw new PayPalError('Invalid PayPal order', { code: 'invalid_paypal_order', status: 400 });
  }
  return orderId;
}

function providerError(response, payload = {}) {
  const providerStatus = Number(response?.status) || null;
  const debugId = String(response?.headers?.get?.('paypal-debug-id') || payload?.debug_id || '').slice(0, 100) || null;
  const issue = String(payload?.details?.[0]?.issue || payload?.name || '').slice(0, 100) || null;
  if (providerStatus === 401 || providerStatus === 403) {
    return new PayPalError('PayPal authentication failed', {
      code: 'paypal_auth_failed', status: 503, providerStatus, debugId
    });
  }
  if (providerStatus && providerStatus < 500) {
    return new PayPalError('PayPal could not complete this checkout', {
      code: issue === 'ORDER_ALREADY_CAPTURED' ? 'paypal_order_already_captured' : 'paypal_rejected',
      status: issue === 'ORDER_ALREADY_CAPTURED' ? 409 : 422,
      providerStatus,
      debugId
    });
  }
  return new PayPalError('PayPal is temporarily unavailable', {
    code: 'paypal_unavailable', status: 502, providerStatus, debugId
  });
}

class PayPalClient {
  constructor({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.min(20000, Math.max(1000, Number(timeoutMs) || 10000));
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  config() {
    return readConfig(this.env);
  }

  isConfigured({ requireWebhook = false } = {}) {
    try {
      const config = this.config();
      return typeof this.fetchImpl === 'function' && (!requireWebhook || Boolean(config.webhookId));
    } catch (_) {
      return false;
    }
  }

  publicConfig() {
    const config = this.config();
    return {
      clientId: config.clientId,
      environment: config.environment,
      sdkUrl: config.sdkUrl
    };
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60000) return this.token;
    const config = this.config();
    if (typeof this.fetchImpl !== 'function') {
      throw new PayPalError('PayPal is temporarily unavailable', { code: 'paypal_unavailable', status: 502 });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${config.apiBaseUrl}/v1/oauth2/token`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.access_token) throw providerError(response, payload);
      this.token = String(payload.access_token);
      this.tokenExpiresAt = Date.now() + Math.max(60, Number(payload.expires_in) || 300) * 1000;
      return this.token;
    } catch (error) {
      if (error instanceof PayPalError) throw error;
      if (error?.name === 'AbortError') {
        throw new PayPalError('PayPal timed out', { code: 'paypal_timeout', status: 504 });
      }
      throw new PayPalError('PayPal is temporarily unavailable', { code: 'paypal_unavailable', status: 502 });
    } finally {
      clearTimeout(timer);
    }
  }

  async request(path, { method = 'GET', body, idempotencyKey } = {}) {
    const config = this.config();
    const destination = new URL(String(path || '').replace(/^\/+/, ''), `${config.apiBaseUrl}/`);
    if (destination.origin !== config.apiBaseUrl) {
      throw new PayPalError('Invalid PayPal destination', { code: 'invalid_paypal_destination', status: 500 });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(destination, {
        method,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${await this.accessToken()}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(idempotencyKey ? { 'PayPal-Request-Id': String(idempotencyKey).slice(0, 108) } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw providerError(response, payload);
      return payload;
    } catch (error) {
      if (error instanceof PayPalError) throw error;
      if (error?.name === 'AbortError') {
        throw new PayPalError('PayPal timed out', { code: 'paypal_timeout', status: 504 });
      }
      throw new PayPalError('PayPal is temporarily unavailable', { code: 'paypal_unavailable', status: 502 });
    } finally {
      clearTimeout(timer);
    }
  }

  createOrder({ reference, description, amountCents, currency = 'USD', idempotencyKey }) {
    return this.request('/v2/checkout/orders', {
      method: 'POST',
      idempotencyKey,
      body: {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: reference,
          custom_id: reference,
          description: String(description || '').slice(0, 127),
          amount: {
            currency_code: currency,
            value: (Number(amountCents) / 100).toFixed(2)
          }
        }]
      }
    });
  }

  getOrder(orderId) {
    return this.request(`/v2/checkout/orders/${encodeURIComponent(cleanOrderId(orderId))}`);
  }

  captureOrder(orderId, idempotencyKey) {
    return this.request(`/v2/checkout/orders/${encodeURIComponent(cleanOrderId(orderId))}/capture`, {
      method: 'POST',
      idempotencyKey
    });
  }

  async verifyWebhook(headers, event) {
    const config = this.config();
    if (!config.webhookId) {
      throw new PayPalError('PayPal webhook verification is not configured', {
        code: 'paypal_webhook_not_configured', status: 503
      });
    }
    const payload = await this.request('/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      body: {
        transmission_id: String(headers['paypal-transmission-id'] || ''),
        transmission_time: String(headers['paypal-transmission-time'] || ''),
        cert_url: String(headers['paypal-cert-url'] || ''),
        auth_algo: String(headers['paypal-auth-algo'] || ''),
        transmission_sig: String(headers['paypal-transmission-sig'] || ''),
        webhook_id: config.webhookId,
        webhook_event: event
      }
    });
    return String(payload.verification_status || '').toUpperCase() === 'SUCCESS';
  }
}

const paypalClient = new PayPalClient();

module.exports = {
  PayPalClient,
  PayPalError,
  cleanEnvironment,
  cleanOrderId,
  readConfig,
  paypalClient
};
