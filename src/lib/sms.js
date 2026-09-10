const twilio = require('twilio');

const TEST_SMS_BODY = 'Heatwave Booking: The Mummies play tomorrow at Make Out Room. Details: https://silvergliderevents.com';
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

class SmsDeliveryError extends Error {
  constructor(message, {
    code = 'sms_error',
    status = 502,
    providerCode = null,
    providerStatus = null
  } = {}) {
    super(message);
    this.name = 'SmsDeliveryError';
    this.code = code;
    this.status = status;
    this.providerCode = providerCode;
    this.providerStatus = providerStatus;
  }
}

function normalizeE164(value) {
  const input = String(value || '').trim();
  if (!input) {
    throw new SmsDeliveryError('Enter a destination phone number', {
      code: 'invalid_recipient',
      status: 400
    });
  }

  // Ignore familiar US display punctuation, but reject letters, extensions,
  // and ambiguous international numbers instead of guessing a country.
  const compact = input.replace(/[\s().-]/g, '');
  let normalized = compact;
  if (/^\d{10}$/.test(compact)) normalized = `+1${compact}`;
  else if (/^1\d{10}$/.test(compact)) normalized = `+${compact}`;

  if (!E164_PATTERN.test(normalized)) {
    throw new SmsDeliveryError('Use a valid E.164 phone number, including + and country code', {
      code: 'invalid_recipient',
      status: 400
    });
  }
  return normalized;
}

function readConfig(env) {
  const accountSid = String(env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = String(env.TWILIO_AUTH_TOKEN || '').trim();
  const messagingServiceSid = String(env.TWILIO_MESSAGING_SERVICE_SID || '').trim();
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid) || !authToken || !/^MG[0-9a-f]{32}$/i.test(messagingServiceSid)) {
    throw new SmsDeliveryError('SMS sending is not configured', {
      code: 'sms_not_configured',
      status: 503
    });
  }
  return { accountSid, authToken, messagingServiceSid };
}

function providerError(error) {
  const providerStatus = Number.isInteger(Number(error?.status)) ? Number(error.status) : null;
  const numericProviderCode = Number(error?.code);
  const providerCode = Number.isInteger(numericProviderCode) ? numericProviderCode : null;

  if (providerStatus === 401 || providerStatus === 403) {
    return new SmsDeliveryError('SMS provider authentication failed', {
      code: 'sms_provider_auth_failed',
      status: 503,
      providerCode,
      providerStatus
    });
  }
  if (providerStatus === 400 || (providerCode && providerCode >= 21000 && providerCode < 22000)) {
    return new SmsDeliveryError('Twilio rejected the destination or message', {
      code: 'sms_rejected',
      status: 422,
      providerCode,
      providerStatus
    });
  }
  return new SmsDeliveryError('SMS provider is temporarily unavailable', {
    code: 'sms_provider_unavailable',
    status: 502,
    providerCode,
    providerStatus
  });
}

function createSmsService({
  env = process.env,
  clientFactory = (accountSid, authToken) => twilio(accountSid, authToken)
} = {}) {
  let client = null;

  async function sendSms({ to, body, statusCallback }) {
    const recipient = normalizeE164(to);
    const messageBody = String(body || '').trim();
    if (!messageBody || messageBody.length > 1600) {
      throw new SmsDeliveryError('SMS message must be between 1 and 1600 characters', {
        code: 'invalid_message',
        status: 400
      });
    }

    const config = readConfig(env);
    try {
      if (!client) client = clientFactory(config.accountSid, config.authToken);
      const payload = {
        to: recipient,
        body: messageBody,
        messagingServiceSid: config.messagingServiceSid
      };
      if (statusCallback) payload.statusCallback = String(statusCallback);
      const message = await client.messages.create(payload);
      const sid = String(message?.sid || '').trim();
      if (!/^(SM|MM)[0-9a-f]{32}$/i.test(sid)) {
        throw new SmsDeliveryError('SMS provider returned an invalid response', {
          code: 'sms_invalid_provider_response',
          status: 502
        });
      }
      return {
        sid,
        status: String(message?.status || 'accepted').slice(0, 40),
        recipient
      };
    } catch (error) {
      if (error instanceof SmsDeliveryError) throw error;
      throw providerError(error);
    }
  }

  return {
    sendSms,
    sendTestSms: to => sendSms({ to, body: TEST_SMS_BODY })
  };
}

const smsService = createSmsService();

module.exports = {
  TEST_SMS_BODY,
  SmsDeliveryError,
  normalizeE164,
  createSmsService,
  sendSms: input => smsService.sendSms(input),
  sendTestSms: to => smsService.sendTestSms(to)
};
