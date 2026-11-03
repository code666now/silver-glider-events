const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeThankYouCredits, ThankYouCreditsError } = require('../src/lib/thank-you-credits');
const { defaultThankYouCredits, effectiveThankYouCredits, normalizeDraft, draftDigest,
  emailRenderSnapshot, serializeThankYou } = require('../src/lib/post-event');

test('simple credits normalize names, optional roles and Instagram profiles without carrying identity or account fields', () => {
  assert.deepEqual(normalizeThankYouCredits([{ name: '  DJ   Love ', role: ' Vinyl DJ ',
    instagramHandle: 'https://www.instagram.com/DJ.Love/?igsh=tracking', email: 'never@example.test',
    profileId: 7, photoUrl: 'https://example.test/photo.jpg', profileUrl: '/people/private' }]), [
    { name: 'DJ Love', role: 'Vinyl DJ', instagramHandle: 'dj.love' }
  ]);
  assert.deepEqual(normalizeThankYouCredits([{ name: 'Ramon' }]), [{ name: 'Ramon', role: '', instagramHandle: null }]);
  assert.deepEqual(normalizeThankYouCredits([]), []);
});

test('simple credit Instagram inputs reject credential URLs, explicit ports, non-Instagram schemes and media links', () => {
  for (const instagramHandle of [
    'https://user:password@instagram.com/person', 'https://instagram.com:443/person',
    'https://instagram.com:8443/person', 'https://instagram.com.attacker.test/person',
    'https://attacker.test/instagram.com/person', 'javascript:alert(1)',
    'https://instagram.com/p/123', 'https://instagram.com/reel/abc', 'https://instagram.com/stories',
    'bad..name', 'bad/name', '@<script>', 'accounts', '@accounts', '@p', 'reel',
    '@REELS', 'tv', 'stories', '@explore', 'direct'
  ]) assert.throws(() => normalizeThankYouCredits([{ name: 'Person', instagramHandle }]),
    error => error instanceof ThankYouCreditsError && error.code === 'invalid_credits', instagramHandle);
});

test('simple credits enforce three bounded named rows and permit an optional blank role or Instagram', () => {
  for (const value of [null, {}, [null], [{ name: '' }], [{ name: 44 }], [{ name: {} }],
    [{ name: 'x'.repeat(101) }], [{ name: 'Name', role: 'x'.repeat(81) }],
    [{ name: 'Name', instagramHandle: {} }], Array.from({ length: 4 }, () => ({ name: 'Name' }))]) {
    assert.throws(() => normalizeThankYouCredits(value), error => error instanceof ThankYouCreditsError);
  }
  assert.equal(normalizeThankYouCredits([{ name: 'x'.repeat(100), role: 'x'.repeat(80), instagramHandle: '@A_Valid.Name' }])[0].instagramHandle, 'a_valid.name');
});

test('credit prefills use only this event’s Event Vibe names, never music URLs, account contacts or designer Instagram', () => {
  const event = { event_vibe_label: 'DJ Love', event_vibe_label_2: 'Ramon', event_vibe_label_3: '',
    event_vibe_url: 'https://soundcloud.com/someone', flyer_designer_name: 'Other Person',
    flyer_designer_instagram_handle: 'other.person', organizer_email: 'private@example.test',
    contributors: [{ name: 'Other Event Artist', instagramHandle: 'not.this.event' }] };
  assert.deepEqual(defaultThankYouCredits(event), [
    { name: 'DJ Love', role: '', instagramHandle: null }, { name: 'Ramon', role: '', instagramHandle: null }
  ]);
  assert.deepEqual(effectiveThankYouCredits({ credits: null }, event), defaultThankYouCredits(event));
  assert.deepEqual(effectiveThankYouCredits({}, event), defaultThankYouCredits(event));
  assert.deepEqual(effectiveThankYouCredits({ credits: [] }, event), [], 'explicit clearing is never re-prefilled');
});

test('legacy draft normalization and digests remain unchanged unless credits are explicitly carried', () => {
  const input = { subject: ' Thanks ', message: 'Hi\r\nthere', includeFollow: true };
  assert.deepEqual(normalizeDraft(input), { subject: 'Thanks', message: 'Hi\nthere', includeFollow: true });
  assert.equal(draftDigest(input), crypto.createHash('sha256').update(JSON.stringify(['Thanks', 'Hi\nthere', true])).digest('hex'));
  assert.notEqual(draftDigest({ ...input, credits: [] }), draftDigest(input));
  assert.notEqual(draftDigest({ ...input, credits: [] }), draftDigest({ ...input, credits: [{ name: 'Keith' }] }));
});

test('v4 freezes only the exact normalized simple credits while legacy render snapshots keep their shape', () => {
  const event = { id: 3, title: 'Private night', event_date: '2030-01-01', venue_address: 'Private address' };
  const host = { id: 2, public_slug: 'host', name: 'Host' };
  const credits = [{ name: 'Keith', role: 'DJ', instagramHandle: '@Keith' }];
  const current = emailRenderSnapshot(event, host, { thankYouVersion: 4, credits });
  assert.equal(current.thankYouVersion, 4);
  assert.deepEqual(current.credits, [{ name: 'Keith', role: 'DJ', instagramHandle: 'keith' }]);
  assert.equal(Object.hasOwn(current, 'contributors'), false);
  assert.doesNotMatch(JSON.stringify(current), /Private address|profileId|profileUrl|approvalVersion/);
  for (const version of [1, 2, 3]) {
    const legacy = emailRenderSnapshot(event, host, { thankYouVersion: version, credits });
    assert.equal(Object.hasOwn(legacy, 'credits'), false);
    assert.equal(Object.hasOwn(legacy, 'contributors'), version === 3);
  }
});

test('owner thank-you state returns prefills for untouched drafts, explicit clearing, and frozen credits for v4 only', () => {
  const event = { event_vibe_label: 'DJ Love' };
  const draft = { subject: 'Thanks', message: 'Hi', includeFollow: true };
  assert.deepEqual(serializeThankYou({ draft, host: {}, event }).credits, defaultThankYouCredits(event));
  const batch = { ...draft, credits: [], status: 'draft' };
  assert.deepEqual(serializeThankYou({ batch, host: {}, event }).credits, []);
  batch.status = 'sent';
  batch.render_snapshot = { thankYouVersion: 4, credits: [{ name: 'Frozen', instagramHandle: 'frozen' }] };
  assert.deepEqual(serializeThankYou({ batch, host: {}, event }).credits, [{ name: 'Frozen', role: '', instagramHandle: 'frozen' }]);
  batch.render_snapshot = { thankYouVersion: 3, contributors: [{ name: 'Legacy Contributor' }] };
  assert.deepEqual(serializeThankYou({ batch, host: {}, event }).credits, []);
});

test('pure Instagram extraction preserves the existing Host Page parser and export behavior', () => {
  const pure = require('../src/lib/instagram-handle').cleanInstagramHandle;
  const existing = require('../src/lib/host-profile').cleanInstagramHandle;
  assert.equal(existing, pure);
  for (const [input, expected] of [['@Night.Work', 'night.work'], ['www.instagram.com/Night.Work/', 'night.work'],
    ['https://user:pass@instagram.com/night.work', 'night.work'], ['', null]]) {
    assert.deepEqual(existing(input), { value: expected, error: null });
  }
  assert.ok(existing('https://example.test/name').error);
  const helper = fs.readFileSync(path.join(__dirname, '../src/lib/thank-you-credits.js'), 'utf8');
  assert.doesNotMatch(helper, /require\(['"].*(?:post-event|host-profile|config\/db)/);
});

test('credits migration only extends the existing private thank-you batch and never creates profiles or queues mail', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../src/db/migrations/077_thank_you_credits.sql'), 'utf8');
  assert.match(migration, /ALTER TABLE post_event_thank_you_batches/);
  assert.match(migration, /ADD COLUMN credits JSONB/);
  assert.doesNotMatch(migration, /CREATE TABLE|UPDATE (?:rsvps|users|organizers|contributor|host_follows)|INSERT INTO/i);
});
