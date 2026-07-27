const test = require('node:test');
const assert = require('node:assert/strict');

const { renderRsvpConfirmationEmail } = require('../src/lib/mailer');

const event = {
  title: 'Midnight Listening Party',
  event_date: '2026-08-22',
  start_time: '20:30',
  venue_name: 'The Silver Room',
  venue_address: '1420 Valencia St, San Francisco, CA',
  slug: 'midnight-listening-party',
  comments_enabled: true
};

const rsvp = {
  first_name: 'Avery',
  manage_token: 'private-manage-token',
  wants_reminders: true
};

test('RSVP confirmation follows the premium Silver Glider hierarchy', () => {
  const html = renderRsvpConfirmationEmail({ event, rsvp });
  const markers = [
    'logo.png',
    'RSVP Confirmed',
    "You're on the list.",
    'Avery, your spot for Midnight Listening Party is confirmed.',
    'background:#111',
    'View event &amp; comments',
    'A calendar invite is attached.',
    'Manage your RSVP',
    'border-top:1px solid #202020'
  ];

  for (let index = 1; index < markers.length; index += 1) {
    assert.ok(html.indexOf(markers[index - 1]) < html.indexOf(markers[index]), `${markers[index - 1]} should precede ${markers[index]}`);
  }
  assert.equal((html.match(/background:#1CC5BE/g) || []).length, 1);
});

test('RSVP email preserves event information, management, and calendar messaging', () => {
  const html = renderRsvpConfirmationEmail({ event, rsvp });
  for (const value of ['Midnight Listening Party', 'Saturday, August 22, 2026', '8:30 PM', 'The Silver Room', 'Open in Maps →']) {
    assert.match(html, new RegExp(value));
  }
  assert.match(html, /\/r\/private-manage-token\/event/);
  assert.match(html, /\/r\/private-manage-token/);
  assert.match(html, /We’ll send one reminder the day before\./);
});

test('RSVP confirmation remains responsive and dark without changing shared emails', () => {
  const html = renderRsvpConfirmationEmail({ event, rsvp });
  assert.match(html, /@media only screen and \(max-width:620px\)/);
  assert.match(html, /bgcolor="#080808"/);
  assert.match(html, /max-width:640px/);
  assert.match(html, /class="sg-email-headline"/);
});
