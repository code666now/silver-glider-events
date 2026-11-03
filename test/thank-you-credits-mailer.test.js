const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://silvergliderevents.com';
process.env.RESEND_API_KEY = '';
const { buildPostEventThankYouEmail, sendPostEventThankYou, devOutbox } = require('../src/lib/mailer');

const base = {
  event: { id: 42, title: 'Our Night', event_date: '2026-10-30' },
  host: { id: 7, org_name: 'Heat Wave Booking', public_slug: 'heat-wave' },
  subject: 'Thank you', message: 'A good night.', includeFollow: true,
  alreadyFollowing: false, consentScope: 'event_rsvp', templateVersion: 4,
  unsubscribeUrl: 'https://silvergliderevents.com/unsubscribe?token=test'
};
const credits = [
  { name: 'DJ Walkin Love', role: 'DJ', instagramHandle: '@Walkin.Love', email: 'never-shared@example.test', profileUrl: '/people/never-used', photoUrl: 'https://example.test/never-used.jpg' },
  { name: 'Ramón', role: 'Cocktails', instagramHandle: 'https://www.instagram.com/Ramon.Cocktails/?igsh=tracking' }
];

test('v4 renders simple name/role credits linked directly to canonical Instagram profiles', () => {
  const email = buildPostEventThankYouEmail({ ...base, credits });
  assert.match(email.html, /Big thanks to/);
  assert.match(email.html, /DJ Walkin Love/);
  assert.match(email.html, /Ramón/);
  assert.match(email.html, /https:\/\/www\.instagram\.com\/walkin\.love\//);
  assert.match(email.html, /https:\/\/www\.instagram\.com\/ramon\.cocktails\//);
  assert.match(email.html, />@walkin\.love ↗<\/a>/);
  assert.match(email.text, /Ramón — Cocktails\nInstagram: https:\/\/www\.instagram\.com\/ramon\.cocktails\//);
  assert.doesNotMatch(JSON.stringify(email), /never-shared|never-used|tracking|\/people\/|claim|approve your|Meet Ramón/);
  assert.match(email.html, />Follow my page<\/a>/);
  assert.match(email.html, /This does not subscribe you to future-event emails/);
});

test('credits are optional, support name-only thanks, and never manufacture profile links', () => {
  const plain = buildPostEventThankYouEmail({ ...base, credits: [{ name: 'Our crew', role: '', instagramHandle: null }] });
  assert.match(plain.html, /Our crew/);
  assert.doesNotMatch(plain.html, /instagram\.com|\/people\/|Meet Our crew/);
  for (const input of [{ ...base }, { ...base, credits: [] }]) {
    const email = buildPostEventThankYouEmail(input);
    assert.doesNotMatch(email.html, /Big thanks to|instagram\.com/);
    assert.match(email.html, /Follow my page/);
  }
});

test('v4 escapes credit display text and rejects untrusted destinations rather than sending them', () => {
  const email = buildPostEventThankYouEmail({ ...base, credits: [{ name: '<script>name</script>', role: '<img src=x onerror=x>', instagramHandle: '@safe.name' }] });
  assert.match(email.html, /&lt;script&gt;name&lt;\/script&gt;/);
  assert.match(email.html, /&lt;img src=x onerror=x&gt;/);
  assert.doesNotMatch(email.html, /<script>|<img src=x/);
  for (const instagramHandle of ['javascript:alert(1)', 'https://instagram.com.evil.test/person', 'https://user:pass@instagram.com/person', 'https://instagram.com/p/a-post', 'https://example.test/person']) {
    assert.throws(() => buildPostEventThankYouEmail({ ...base, credits: [{ name: 'Person', instagramHandle }] }), /Instagram/);
  }
  assert.throws(() => buildPostEventThankYouEmail({ ...base, credits: Array.from({ length: 4 }, () => ({ name: 'Person' })) }), /three/);
});

test('previous v3 approved contributor emails stay byte-identical for all recipient scopes', () => {
  const contributors = [{ id: 1, profileId: 2, name: 'Night <Artist>', role: 'DJ & producer',
    photoUrl: 'https://res.cloudinary.com/demo/image/upload/artist.jpg',
    profileUrl: 'https://silvergliderevents.com/people/night-artist?intro=0123456789abcdef01234567' }];
  const expected = {
    host: 'e47ea05a74f0bdaabc81b76a4b9df87cee305f5a27d575cda57be52e45223a0c',
    event: 'ef2343f26b3523b6780916901f4ab45faedf226498bc4f04c07fdb25c557793d',
    event_rsvp: '4ea736fc1b05253891c8c5a306654d26e42671bf7e296341d6dd5bd75a4ec5d6'
  };
  for (const consentScope of Object.keys(expected)) {
    const email = buildPostEventThankYouEmail({ ...base, consentScope, templateVersion: 3, contributors });
    assert.equal(createHash('sha256').update(JSON.stringify(email)).digest('hex'), expected[consentScope]);
    for (const templateVersion of [1, 2, 3]) {
      const old = { ...base, consentScope, templateVersion, contributors };
      assert.deepEqual(buildPostEventThankYouEmail({ ...old, credits: [{ name: '', instagramHandle: 'javascript:invalid' }] }), buildPostEventThankYouEmail(old));
    }
  }
});

test('v4 credit input never mutates consent, the host button or the calling draft', () => {
  for (const consentScope of ['host', 'event', 'event_rsvp']) {
    const input = { ...base, consentScope, credits: structuredClone(credits) };
    const original = structuredClone(input);
    const email = buildPostEventThankYouEmail(input);
    assert.deepEqual(input, original);
    assert.match(email.html, /Follow my page/);
    assert.match(email.html, /Unsubscribe from emails from this host/);
    const absentHost = buildPostEventThankYouEmail({ ...input, host: { ...base.host, public_slug: null } });
    assert.doesNotMatch(absentHost.html, /Follow my page|\/h\//);
    assert.match(absentHost.html, /Big thanks to/);
  }
});

test('v4 transport keeps the frozen credits, unsubscribe headers and stable provider key', async () => {
  devOutbox.length = 0;
  const result = await sendPostEventThankYou({ ...base, credits, to: 'guest@example.test', idempotencyKey: 'test-frozen-credits:42' });
  assert.deepEqual(result, { dev: true });
  assert.equal(devOutbox.length, 1);
  const sent = devOutbox[0];
  assert.match(sent.html, /ramon\.cocktails/);
  assert.equal(sent.idempotencyKey, 'test-frozen-credits:42');
  assert.equal(sent.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(sent.headers['List-Unsubscribe'], /token=test/);
});
