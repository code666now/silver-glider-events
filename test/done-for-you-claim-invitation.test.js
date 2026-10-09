const test = require('node:test');
const assert = require('node:assert/strict');

const {
  _test: { selectClaimedAccountWelcomeIdentity }
} = require('../src/lib/done-for-you-claim-invitation');

function email(normalizedValue, {
  scope = 'unverified',
  verified = false,
  primary = false
} = {}) {
  return {
    normalized_value: normalizedValue,
    verification_scope: scope,
    verified_at: verified ? new Date('2026-10-09T00:00:00Z') : null,
    is_primary: primary
  };
}

test('claimed-account welcomes prefer the exact verified email', () => {
  const exact = email('submitted@example.test', { scope: 'account', verified: true });
  const primary = email('primary@example.test', {
    scope: 'account', verified: true, primary: true
  });
  assert.equal(
    selectClaimedAccountWelcomeIdentity([primary, exact], 'submitted@example.test'),
    exact
  );
});

test('claimed-account welcomes fall back only to a verified primary email', () => {
  const submitted = email('submitted@example.test');
  const verifiedNonPrimary = email('secondary@example.test', {
    scope: 'account', verified: true
  });
  const verifiedPrimary = email('primary@example.test', {
    scope: 'account', verified: true, primary: true
  });
  assert.equal(
    selectClaimedAccountWelcomeIdentity(
      [submitted, verifiedNonPrimary, verifiedPrimary],
      'submitted@example.test'
    ),
    verifiedPrimary
  );
  assert.equal(
    selectClaimedAccountWelcomeIdentity(
      [submitted, verifiedNonPrimary],
      'submitted@example.test'
    ),
    null
  );
  assert.equal(
    selectClaimedAccountWelcomeIdentity(
      [email('primary@example.test', { primary: true })],
      'submitted@example.test'
    ),
    null
  );
});
