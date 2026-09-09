const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  TEST_SMS_BODY,
  SmsDeliveryError,
  normalizeE164,
  createSmsService
} = require('../src/lib/sms');

const validEnv = {
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'test-auth-token',
  TWILIO_MESSAGING_SERVICE_SID: `MG${'b'.repeat(32)}`
};

function fakeService({ result, error } = {}) {
  const calls = [];
  const factoryCalls = [];
  const service = createSmsService({
    env: validEnv,
    clientFactory: (accountSid, authToken) => {
      factoryCalls.push({ accountSid, authToken });
      return {
        messages: {
          create: async payload => {
            calls.push(payload);
            if (error) throw error;
            return result || { sid: `SM${'c'.repeat(32)}`, status: 'accepted' };
          }
        }
      };
    }
  });
  return { service, calls, factoryCalls };
}

test('SMS destinations normalize common US input and retain explicit E.164 numbers', () => {
  assert.equal(normalizeE164('(415) 555-1234'), '+14155551234');
  assert.equal(normalizeE164('1-415-555-1234'), '+14155551234');
  assert.equal(normalizeE164('+44 20 7946 0958'), '+442079460958');
});

test('SMS destinations reject ambiguous, extended, and malformed numbers before delivery', () => {
  for (const value of ['', '020 7946 0958', '+0123456789', '+1 415 555 1234 ext 2', 'not-a-phone']) {
    assert.throws(() => normalizeE164(value), error => {
      assert.equal(error instanceof SmsDeliveryError, true);
      assert.equal(error.code, 'invalid_recipient');
      assert.equal(error.status, 400);
      return true;
    });
  }
});

test('server SMS transport uses the Messaging Service and returns only safe delivery fields', async () => {
  const { service, calls, factoryCalls } = fakeService();
  const result = await service.sendSms({ to: '(415) 555-1234', body: 'Server-generated lifecycle message' });

  assert.deepEqual(factoryCalls, [{
    accountSid: validEnv.TWILIO_ACCOUNT_SID,
    authToken: validEnv.TWILIO_AUTH_TOKEN
  }]);
  assert.deepEqual(calls, [{
    to: '+14155551234',
    body: 'Server-generated lifecycle message',
    messagingServiceSid: validEnv.TWILIO_MESSAGING_SERVICE_SID
  }]);
  assert.deepEqual(result, {
    sid: `SM${'c'.repeat(32)}`,
    status: 'accepted',
    recipient: '+14155551234'
  });
  assert.equal(JSON.stringify(result).includes(validEnv.TWILIO_AUTH_TOKEN), false);
  assert.equal(Object.hasOwn(calls[0], 'from'), false);
});

test('test sender always uses the approved fixed message', async () => {
  const { service, calls } = fakeService();
  await service.sendTestSms('+14155551234');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, TEST_SMS_BODY);
  assert.equal(TEST_SMS_BODY, 'Heatwave Booking: The Mummies play tomorrow at Make Out Room. Details: https://silvergliderevents.com');
});

test('missing credentials fail cleanly before a Twilio client is created', async () => {
  let created = false;
  const service = createSmsService({
    env: {},
    clientFactory: () => {
      created = true;
      return {};
    }
  });
  await assert.rejects(service.sendTestSms('+14155551234'), error => {
    assert.equal(error.code, 'sms_not_configured');
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(created, false);
});

test('Twilio errors are reduced to non-secret provider details', async () => {
  const { service } = fakeService({
    error: {
      status: 400,
      code: 21614,
      message: `secret=${validEnv.TWILIO_AUTH_TOKEN}`,
      moreInfo: 'https://www.twilio.com/docs/api/errors/21614'
    }
  });
  await assert.rejects(service.sendTestSms('+14155551234'), error => {
    assert.equal(error instanceof SmsDeliveryError, true);
    assert.equal(error.code, 'sms_rejected');
    assert.equal(error.status, 422);
    assert.equal(error.providerCode, 21614);
    assert.equal(error.message.includes(validEnv.TWILIO_AUTH_TOKEN), false);
    return true;
  });
});

test('Twilio client initialization failures are sanitized too', async () => {
  const service = createSmsService({
    env: validEnv,
    clientFactory: () => {
      throw new Error(`could not initialize with ${validEnv.TWILIO_AUTH_TOKEN}`);
    }
  });
  await assert.rejects(service.sendTestSms('+14155551234'), error => {
    assert.equal(error instanceof SmsDeliveryError, true);
    assert.equal(error.code, 'sms_provider_unavailable');
    assert.equal(error.status, 502);
    assert.equal(error.message.includes(validEnv.TWILIO_AUTH_TOKEN), false);
    return true;
  });
});

test('admin test endpoint is protected, confirmed, fixed-message only, and rate limited', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin.js'), 'utf8');
  const publicFiles = [
    ...fs.readdirSync(path.join(__dirname, '..', 'public', 'js')).map(name => path.join(__dirname, '..', 'public', 'js', name)),
    ...fs.readdirSync(path.join(__dirname, '..', 'public', 'css')).map(name => path.join(__dirname, '..', 'public', 'css', name))
  ].filter(file => fs.statSync(file).isFile());

  assert.match(route, /router\.use\('\/api\/admin', requireAdmin\)/);
  assert.match(route, /router\.post\('\/api\/admin\/sms\/test'/);
  assert.match(route, /req\.body\?\.confirm !== 'SEND_TEST_SMS'/);
  assert.match(route, /sms\.sendTestSms\(recipient\)/);
  assert.match(route, /smsTestLimiter\.consume/);
  assert.doesNotMatch(route, /req\.body\?\.(?:body|message)/);
  for (const file of publicFiles) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /TWILIO_(?:ACCOUNT_SID|AUTH_TOKEN|MESSAGING_SERVICE_SID)/);
  }
});
