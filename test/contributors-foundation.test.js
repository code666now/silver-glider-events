const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.SESSION_SECRET ||= 'contributors-unit-test-secret-not-production';
const {
  APPROVAL_VERSION, APPROVAL_TEXT, FOLLOW_VERSION, MAX_CONTRIBUTORS,
  normalizeEmail, normalizeContributor, tokenHash, sealPayload, openPayload,
  intakeDto, ownerContributor, publicProfileDto, contributorSpotlightsStillApproved,
  loadApprovedContributorSpotlights, loadPublicProfile
} = require('../src/lib/contributors');

test('contributor input normalizes email, first-party display text, and optional links', () => {
  assert.deepEqual(normalizeContributor({ name: '  Heat   Wave ', role: ' DJ ', email: ' ARTIST@Example.Test ',
    instagram_handle: '@Night.Work', website_url: 'example.test/work' }), {
    name: 'Heat Wave', role: 'DJ', email: 'artist@example.test', instagramHandle: 'night.work', websiteUrl: 'https://example.test/work'
  });
  assert.equal(normalizeEmail(' A@B.test '), 'a@b.test');
});

test('contributor details reject absent/oversized identity and executable URL schemes', () => {
  for (const body of [
    { name: '', role: 'DJ', email: 'a@b.test' },
    { name: 'Name', role: 'x'.repeat(81), email: 'a@b.test' },
    { name: 'Name', role: 'DJ', email: 'not an email' },
    { name: 'Name', role: 'DJ', email: 'a@b.test', website_url: 'javascript://bad' },
    { name: 'Name', role: 'DJ', email: 'a@b.test', website_url: 'https://user:pass@example.test' }
  ]) assert.throws(() => normalizeContributor(body), error => error.status === 400);
});

test('invitation delivery stores only opaque authenticated encrypted bearer payloads', () => {
  const payload = { to: 'person@example.test', intakeUrl: 'https://example.test/contributors/intake/private-token' };
  const sealed = sealPayload(payload);
  assert.doesNotMatch(sealed, /person|private-token/);
  assert.deepEqual(openPayload(sealed), payload);
  assert.notEqual(sealPayload(payload), sealed, 'fresh IV prevents deterministic ciphertext');
  const parts = sealed.split('.');
  const tampered = Buffer.from(parts[2], 'base64url');
  tampered[0] ^= 1;
  parts[2] = tampered.toString('base64url');
  assert.throws(() => openPayload(parts.join('.')), 'tampered payload fails closed');
  assert.match(tokenHash('token'), /^[a-f0-9]{64}$/);
});

test('intake DTO contains honest dynamic host branding and exact approval disclosure, never private event location', () => {
  const dto = intakeDto({ name: 'Keith', role: 'DJ', email: 'artist@example.test',
    host_name: 'Heat Wave Booking', event_title: 'Private Night', venue_address: 'Never expose',
    token_hash: 'hash', slug: 'keith-ab', status: 'invited', owner_user_id: null });
  assert.equal(dto.hostName, 'Heat Wave Booking');
  assert.equal(dto.approvalVersion, APPROVAL_VERSION);
  assert.equal(dto.approvalText, APPROVAL_TEXT);
  assert.doesNotMatch(JSON.stringify(dto), /Never expose|token_hash/);
  assert.equal(dto.profileUrl, null);
});

test('owner list cannot reveal invitation bearer links or expose unapproved public profile paths', () => {
  const dto = ownerContributor({ id: '8', name: 'Keith', email: 'k@example.test', role: 'DJ', status: 'invited',
    selected: true, version: 1, slug: 'keith-ab', token_hash: 'privatehash', invitation_payload: 'encrypted' });
  assert.equal(dto.id, 8);
  assert.equal(dto.profileUrl, null);
  assert.doesNotMatch(JSON.stringify(dto), /privatehash|encrypted|token/);
});

test('public contributor DTO omits email, account identifiers, event and guest-list provenance', () => {
  const dto = publicProfileDto({ name: 'Keith', role: 'DJ', slug: 'keith-ab', owner_user_id: null,
    email: 'private@example.test', event_title: 'Private event', source_event_id: 1, id: 3 });
  assert.deepEqual(dto, { name: 'Keith', role: 'DJ', photoUrl: undefined, instagramHandle: undefined,
    websiteUrl: undefined, claimed: false, profileUrl: '/people/keith-ab' });
  assert.doesNotMatch(JSON.stringify(dto), /private@example|Private event|source_event|owner_user/);
});

test('claimed profile public branding reuses existing Host Page without silently replacing it with intake values', () => {
  const dto = publicProfileDto({ name: 'intake name', role: 'Artist', slug: 'artist-a', owner_user_id: 8,
    photo_url: 'intake-photo', instagram_handle: 'intakeinstagram', website_url: 'https://intake.test',
    host_public_name: 'Existing Collective', host_slug: 'existing', host_logo: 'existing-logo',
    host_instagram: 'existinginstagram', host_website: 'https://existing.test' });
  assert.equal(dto.name, 'Existing Collective');
  assert.equal(dto.photoUrl, 'existing-logo');
  assert.equal(dto.profileUrl, '/h/existing');
  assert.equal(dto.websiteUrl, 'https://existing.test');
});

test('frozen thank-you spotlights fail closed after approval revision or withdrawal', async () => {
  const db = { query: async () => ({ rows: [{ id: '2', profile_id: '7', name: 'Keith', role: 'DJ',
    slug: 'keith-a', approval_version: APPROVAL_VERSION, version: 3 }] }) };
  assert.equal(await contributorSpotlightsStillApproved(db, { eventId: 1, organizerId: 5,
    spotlights: [{ id: 2, profileId: 7, approvalVersion: `${APPROVAL_VERSION}:3` }] }), true);
  assert.equal(await contributorSpotlightsStillApproved(db, { eventId: 1, organizerId: 5,
    spotlights: [{ id: 2, profileId: 7, approvalVersion: `${APPROVAL_VERSION}:2` }] }), false);
  assert.equal(await contributorSpotlightsStillApproved({ query: async () => ({ rows: [] }) },
    { eventId: 1, organizerId: 5, spotlights: [{ id: 2, profileId: 7, approvalVersion: `${APPROVAL_VERSION}:3` }] }), false);
});

test('approved spotlight links carry opaque public introduction attribution, never private event identifiers', async () => {
  const ref = 'abcdef0123456789abcdef01';
  const spotlights = await loadApprovedContributorSpotlights({ query: async () => ({ rows: [{ id: '4', profile_id: '9',
    name: 'Keith', role: 'DJ', slug: 'keith-ab', public_ref: ref, event_id: 987,
    approval_version: APPROVAL_VERSION, version: 2 }] }) }, { eventId: 987, organizerId: 3 });
  assert.equal(spotlights[0].profileUrl, `/people/keith-ab?intro=${ref}`);
  assert.doesNotMatch(spotlights[0].profileUrl, /987|eventId|token/);
});

test('direct public profile visits invent no event attribution and opaque refs require the same approved profile', async () => {
  const calls = [];
  const db = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: calls.length % 2 === 0 ? [{ event_id: 88 }] : [{ id: 7, slug: 'keith-a', owner_user_id: null }] };
  } };
  const direct = await loadPublicProfile(db, 'keith-a');
  assert.equal(direct.source_event_id, null);
  assert.equal(calls.length, 1);
  calls.length = 0;
  const attributed = await loadPublicProfile(db, 'keith-a', 'abcdef0123456789abcdef01');
  assert.equal(attributed.source_event_id, 88);
  assert.deepEqual(calls[1].params, ['abcdef0123456789abcdef01', 7]);
  assert.match(calls[1].sql, /c\.profile_id=\$2/);
  assert.match(calls[1].sql, /c\.status='approved'/);
  assert.match(calls[1].sql, /c\.revoked_at IS NULL/);
  await assert.rejects(() => loadPublicProfile({ query: async () => ({ rows: [{ id: 7 }] }) }, 'keith-a', 'private-event-id'),
    error => error.status === 404);
});

test('the contributor migration adds scoped records without changing RSVP or existing messaging consent', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../src/db/migrations/076_event_contributors.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE contributor_profiles/);
  assert.match(migration, /CREATE TABLE event_contributors/);
  assert.match(migration, /CREATE TABLE contributor_follow_intents/);
  assert.match(migration, /approval_text TEXT/);
  assert.doesNotMatch(migration, /(?:UPDATE|ALTER TABLE)\s+(?:rsvps|host_follows|organizers|users)\b/i);
  assert.equal(MAX_CONTRIBUTORS, 3);
  assert.equal(FOLLOW_VERSION, 'contributor-follow-v1');
});

test('contributor upload grants authorize before buffering and never update account or Host Page photos', () => {
  const routes = fs.readFileSync(path.join(__dirname, '../src/routes/contributors.js'), 'utf8');
  assert.match(routes, /mutation, intakePhotoScope, readPhoto/);
  assert.match(routes, /normalizeRequestImages/);
  assert.match(routes, /limits: \{ fileSize: 5 \* 1024 \* 1024/);
  assert.doesNotMatch(routes, /UPDATE organizers|uploadAccountAvatar|uploadHostLogo/);
});
