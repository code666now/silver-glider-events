const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { campaignConfig, identityKey, isWelcomeSmsDestination, WELCOME_CREDITS } = require('../src/lib/sms-welcome');

test('welcome campaign has an independent kill switch and a bounded claim cap', () => {
  assert.deepEqual(campaignConfig({}), { enabled: true, claimCap: 200 });
  assert.deepEqual(campaignConfig({ SMS_WELCOME_ENABLED: 'false', SMS_WELCOME_CLAIM_CAP: '0' }), { enabled: false, claimCap: 0 });
  assert.equal(campaignConfig({ SMS_WELCOME_ENABLED: ' OFF ' }).enabled, false);
  assert.equal(campaignConfig({ SMS_WELCOME_CLAIM_CAP: '-1' }).claimCap, 200);
  assert.equal(campaignConfig({ SMS_WELCOME_CLAIM_CAP: 'infinity' }).claimCap, 200);
  assert.equal(campaignConfig({ SMS_WELCOME_CLAIM_CAP: '42' }).claimCap, 42);
  assert.equal(WELCOME_CREDITS, 50);
});

test('welcome destination uses country metadata rather than treating all +1 numbers as US', () => {
  assert.equal(isWelcomeSmsDestination('+14155552671'), true);
  assert.equal(isWelcomeSmsDestination('+12025550123'), true);
  assert.equal(isWelcomeSmsDestination('+14165550123'), false); // Canada
  assert.equal(isWelcomeSmsDestination('+12425550123'), false); // Bahamas
  assert.equal(isWelcomeSmsDestination('+442079460123'), false);
  assert.equal(isWelcomeSmsDestination('not a number'), false);
  assert.equal(isWelcomeSmsDestination('+1'), false);
});

test('anti-reclaim identity keys are stable keyed hashes with separated identity domains', () => {
  const secret = 'durable-campaign-test-secret';
  const key = identityKey(secret, 'phone', '+14155552671');
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key, identityKey(secret, 'phone', '+14155552671'));
  assert.notEqual(key, identityKey('different-secret', 'phone', '+14155552671'));
  assert.notEqual(key, identityKey(secret, 'email', '+14155552671'));
  assert.ok(!key.includes('4155552671'));
});

test('welcome schema keeps minimal claims across deletion and no raw contact fields', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/migrations/078_sms_welcome.sql'), 'utf8');
  assert.match(schema, /organizer_id INT REFERENCES organizers\(id\) ON DELETE SET NULL/);
  assert.match(schema, /UNIQUE \(campaign_key, account_key\)/);
  assert.match(schema, /UNIQUE \(campaign_key, phone_key\)/);
  assert.match(schema, /UNIQUE \(campaign_key, email_key\)/);
  assert.doesNotMatch(schema, /(?:email|phone)(?:_address|_number)? TEXT/);
});
