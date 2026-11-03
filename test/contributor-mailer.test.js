'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://silvergliderevents.com';
process.env.RESEND_API_KEY = '';
const mailer = require('../src/lib/mailer');

const base = {
  event: { id: 42, title: 'Our Night', event_date: '2026-10-30' },
  host: { id: 7, org_name: 'Heat Wave Booking', public_slug: 'heat-wave' },
  subject: 'Thank you', message: 'A good night.', includeFollow: true,
  alreadyFollowing: false, consentScope: 'event_rsvp', templateVersion: 3,
  unsubscribeUrl: 'https://silvergliderevents.com/unsubscribe?token=test'
};
const artist = {
  id: 1, profileId: 2, name: 'Night <Artist>', role: 'DJ & producer',
  photoUrl: 'https://res.cloudinary.com/demo/image/upload/artist.jpg',
  profileUrl: 'https://silvergliderevents.com/people/night-artist',
  email: 'never-public@example.test', token: 'never-public-token'
};

test('v3 thank-you recognizes approved contributors without leaking their private identity', () => {
  const email = mailer.buildPostEventThankYouEmail({ ...base, contributors: [artist] });
  assert.match(email.html, /The people who made the night/);
  assert.match(email.html, /Night &lt;Artist&gt;/);
  assert.match(email.html, /DJ &amp; producer/);
  assert.match(email.html, /width="60" height="60"/);
  assert.match(email.html, /href="https:\/\/silvergliderevents.com\/people\/night-artist"/);
  assert.match(email.text, /Meet Night <Artist>: https:\/\/silvergliderevents.com\/people\/night-artist/);
  assert.match(email.html, />Follow my page<\/a>/);
  assert.match(email.html, /This does not subscribe you to future-event emails/);
  assert.doesNotMatch(JSON.stringify(email), /never-public|Adrian/);
  assert.doesNotMatch(email.html, /<Artist>/);
});

test('spotlights allow only three canonical contributor pages and escape untrusted content', () => {
  const people = [
    { ...artist, profileUrl: 'https://evil.example/people/x' },
    { ...artist, profileUrl: '/people/x?email=private@example.test' },
    { ...artist, name: '<script>x</script>', role: '<img src=x onerror=x>', profileUrl: '/people/safe', photoUrl: 'javascript:alert(1)' },
    { ...artist, name: 'Fourth is omitted' }
  ];
  const email = mailer.buildPostEventThankYouEmail({ ...base, contributors: people });
  assert.match(email.html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(email.html, /&lt;img src=x onerror=x&gt;/);
  assert.doesNotMatch(email.html, /<script>|<img src=x|javascript:|evil.example|private@example|Fourth is omitted/);
  assert.equal((email.text.match(/Meet /g) || []).length, 1);
});

test('v1 and v2 rendering ignores new contributor input; v2 approved bytes stay unchanged', () => {
  const expected = {
    host: '9146f2880aacbcb3089f8acdd2d3afb0beb1a5b2850b72a8e21b0c045e62bf66',
    event: '4704e71255bf5f5b5eb00ff56c00b8f0f47f42906ea8f94b664268cd547ff72c',
    event_rsvp: '0dc892e4870ba00ac90e948d58ce89e8c138f254c011190af71e6687d0fad3fc'
  };
  for (const consentScope of Object.keys(expected)) {
    for (const templateVersion of [1, 2]) {
      const plain = mailer.buildPostEventThankYouEmail({ ...base, consentScope, templateVersion });
      const extended = mailer.buildPostEventThankYouEmail({ ...base, consentScope, templateVersion, contributors: [artist] });
      assert.deepEqual(extended, plain);
      if (templateVersion === 2) assert.equal(createHash('sha256').update(JSON.stringify(plain)).digest('hex'), expected[consentScope]);
    }
  }
});

test('a spotlight can carry only its opaque public introduction reference, never email or access grants', () => {
  const ref = '0123456789abcdef01234567';
  const email = mailer.buildPostEventThankYouEmail({ ...base, contributors: [{ ...artist, profileUrl: `/people/night-artist?intro=${ref}` }] });
  assert.match(email.html, new RegExp(`/people/night-artist\\?intro=${ref}`));
  for (const query of [`intro=${ref}&email=private`, `intro=${ref}&intro=${ref}`, 'intro=123', 'token=secret']) {
    const rejected = mailer.buildPostEventThankYouEmail({ ...base, contributors: [{ ...artist, profileUrl: `/people/night-artist?${query}` }] });
    assert.doesNotMatch(rejected.html, /The people who made the night/);
  }
});

test('invitation and claim copy use the actual host brand, make approval optional and claiming explicit', () => {
  const invitation = mailer.buildContributorInvitationEmail({
    hostName: 'Heat Wave <Booking>', eventTitle: 'Night & Day', intakeUrl: 'https://silvergliderevents.com/contributors/intake/secret'
  });
  assert.match(invitation.subject, /Heat Wave Booking/);
  assert.match(invitation.html, /Heat Wave Booking/);
  assert.match(invitation.text, /Review or decline/);
  assert.match(invitation.html, /do not need to register an account to approve/);
  assert.doesNotMatch(invitation.html, /Adrian|<Booking>/);
  const claim = mailer.buildContributorClaimEmail({
    hostName: 'Heat Wave Booking', eventTitle: 'Our Night', name: 'The DJ',
    claimUrl: 'https://silvergliderevents.com/auth/verify?token=secret'
  });
  assert.match(claim.html, /Opening the email link does not automatically claim your page/);
  assert.match(claim.html, /never receive the host’s attendee list/);
  for (const intakeUrl of ['javascript:alert(1)', 'data:text/html,hello', '']) {
    assert.throws(() => mailer.buildContributorInvitationEmail({ intakeUrl }), /secure contributor/);
    assert.throws(() => mailer.buildContributorClaimEmail({ claimUrl: intakeUrl }), /secure contributor/);
  }
});

test('contributor deliveries retain stable provider keys and remain in the test outbox', async () => {
  mailer.devOutbox.length = 0;
  await assert.rejects(mailer.sendContributorInvitation({ to: 'artist@example.test' }), /idempotency/);
  await assert.rejects(mailer.sendContributorClaim({ to: 'artist@example.test' }), /idempotency/);
  await mailer.sendContributorInvitation({ to: 'artist@example.test', hostName: 'Heat Wave Booking', eventTitle: 'Our Night',
    intakeUrl: 'https://silvergliderevents.com/contributors/intake/safe', idempotencyKey: 'contributor-invite:1' });
  await mailer.sendContributorClaim({ to: 'artist@example.test', hostName: 'Heat Wave Booking', name: 'The DJ', eventTitle: 'Our Night',
    claimUrl: 'https://silvergliderevents.com/auth/verify?token=safe', idempotencyKey: 'contributor-claim:1' });
  const rendered = mailer.devOutbox.filter(row => row.html);
  assert.equal(rendered.length, 2);
  assert.deepEqual(rendered.map(row => row.idempotencyKey), ['contributor-invite:1', 'contributor-claim:1']);
  assert.match(rendered[0].from, /Heat Wave Booking/);
});
