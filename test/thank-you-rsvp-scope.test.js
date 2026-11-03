const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://silvergliderevents.com';

const { buildPostEventThankYouEmail } = require('../src/lib/mailer');
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

test('RSVP thank-you scope explains one event message without inventing a marketing opt-in', () => {
  const email = buildPostEventThankYouEmail({ ...base, consentScope: 'event_rsvp' });

  assert.match(email.html, /You’re receiving this one thank-you because you RSVP’d to Night &lt;Two&gt;\./);
  assert.match(email.text, /You’re receiving this one thank-you because you RSVP’d to Night <Two>\./);
  for (const content of [email.html, email.text]) {
    assert.match(content, /This does not subscribe you to future-event emails\./);
    assert.doesNotMatch(content, /opted into emails from|chose to receive messages about this event/);
    assert.doesNotMatch(content, /Follow our page|Follow Host Collective|\/h\/host-collective/);
    assert.match(content, /Unsubscribe from emails from this host/);
    assert.match(content, /unsubscribe-email\?token=scope-safe/);
  }
  assert.equal((email.html.match(/class="sg-email-cta"/g) || []).length, 0);
  assert.match(email.html, /490 Post Street, Suite 500/);
});

test('RSVP thank-you preview stays send-free and excludes Follow even when requested', () => {
  const email = buildPostEventThankYouEmail({
    ...base,
    consentScope: 'event_rsvp',
    unsubscribeUrl: undefined,
    message: '<script>unsafe()</script>\nThanks!'
  });

  assert.match(email.html, /Preview only — the sent email includes the recipient’s unsubscribe link/);
  assert.match(email.text, /Preview only: the sent email includes the recipient’s unsubscribe link/);
  assert.match(email.html, /You’re receiving this one thank-you because you RSVP’d to Night &lt;Two&gt;/);
  assert.match(email.text, /You’re receiving this one thank-you because you RSVP’d to Night <Two>/);
  assert.match(email.html, /This does not subscribe you to future-event emails/);
  assert.match(email.html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;<br>Thanks!/);
  assert.doesNotMatch(email.html, /<script>|Follow our page|\/h\/host-collective/);
});

test('previously queued host and event scopes retain byte-identical rendered payloads', () => {
  // Captured from the existing release before adding event_rsvp. A retry of an
  // already queued payload must not acquire new copy or promotional content.
  const expected = {
    host: '3d390ff96c62f8fbc3dc8125fa0fb328127228d44cde2d9df2ec597d6fedaca9',
    event: 'c16a23430f1df1dcc8f25df1a7721e1a3356c2c4937affcb4c6cfcdcc616dd05'
  };
  for (const [consentScope, digest] of Object.entries(expected)) {
    const email = buildPostEventThankYouEmail({ ...base, consentScope });
    assert.equal(createHash('sha256').update(JSON.stringify(email)).digest('hex'), digest, consentScope);
  }
});

test('thank-you edit and preview explain the same Going-email audience and exclusions', () => {
  const view = fs.readFileSync(path.join(__dirname, '../src/views/event-manage.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '../public/js/post-event.js'), 'utf8');
  const audienceCopy = 'For guests marked Going with an email, excluding email opt-outs and unsubscribes. No account or future-event subscription is needed. Additional guests are not contacted.';

  assert.equal(view.split(audienceCopy).length - 1, 2);
  assert.match(view, /Send one thank-you to guests marked Going who gave an email/);
  assert.match(view, /When you have a Host Page, “Follow my page” opens it without subscribing anyone automatically/);
  assert.match(view, /You can send once, and email addresses stay private/);
  assert.match(client, /Guests must be marked Going, have an email, and not have opted out or unsubscribed/);
  assert.doesNotMatch(client, /No guests are currently eligible under your email consent settings/);
});
