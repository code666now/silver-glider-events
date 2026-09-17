const twilio = require('twilio');
const { normalizeE164 } = require('./sms');

const ACCOUNT_SID_RE = /^AC[0-9a-f]{32}$/i;
const VERIFY_SERVICE_SID_RE = /^VA[0-9a-f]{32}$/i;
const VERIFICATION_SID_RE = /^VE[0-9a-f]{32}$/i;

class PhoneVerificationError extends Error {
  constructor(message, {
    code = 'phone_verification_error',
    status = 502,
    providerCode = null,
    providerStatus = null
  } = {}) {
    super(message);
    this.name = 'PhoneVerificationError';
    this.code = code;
    this.status = status;
    this.providerCode = providerCode;
    this.providerStatus = providerStatus;
  }
}

function readConfig(env = process.env) {
  const accountSid = String(env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = String(env.TWILIO_AUTH_TOKEN || '').trim();
  const serviceSid = String(env.TWILIO_VERIFY_SERVICE_SID || '').trim();
  if (!ACCOUNT_SID_RE.test(accountSid) || !authToken || !VERIFY_SERVICE_SID_RE.test(serviceSid)) {
    throw new PhoneVerificationError('Phone verification is not configured', {
      code: 'phone_verification_not_configured',
      status: 503
    });
  }
  return { accountSid, authToken, serviceSid };
}

function cleanPhone(value) {
  try {
    return normalizeE164(value);
  } catch (_) {
    throw new PhoneVerificationError('Enter a valid mobile number', {
      code: 'invalid_phone',
      status: 400
    });
  }
}

function cleanProviderPhone(value) {
  try {
    return normalizeE164(value);
  } catch (_) {
    throw new PhoneVerificationError('Phone verification provider returned an invalid response', {
      code: 'phone_verification_invalid_provider_response',
      status: 502
    });
  }
}

function cleanVerificationSid(value) {
  const sid = String(value || '').trim();
  if (!VERIFICATION_SID_RE.test(sid)) {
    throw new PhoneVerificationError('Phone verification has expired. Request a new code.', {
      code: 'invalid_phone_verification',
      status: 400
    });
  }
  return sid;
}

function cleanCode(value) {
  const code = String(value || '').replace(/\s/g, '');
  if (!/^\d{4,10}$/.test(code)) {
    throw new PhoneVerificationError('Enter the verification code from your text message', {
      code: 'invalid_phone_verification_code',
      status: 400
    });
  }
  return code;
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function providerError(error, operation) {
  if (error instanceof PhoneVerificationError) return error;
  const providerStatus = numeric(error?.status) ?? numeric(error?.statusCode);
  const providerCode = numeric(error?.code);

  if (providerStatus === 401 || providerStatus === 403) {
    return new PhoneVerificationError('Phone verification is not configured', {
      code: 'phone_verification_not_configured',
      status: 503,
      providerCode,
      providerStatus
    });
  }
  if (providerStatus === 429) {
    return new PhoneVerificationError('Too many verification requests. Wait a few minutes and try again.', {
      code: 'phone_verification_rate_limited',
      status: 429,
      providerCode,
      providerStatus
    });
  }
  if (providerStatus != null && providerStatus >= 400 && providerStatus < 500) {
    return operation === 'check'
      ? new PhoneVerificationError('That verification code is invalid or expired', {
        code: 'invalid_phone_verification_code',
        status: 400,
        providerCode,
        providerStatus
      })
      : new PhoneVerificationError('That mobile number could not receive a verification code', {
        code: 'phone_verification_rejected',
        status: 422,
        providerCode,
        providerStatus
      });
  }
  return new PhoneVerificationError('Phone verification is temporarily unavailable', {
    code: 'phone_verification_unavailable',
    status: 502,
    providerCode,
    providerStatus
  });
}

function createPhoneVerificationService({
  env = process.env,
  clientFactory = (accountSid, authToken) => twilio(accountSid, authToken)
} = {}) {
  let client = null;

  function configuredClient() {
    const config = readConfig(env);
    if (!client) client = clientFactory(config.accountSid, config.authToken);
    return { client, config };
  }

  async function startVerification(phone) {
    const recipient = cleanPhone(phone);
    try {
      const { client: verifyClient, config } = configuredClient();
      const verification = await verifyClient.verify.v2
        .services(config.serviceSid)
        .verifications.create({ to: recipient, channel: 'sms' });
      const verificationSid = String(verification?.sid || '').trim();
      const returnedPhone = cleanProviderPhone(verification?.to);
      if (!VERIFICATION_SID_RE.test(verificationSid) || returnedPhone !== recipient) {
        throw new PhoneVerificationError('Phone verification provider returned an invalid response', {
          code: 'phone_verification_invalid_provider_response',
          status: 502
        });
      }
      return {
        verificationSid,
        phone: recipient,
        status: String(verification?.status || 'pending').slice(0, 40)
      };
    } catch (error) {
      throw providerError(error, 'start');
    }
  }

  async function checkVerification({ verificationSid, code } = {}) {
    const sid = cleanVerificationSid(verificationSid);
    const submittedCode = cleanCode(code);
    try {
      const { client: verifyClient, config } = configuredClient();
      const check = await verifyClient.verify.v2
        .services(config.serviceSid)
        .verificationChecks.create({ verificationSid: sid, code: submittedCode });
      const returnedSid = String(check?.sid || '').trim();
      const status = String(check?.status || '').trim().toLowerCase();
      // Twilio documents `status` as authoritative; `valid` is a legacy,
      // optional response field and may be omitted from otherwise valid checks.
      if (status !== 'approved') {
        throw new PhoneVerificationError('That verification code is invalid or expired', {
          code: 'invalid_phone_verification_code',
          status: 400
        });
      }
      if (returnedSid !== sid) {
        throw new PhoneVerificationError('Phone verification provider returned an invalid response', {
          code: 'phone_verification_invalid_provider_response',
          status: 502
        });
      }
      if (!check?.to) {
        throw new PhoneVerificationError('Phone verification provider returned an invalid response', {
          code: 'phone_verification_invalid_provider_response',
          status: 502
        });
      }
      const phone = cleanProviderPhone(check.to);
      return {
        approved: true,
        verificationSid: sid,
        phone,
        status: 'approved'
      };
    } catch (error) {
      throw providerError(error, 'check');
    }
  }

  return { startVerification, checkVerification };
}

const phoneVerificationService = createPhoneVerificationService();

module.exports = {
  PhoneVerificationError,
  checkVerification: input => phoneVerificationService.checkVerification(input),
  createPhoneVerificationService,
  readConfig,
  startVerification: phone => phoneVerificationService.startVerification(phone)
};
