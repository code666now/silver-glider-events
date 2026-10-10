const test = require('node:test');
const assert = require('node:assert/strict');

const { openSecret, sealSecret } = require('../src/lib/sealed-secret');

test('durable secrets round-trip only with the same purpose and application secret', () => {
  const originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'sealed-secret-test-key';
  try {
    const envelope = sealSecret('one-time-claim-token', 'welcome:1');
    assert.notEqual(envelope, 'one-time-claim-token');
    assert.equal(openSecret(envelope, 'welcome:1'), 'one-time-claim-token');
    assert.throws(() => openSecret(envelope, 'welcome:2'), /could not be opened/);
    process.env.SESSION_SECRET = 'different-test-key';
    assert.throws(() => openSecret(envelope, 'welcome:1'), /could not be opened/);
  } finally {
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
  }
});

test('durable secrets reject malformed or incomplete input', () => {
  const originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'sealed-secret-test-key';
  try {
    assert.throws(() => sealSecret('', 'welcome:1'), /value is required/);
    assert.throws(() => sealSecret('token', ''), /purpose is required/);
    assert.throws(() => openSecret('not-an-envelope', 'welcome:1'), /envelope is invalid/);
  } finally {
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
  }
});
