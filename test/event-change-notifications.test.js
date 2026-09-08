const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildIcs } = require('../src/lib/calendar');
const { renderEventUpdateEmail, renderEventCancellationEmail } = require('../src/lib/mailer');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function sampleEvent(overrides = {}) {
  return {
    id: 42,
    slug: 'changed-night',
    title: 'Changed Night',
    description: 'A test event.',
    event_date: '2030-10-12',
    start_time: '20:00',
    venue_name: 'New Hall',
    venue_address: '22 New Street',
    status: 'published',
    calendar_sequence: 3,
    comments_enabled: false,
    ...overrides
  };
}

test('calendar files keep a stable UID and advance their update sequence', () => {
  const updated = buildIcs(sampleEvent());
  assert.match(updated, /METHOD:REQUEST/);
  assert.match(updated, /UID:event-42@silvergliderevents\.com/);
  assert.match(updated, /SEQUENCE:3/);
  assert.match(updated, /STATUS:CONFIRMED/);

  const cancelled = buildIcs(sampleEvent({ status: 'cancelled', calendar_sequence: 4 }));
  assert.match(cancelled, /METHOD:CANCEL/);
  assert.match(cancelled, /UID:event-42@silvergliderevents\.com/);
  assert.match(cancelled, /SEQUENCE:4/);
  assert.match(cancelled, /STATUS:CANCELLED/);
});

test('important-change emails are escaped, explicit, and one-way', () => {
  const event = sampleEvent({ title: '<Changed Night>' });
  const rsvp = { manage_token: 'secure-token' };
  const html = renderEventUpdateEmail({
    event,
    rsvp,
    changes: [{ label: 'Location', before: '<Old Hall>', after: 'New Hall' }]
  });
  assert.match(html, /Plans changed\./);
  assert.match(html, /&lt;Old Hall&gt;/);
  assert.doesNotMatch(html, /<Old Hall>/);
  assert.match(html, /\/r\/secure-token\/event/);
  assert.match(html, /Replies are not monitored/);

  const cancelled = renderEventCancellationEmail({ event, rsvp });
  assert.match(cancelled, /This event was cancelled\./);
  assert.match(cancelled, /\/r\/secure-token\/event/);

  const mailer = read('src/lib/mailer.js');
  const updateSender = mailer.slice(mailer.indexOf('async function sendEventUpdate'), mailer.indexOf('// Organizer-triggered announcement'));
  assert.doesNotMatch(updateSender, /replyTo/);
});

test('both editors and cancellation use the shared responsive notification decision', () => {
  const dialog = read('public/js/event-change-dialog.js');
  const styles = read('public/css/event-change-dialog.css');
  const form = read('public/js/event-form.js');
  const owner = read('public/js/event-owner-editor.js');
  const manage = read('public/js/manage.js');

  assert.match(dialog, /Save & notify \$\{guestLabel\}/);
  assert.match(dialog, /Save without email/);
  assert.match(dialog, /Cancel & notify \$\{guestLabel\}/);
  assert.match(dialog, /Cancel without email/);
  assert.match(dialog, /mode === 'update'/);
  assert.match(dialog, /There are no confirmed guests to notify/);
  assert.match(styles, /@media \(max-width:620px\)/);
  assert.match(styles, /margin:auto;border-radius:24px/);
  assert.match(styles, /margin:auto 0 0/);
  assert.match(form, /SGEEventChanges\.confirmUpdate/);
  assert.match(owner, /SGEEventChanges\.confirmUpdate/);
  assert.match(manage, /SGEEventChanges\.confirmCancellation/);
  assert.match(form, /body\.notify_attendees = choice === 'notify'/);
  assert.match(owner, /body\.notify_attendees = choice === 'notify'/);
  assert.match(manage, /notify_attendees: choice === 'notify'/);
});
