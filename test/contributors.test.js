const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET ||= 'contributor-unit-test-session-secret';

const {
  APPROVAL_VERSION, FOLLOW_VERSION, MAX_CONTRIBUTORS, ContributorError,
  normalizeEmail, normalizeContributor, tokenHash, sealPayload, openPayload,
  ownerContributor, intakeDto, publicProfileDto
} = require('../src/lib/contributors');

test('contributor permissions are separate versioned disclosures, capped at three', () => {
  assert.equal(APPROVAL_VERSION, 'contributor-spotlight-v1');
  assert.equal(FOLLOW_VERSION, 'contributor-follow-v1');
  assert.notEqual(APPROVAL_VERSION, FOLLOW_VERSION);
  assert.equal(MAX_CONTRIBUTORS, 3);
});

test('contributor mailbox normalization cannot create a case or whitespace alias', () => {
  assert.equal(normalizeEmail('  Artist@Example.Test  '), 'artist@example.test');
  for (const email of ['', 'not-an-email', 'a@example.test\r\nBcc:other@example.test']) {
    assert.throws(() => normalizeEmail(email), error => error instanceof ContributorError && error.status === 400);
  }
});

test('contributor intake validates bounded names and roles and rejects active URL schemes', () => {
  const defaults = { name: 'Night Artist', role: 'DJ', email: 'artist@example.test' };
  const value = normalizeContributor({ ...defaults, name: '  Night   Artist  ', instagram_handle: '@night.artist', website_url: 'https://example.test/work' });
  assert.equal(value.name, 'Night Artist');
  assert.equal(value.instagramHandle, 'night.artist');
  assert.equal(value.websiteUrl, 'https://example.test/work');
  for (const body of [
    { name: '' }, { role: '' }, { name: 'x'.repeat(101) }, { role: 'x'.repeat(81) },
    { name: 'Bad\u0000Name' }, { website_url: 'javascript:alert(1)' }, { website_url: 'data:text/html,hello' }
  ]) {
    assert.throws(() => normalizeContributor({ ...defaults, ...body }), error => error instanceof ContributorError && error.status === 400);
  }
});

test('contributor invitation delivery payload encrypts its bearer and authenticates every byte', () => {
  const payload = { to: 'artist@example.test', intakeUrl: 'https://example.test/contributors/intake/a-secret-bearer', hostName: 'Heat Wave Booking' };
  const sealed = sealPayload(payload);
  assert.equal(sealed.includes(payload.to), false);
  assert.equal(sealed.includes('a-secret-bearer'), false);
  assert.deepEqual(openPayload(sealed), payload);
  assert.notEqual(sealPayload(payload), sealed, 'fresh authenticated encryption nonce per stored payload');
  const parts = sealed.split('.');
  const encrypted = Buffer.from(parts[2], 'base64url');
  encrypted[0] ^= 1;
  parts[2] = encrypted.toString('base64url');
  assert.throws(() => openPayload(parts.join('.')), 'tampered immutable retry payload must not be delivered');
  assert.match(tokenHash('bearer'), /^[a-f0-9]{64}$/);
  assert.notEqual(tokenHash('bearer'), tokenHash('Bearer'));
});

test('owner contributor DTO does not expose intake tokens or claim credentials', () => {
  const dto = ownerContributor({
    id: '5', name: 'Artist', email: 'artist@example.test', role: 'DJ', status: 'invited',
    selected: true, version: 1, slug: 'night-artist', token_hash: 'private-hash',
    invitation_payload: 'private-ciphertext', claim_payload: 'private-claim-ciphertext'
  });
  assert.equal(dto.id, 5);
  assert.equal(dto.profileUrl, null, 'no public staging page until its person approves');
  assert.doesNotMatch(JSON.stringify(dto), /private-|token_hash|invitation_payload|claim_payload/);
});

test('intake DTO is its own scoped approval view rather than an account or guest-list authorization', () => {
  const dto = intakeDto({ name: 'Artist', email: 'artist@example.test', role: 'DJ', host_name: 'Heat Wave Booking',
    event_title: 'A private night', status: 'approved', slug: 'night-artist', owner_user_id: 123,
    token_hash: 'secret-hash', invitation_payload: 'secret-ciphertext', venue_address: '9876 Private Address' });
  assert.equal(dto.approvalVersion, APPROVAL_VERSION);
  assert.equal(dto.email, 'artist@example.test');
  assert.equal(dto.profileUrl, '/people/night-artist');
  assert.doesNotMatch(JSON.stringify(dto), /9876 Private Address|owner_user_id|secret-|token_hash/);
});

test('public contributor DTO allowlists approved presentation and redacts private event and identity fields', () => {
  const dto = publicProfileDto({ id: 5, name: 'Artist', role: 'Photographer', photo_url: 'https://example.test/photo.jpg',
    instagram_handle: 'night.artist', website_url: 'https://example.test/work', slug: 'night-artist',
    email: 'private@example.test', owner_user_id: null, source_event_id: 100, event_title: 'A private night',
    venue_address: '9876 Private Address', token_hash: 'secret-hash' });
  assert.equal(dto.name, 'Artist');
  assert.equal(dto.claimed, false);
  assert.equal(dto.profileUrl, '/people/night-artist');
  assert.doesNotMatch(JSON.stringify(dto), /private@example|9876|A private night|source_event_id|owner_user_id|secret-hash/);
});

test('claimed contributor page defers to the existing public host identity', () => {
  const dto = publicProfileDto({ owner_user_id: 12, name: 'Staged artist', role: 'DJ', slug: 'stage-alias',
    photo_url: 'https://example.test/stage-photo.jpg', instagram_handle: 'stage.artist', website_url: 'https://example.test/stage',
    host_slug: 'existing-artist', host_public_name: 'Existing Artist Brand', host_logo: 'https://example.test/existing-photo.jpg',
    host_instagram: 'existing.artist', host_website: 'https://example.test/existing' });
  assert.deepEqual(dto, { name: 'Existing Artist Brand', role: 'DJ', photoUrl: 'https://example.test/existing-photo.jpg',
    instagramHandle: 'existing.artist', websiteUrl: 'https://example.test/existing', claimed: true, profileUrl: '/h/existing-artist' });
});
