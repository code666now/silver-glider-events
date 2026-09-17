const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PhoneVerificationError,
  createPhoneVerificationService,
  readConfig
} = require('../src/lib/phone-verification');

const validEnv = {
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'verify-test-auth-token',
  TWILIO_VERIFY_SERVICE_SID: `VA${'b'.repeat(32)}`
};
const verificationSid = `VE${'c'.repeat(32)}`;

function fakeService({ startResult, checkResult, startError, checkError } = {}) {
  const calls = [];
  const factoryCalls = [];
  const service = createPhoneVerificationService({
    env: validEnv,
    clientFactory: (accountSid, authToken) => {
      factoryCalls.push({ accountSid, authToken });
      return {
        verify: {
          v2: {
            services: serviceSid => ({
              verifications: {
                create: async payload => {
                  calls.push({ operation: 'start', serviceSid, payload });
                  if (startError) throw startError;
                  return startResult || {
                    sid: verificationSid,
                    to: '+14155551234',
                    status: 'pending'
                  };
                }
              },
              verificationChecks: {
                create: async payload => {
                  calls.push({ operation: 'check', serviceSid, payload });
                  if (checkError) throw checkError;
                  return checkResult || {
                    sid: verificationSid,
                    to: '+14155551234',
                    status: 'approved',
                    valid: true
                  };
                }
              }
            })
          }
        }
      };
    }
  });
  return { service, calls, factoryCalls };
}

test('Twilio Verify configuration requires valid Account and Verify Service SIDs', () => {
  assert.deepEqual(readConfig(validEnv), {
    accountSid: validEnv.TWILIO_ACCOUNT_SID,
    authToken: validEnv.TWILIO_AUTH_TOKEN,
    serviceSid: validEnv.TWILIO_VERIFY_SERVICE_SID
  });
  for (const env of [
    {},
    { ...validEnv, TWILIO_ACCOUNT_SID: 'not-an-account' },
    { ...validEnv, TWILIO_AUTH_TOKEN: '' },
    { ...validEnv, TWILIO_VERIFY_SERVICE_SID: `MG${'b'.repeat(32)}` }
  ]) {
    assert.throws(() => readConfig(env), error => {
      assert.equal(error instanceof PhoneVerificationError, true);
      assert.equal(error.code, 'phone_verification_not_configured');
      assert.equal(error.status, 503);
      assert.equal(error.message.includes(validEnv.TWILIO_AUTH_TOKEN), false);
      return true;
    });
  }
});

test('starts an SMS Verify challenge with a normalized phone and returns safe fields', async () => {
  const { service, calls, factoryCalls } = fakeService();
  const result = await service.startVerification('(415) 555-1234');

  assert.deepEqual(factoryCalls, [{
    accountSid: validEnv.TWILIO_ACCOUNT_SID,
    authToken: validEnv.TWILIO_AUTH_TOKEN
  }]);
  assert.deepEqual(calls, [{
    operation: 'start',
    serviceSid: validEnv.TWILIO_VERIFY_SERVICE_SID,
    payload: { to: '+14155551234', channel: 'sms' }
  }]);
  assert.deepEqual(result, {
    verificationSid,
    phone: '+14155551234',
    status: 'pending'
  });
  assert.equal(JSON.stringify(result).includes(validEnv.TWILIO_AUTH_TOKEN), false);
});

test('checks a browser-held Verify SID and accepts only an approved code', async () => {
  const { service, calls } = fakeService();
  const result = await service.checkVerification({ verificationSid, code: '123 456' });

  assert.deepEqual(calls, [{
    operation: 'check',
    serviceSid: validEnv.TWILIO_VERIFY_SERVICE_SID,
    payload: { verificationSid, code: '123456' }
  }]);
  assert.deepEqual(result, {
    approved: true,
    verificationSid,
    phone: '+14155551234',
    status: 'approved'
  });

  const pending = fakeService({
    checkResult: { sid: verificationSid, to: '+14155551234', status: 'pending', valid: false }
  });
  await assert.rejects(
    pending.service.checkVerification({ verificationSid, code: '123456' }),
    error => {
      assert.equal(error.code, 'invalid_phone_verification_code');
      assert.equal(error.status, 400);
      return true;
    }
  );
});

test('rejects malformed phones, verification SIDs, and codes before creating a client', async () => {
  let created = false;
  const service = createPhoneVerificationService({
    env: validEnv,
    clientFactory: () => {
      created = true;
      return {};
    }
  });
  await assert.rejects(service.startVerification('not-a-phone'), error => {
    assert.equal(error.code, 'invalid_phone');
    assert.equal(error.status, 400);
    return true;
  });
  await assert.rejects(service.checkVerification({ verificationSid: 'bad-sid', code: '123456' }), error => {
    assert.equal(error.code, 'invalid_phone_verification');
    assert.equal(error.status, 400);
    return true;
  });
  await assert.rejects(service.checkVerification({ verificationSid, code: '12ab' }), error => {
    assert.equal(error.code, 'invalid_phone_verification_code');
    assert.equal(error.status, 400);
    return true;
  });
  assert.equal(created, false);
});

test('configuration and provider errors are sanitized into stable public failures', async () => {
  let created = false;
  const missing = createPhoneVerificationService({
    env: {},
    clientFactory: () => {
      created = true;
      return {};
    }
  });
  await assert.rejects(missing.startVerification('+14155551234'), error => {
    assert.equal(error.code, 'phone_verification_not_configured');
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(created, false);

  const initializationFailure = createPhoneVerificationService({
    env: validEnv,
    clientFactory: () => {
      throw new Error(`could not initialize with ${validEnv.TWILIO_AUTH_TOKEN}`);
    }
  });
  await assert.rejects(initializationFailure.startVerification('+14155551234'), error => {
    assert.equal(error.code, 'phone_verification_unavailable');
    assert.equal(error.status, 502);
    assert.equal(error.message.includes(validEnv.TWILIO_AUTH_TOKEN), false);
    return true;
  });

  const secretError = {
    status: 400,
    code: 60200,
    message: `secret=${validEnv.TWILIO_AUTH_TOKEN}`
  };
  const rejected = fakeService({ startError: secretError });
  await assert.rejects(rejected.service.startVerification('+14155551234'), error => {
    assert.equal(error.code, 'phone_verification_rejected');
    assert.equal(error.status, 422);
    assert.equal(error.providerCode, 60200);
    assert.equal(error.providerStatus, 400);
    assert.equal(error.message.includes(validEnv.TWILIO_AUTH_TOKEN), false);
    return true;
  });

  const expired = fakeService({ checkError: { ...secretError, status: 404, code: 20404 } });
  await assert.rejects(
    expired.service.checkVerification({ verificationSid, code: '123456' }),
    error => {
      assert.equal(error.code, 'invalid_phone_verification_code');
      assert.equal(error.status, 400);
      assert.equal(error.message.includes(validEnv.TWILIO_AUTH_TOKEN), false);
      return true;
    }
  );

  const limited = fakeService({ startError: { status: 429, code: 20429 } });
  await assert.rejects(limited.service.startVerification('+14155551234'), error => {
    assert.equal(error.code, 'phone_verification_rate_limited');
    assert.equal(error.status, 429);
    return true;
  });
});

test('malformed and mismatched provider responses never become verified', async () => {
  const invalidStart = fakeService({
    startResult: { sid: 'bad-sid', to: '+14155551234', status: 'pending' }
  });
  await assert.rejects(invalidStart.service.startVerification('+14155551234'), error => {
    assert.equal(error.code, 'phone_verification_invalid_provider_response');
    assert.equal(error.status, 502);
    return true;
  });

  const missingPhone = fakeService({
    startResult: { sid: verificationSid, status: 'pending' }
  });
  await assert.rejects(missingPhone.service.startVerification('+14155551234'), error => {
    assert.equal(error.code, 'phone_verification_invalid_provider_response');
    assert.equal(error.status, 502);
    return true;
  });

  const mismatch = fakeService({
    checkResult: {
      sid: `VE${'d'.repeat(32)}`,
      to: '+14155551234',
      status: 'approved',
      valid: true
    }
  });
  await assert.rejects(
    mismatch.service.checkVerification({ verificationSid, code: '123456' }),
    error => {
      assert.equal(error.code, 'phone_verification_invalid_provider_response');
      assert.equal(error.status, 502);
      return true;
    }
  );

  const missingCheckPhone = fakeService({
    checkResult: { sid: verificationSid, status: 'approved' }
  });
  await assert.rejects(
    missingCheckPhone.service.checkVerification({ verificationSid, code: '123456' }),
    error => {
      assert.equal(error.code, 'phone_verification_invalid_provider_response');
      assert.equal(error.status, 502);
      return true;
    }
  );

  const legacyValidOmitted = fakeService({
    checkResult: {
      sid: verificationSid,
      to: '+14155551234',
      status: 'approved'
    }
  });
  assert.equal((await legacyValidOmitted.service.checkVerification({
    verificationSid,
    code: '123456'
  })).approved, true);
});
