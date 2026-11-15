const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extraEventAlertEmails,
  extraEventAlertIdempotencyKey
} = require('../src/lib/event-alert-recipients');

test('extra event alert recipients are opt-in and ignore empty separators', () => {
  for (const env of [{}, { EVENT_ADMIN_ALERT_EXTRA_EMAILS: '' }, { EVENT_ADMIN_ALERT_EXTRA_EMAILS: ' ,\n\r\n, ' }]) {
    assert.deepEqual(extraEventAlertEmails(env), []);
  }
});

test('extra event alert recipients normalize comma and newline lists and deduplicate', () => {
  assert.deepEqual(extraEventAlertEmails({
    EVENT_ADMIN_ALERT_EXTRA_EMAILS: ' First@Example.test , second+alerts@example.test\nFIRST@example.test\r\n third@example.test '
  }), ['first@example.test', 'second+alerts@example.test', 'third@example.test']);
});

test('invalid extra event alert addresses reject the list without exposing its contents', () => {
  for (const invalid of [
    'bad value@example.test', 'Name <person@example.test>', 'person@example',
    'person@@example.test', '@example.test', 'person@example.test;other@example.test',
    'person@example.test\u0000'
  ]) {
    assert.throws(() => extraEventAlertEmails({ EVENT_ADMIN_ALERT_EXTRA_EMAILS: `valid@example.test,${invalid}` }), error => {
      assert.match(error.message, /EVENT_ADMIN_ALERT_EXTRA_EMAILS/);
      assert.ok(!error.message.includes(invalid));
      assert.ok(!error.message.includes('valid@example.test'));
      return true;
    });
  }
});

test('extra event alert recipients cap distinct addresses at twenty after deduplication', () => {
  const addresses = Array.from({ length: 20 }, (_, index) => `review-${index}@example.test`);
  assert.deepEqual(extraEventAlertEmails({ EVENT_ADMIN_ALERT_EXTRA_EMAILS: [...addresses, ...addresses].join(',') }), addresses);
  assert.throws(() => extraEventAlertEmails({ EVENT_ADMIN_ALERT_EXTRA_EMAILS: [...addresses, 'overflow@example.test'].join(',') }), error => {
    assert.match(error.message, /EVENT_ADMIN_ALERT_EXTRA_EMAILS/);
    assert.ok(!error.message.includes('overflow@example.test'));
    return true;
  });
});

test('extra event alert delivery keys are stable, normalized and do not expose addresses', () => {
  const key = extraEventAlertIdempotencyKey(123, 'review@example.test');
  assert.equal(key, extraEventAlertIdempotencyKey('123', ' REVIEW@EXAMPLE.TEST '));
  assert.notEqual(key, extraEventAlertIdempotencyKey(124, 'review@example.test'));
  assert.notEqual(key, extraEventAlertIdempotencyKey(123, 'another@example.test'));
  assert.doesNotMatch(key, /review|example|@/i);
  assert.ok(key.length < 256, 'provider idempotency key stays bounded');
});
