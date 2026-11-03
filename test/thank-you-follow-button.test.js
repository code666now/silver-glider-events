const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://silvergliderevents.com';
// Transport tests must stay in the local outbox even if a developer has a
// production email credential configured in their shell.
process.env.RESEND_API_KEY = '';

const { buildPostEventThankYouEmail, sendPostEventThankYou, devOutbox } = require('../src/lib/mailer');

const base = {
  event: {
    id: 42,
    title: 'Night <Two>',
    event_date: '2026-10-30',
    start_time: '20:00',
    timezone: 'America/Los_Angeles'
  },
  host: { id: 7, org_name: 'Host <Collective>', public_slug: 'host-collective' },
  subject: 'Thank you',
  message: 'Thanks for coming.',
  includeFollow: true,
  alreadyFollowing: false,
  unsubscribeUrl: 'https://silvergliderevents.com/unsubscribe-email?token=scope-safe'
};

for (const consentScope of ['host', 'event', 'event_rsvp']) {
  for (const alreadyFollowing of [false, true]) {
    for (const includeFollow of [false, true]) {
      test(`v2 offers the Host Page for ${consentScope}, following=${alreadyFollowing}, legacy option=${includeFollow}`, () => {
        const email = buildPostEventThankYouEmail({
          ...base, consentScope, alreadyFollowing, includeFollow, templateVersion: 2
        });

        assert.equal((email.html.match(/class="sg-email-cta"/g) || []).length, 1);
        assert.match(email.html, />Follow my page<\/a>/);
        assert.match(email.html, /Stay in the loop about future events\./);
        assert.match(email.text, /Follow my page: https:\/\/silvergliderevents\.com\/h\/host-collective\nStay in the loop about future events\./);
        assert.match(email.html, /href="https:\/\/silvergliderevents\.com\/h\/host-collective"/);
        // The destination is the public page, with no recipient identity or
        // auto-subscription action encoded in its path or query string.
        const hostLinks = [...email.html.matchAll(/href="([^"]*\/h\/[^"]*)"/g)].map(match => match[1]);
        assert.deepEqual(hostLinks, ['https://silvergliderevents.com/h/host-collective']);
        assert.doesNotMatch(hostLinks[0], /\?|#|scope-safe|guest|email|token|subscribe/);
      });
    }
  }
}

test('v2 public-page invitation does not invent or change recipient email consent', () => {
  for (const consentScope of ['event', 'event_rsvp']) {
    const input = { ...base, consentScope, templateVersion: 2 };
    const original = structuredClone(input);
    const email = buildPostEventThankYouEmail(input);

    assert.deepEqual(input, original);
    assert.doesNotMatch(email.html, /opted into emails from|automatically subscribed|you now follow/i);
    assert.match(email.html, /Unsubscribe from emails from this host/);
    assert.match(email.text, /Unsubscribe from emails from this host:/);
    if (consentScope === 'event_rsvp') {
      assert.match(email.html, /This does not subscribe you to future-event emails\./);
      assert.match(email.text, /This does not subscribe you to future-event emails\./);
    } else {
      assert.match(email.html, /chose to receive messages about this event/);
    }
  }
});

test('v2 has no follow control or helper when the host has no public page', () => {
  for (const public_slug of [undefined, '', '   ']) {
    const email = buildPostEventThankYouEmail({
      ...base, host: { ...base.host, public_slug }, consentScope: 'event_rsvp', templateVersion: 2
    });

    assert.doesNotMatch(email.html, /class="sg-email-cta"|Follow my page|Stay in the loop about future events|\/h\//);
    assert.doesNotMatch(email.text, /Follow my page|Stay in the loop about future events|\/h\//);
  }
});

test('v2 safely escapes content and encodes the canonical Host Page path', () => {
  const email = buildPostEventThankYouEmail({
    ...base,
    host: { ...base.host, public_slug: 'host/name?email=someone@example.test&follow=true' },
    message: '<script>unsafe()</script>\nThank you & see you soon!',
    consentScope: 'event_rsvp',
    templateVersion: 2,
    unsubscribeUrl: undefined
  });

  assert.match(email.html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;<br>Thank you &amp; see you soon!/);
  assert.doesNotMatch(email.html, /<script>/);
  const followUrl = [...email.html.matchAll(/href="([^"]*\/h\/[^"]*)"/g)][0][1];
  assert.equal(followUrl, 'https://silvergliderevents.com/h/host%2Fname%3Femail%3Dsomeone%40example.test%26follow%3Dtrue');
  assert.equal(new URL(followUrl).search, '');
  assert.match(email.html, /Preview only — the sent email includes the recipient’s unsubscribe link/);
  assert.match(email.html, /This does not subscribe you to future-event emails\./);
});

test('v1 remains the default and retains legacy approval payloads byte-for-byte', () => {
  const expected = {
    host: '3d390ff96c62f8fbc3dc8125fa0fb328127228d44cde2d9df2ec597d6fedaca9',
    event: 'c16a23430f1df1dcc8f25df1a7721e1a3356c2c4937affcb4c6cfcdcc616dd05',
    event_rsvp: '3d7a96804818ad3a0a0974fafbf70724299e73c0194ac82d10cc5ac25d105b78'
  };
  for (const consentScope of ['host', 'event', 'event_rsvp']) {
    const defaultEmail = buildPostEventThankYouEmail({ ...base, consentScope });
    const versionOneEmail = buildPostEventThankYouEmail({ ...base, consentScope, templateVersion: 1 });
    assert.deepEqual(defaultEmail, versionOneEmail);
    assert.equal(createHash('sha256').update(JSON.stringify(versionOneEmail)).digest('hex'), expected[consentScope]);
    assert.doesNotMatch(versionOneEmail.html, />Follow my page<|Stay in the loop about future events/);
    if (consentScope !== 'host') assert.doesNotMatch(versionOneEmail.html, /\/h\/host-collective/);
  }
});

test('unknown thank-you template versions fail closed', () => {
  for (const templateVersion of [0, 5, '2', null]) {
    assert.throws(() => buildPostEventThankYouEmail({ ...base, templateVersion }), /valid template version/);
  }
});

test('v2 delivery passes the frozen version to rendering without changing unsubscribe or provider idempotency', async () => {
  devOutbox.length = 0;
  const result = await sendPostEventThankYou({
    ...base,
    to: 'guest@example.test',
    consentScope: 'event_rsvp',
    includeFollow: false,
    alreadyFollowing: true,
    templateVersion: 2,
    idempotencyKey: 'sge-post-event-thanks-42-100-v2'
  });

  assert.deepEqual(result, { dev: true });
  assert.equal(devOutbox.length, 1);
  const sent = devOutbox[0];
  assert.match(sent.html, />Follow my page<\/a>/);
  assert.match(sent.text, /Stay in the loop about future events\./);
  assert.match(sent.html, /This does not subscribe you to future-event emails\./);
  assert.equal(sent.idempotencyKey, 'sge-post-event-thanks-42-100-v2');
  assert.equal(sent.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(sent.headers['List-Unsubscribe'], /scope-safe/);
});
