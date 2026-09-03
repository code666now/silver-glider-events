class CommerceClientError extends Error {
  constructor(message, { code = 'commerce_error', status = 502 } = {}) {
    super(message);
    this.name = 'CommerceClientError';
    this.code = code;
    this.status = status;
  }
}

class CommerceClient {
  constructor({
    baseUrl = process.env.COMMERCE_API_BASE_URL,
    apiKey = process.env.COMMERCE_API_KEY,
    timeoutMs = process.env.COMMERCE_REQUEST_TIMEOUT_MS,
    fetchImpl = globalThis.fetch
  } = {}) {
    this.baseUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
    this.apiKey = String(apiKey || '').trim();
    this.timeoutMs = Math.min(15000, Math.max(1000, Number(timeoutMs) || 5000));
    this.fetchImpl = fetchImpl;
  }

  isConfigured() {
    if (!this.baseUrl || !this.apiKey || typeof this.fetchImpl !== 'function') return false;
    try {
      return ['http:', 'https:'].includes(new URL(this.baseUrl).protocol);
    } catch (_) {
      return false;
    }
  }

  async request(path, { method = 'GET', body, idempotencyKey, headers = {} } = {}) {
    if (!this.isConfigured()) {
      throw new CommerceClientError('Commerce is not configured', {
        code: 'commerce_not_configured',
        status: 503
      });
    }

    const base = new URL(`${this.baseUrl}/`);
    const destination = new URL(String(path || '').replace(/^\/+/, ''), base);
    if (destination.origin !== base.origin) {
      throw new CommerceClientError('Invalid Commerce destination', {
        code: 'invalid_commerce_destination',
        status: 500
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(destination, {
        method,
        signal: controller.signal,
        headers: {
          ...headers,
          Accept: 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new CommerceClientError('Commerce request failed', {
          code: 'commerce_request_failed',
          status: response.status >= 500 ? 502 : response.status
        });
      }
      return payload;
    } catch (err) {
      if (err instanceof CommerceClientError) throw err;
      if (err?.name === 'AbortError') {
        throw new CommerceClientError('Commerce request timed out', {
          code: 'commerce_timeout',
          status: 504
        });
      }
      throw new CommerceClientError('Commerce is temporarily unavailable', {
        code: 'commerce_unavailable',
        status: 502
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

const commerceClient = new CommerceClient();

function commerceAdmissionEnabled() {
  return process.env.COMMERCE_ENABLED === 'true' && commerceClient.isConfigured();
}

module.exports = { CommerceClient, CommerceClientError, commerceAdmissionEnabled, commerceClient };
