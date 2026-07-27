const test = require('node:test');
const assert = require('node:assert/strict');

const { renderSharedEmailLayout } = require('../src/lib/mailer');

test('shared emails use the premium Silver Glider visual system', () => {
  const html = renderSharedEmailLayout({
    kicker: 'Reminder',
    headline: 'See you tonight.',
    sub: 'Midnight Listening Party',
    bodyHtml: '<div data-event-card>Event card</div>',
    cta: 'View event',
    ctaUrl: 'https://silvergliderevents.com/e/midnight-listening-party',
    footerHtml: '<p data-secondary>Manage your RSVP</p>'
  });
  const markers = [
    'logo.png',
    'Silver Glider Events',
    'Reminder',
    'See you tonight.',
    'Midnight Listening Party',
    'data-event-card',
    'View event',
    'data-secondary',
    'border-top:1px solid #202020'
  ];

  for (let index = 1; index < markers.length; index += 1) {
    assert.ok(html.indexOf(markers[index - 1]) < html.indexOf(markers[index]), `${markers[index - 1]} should precede ${markers[index]}`);
  }
  assert.match(html, /@media only screen and \(max-width:620px\)/);
  assert.match(html, /bgcolor="#080808"/);
  assert.match(html, /max-width:640px/);
  assert.match(html, /class="sg-email-headline"/);
  assert.equal((html.match(/background:#1CC5BE/g) || []).length, 1);
});

test('shared email layout preserves purpose-specific content and escapes user-facing text', () => {
  const html = renderSharedEmailLayout({
    kicker: 'New event',
    headline: 'Night < Day',
    sub: 'A & B has a new event coming up.',
    bodyHtml: '<div data-preserved>Existing event card</div>',
    cta: 'View & RSVP',
    ctaUrl: 'https://silvergliderevents.com/e/night?from=email&host=a',
    footerHtml: '<a data-unsubscribe href="https://silvergliderevents.com/unsubscribe">Unsubscribe</a>'
  });

  assert.match(html, /Night &lt; Day/);
  assert.match(html, /A &amp; B has a new event coming up\./);
  assert.match(html, /View &amp; RSVP/);
  assert.match(html, /from=email&amp;host=a/);
  assert.match(html, /data-preserved/);
  assert.match(html, /data-unsubscribe/);
});
