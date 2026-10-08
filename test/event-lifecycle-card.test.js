const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lifecycle = require('../public/js/event-lifecycle');
const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('event management selects all six lifecycle variants from real state', () => {
  const base = { lifecycle_phase: 'upcoming', rsvp_count: 0, sms_eligible_count: 0, sms_reminder_enabled: true };
  assert.equal(lifecycle.variantFor({ event: base, followerPreview: { count: 0 } }), 'new-event');
  assert.equal(lifecycle.variantFor({
    event: { ...base, rsvp_count: 4 }, smsPreview: { recipientCount: 3, needsFunds: false }
  }), 'reminder-funded');
  assert.equal(lifecycle.variantFor({
    event: { ...base, rsvp_count: 4 }, smsPreview: { recipientCount: 3, needsFunds: true }
  }), 'reminder-needs-credits');
  assert.equal(lifecycle.variantFor({
    event: { ...base, rsvp_count: 4 }, followerPreview: { count: 2 }
  }), 'follower-outreach');
  assert.equal(lifecycle.variantFor({ event: { ...base, lifecycle_phase: 'tonight' } }), 'tonight');
  assert.equal(lifecycle.variantFor({ event: { ...base, lifecycle_phase: 'ended', is_past: true } }), 'ended');
});

test('reminder schedule and delivery receipt stay grounded in stored records', () => {
  assert.equal(lifecycle.reminderDateLabel('2026-10-02'), 'Thursday, Oct 1');
  assert.deepEqual(lifecycle.deliveryReceipt({
    day_before_sms_delivered_count: 12,
    day_before_sms_accepted_count: 14,
    day_before_sms_failed_count: 1,
    day_before_email_sent_count: 6,
    day_before_email_failed_count: 2
  }), {
    textDelivered: 12,
    textAccepted: 14,
    textFailed: 1,
    textPending: 1,
    emailSent: 6,
    emailFailed: 2,
    hasRecordedSend: true
  });
});

test('lifecycle card uses existing share, credits, host page, and create-event flows', () => {
  const view = read('src/views/event-manage.html');
  const client = read('public/js/manage.js');
  const editor = read('src/lib/event-editor.js');
  const eventsRoute = read('src/routes/events.js');

  for (const id of ['lifecycle-card-title', 'lifecycle-receipt', 'lifecycle-recap', 'lifecycle-next-event']) {
    assert.match(view, new RegExp(`id="${id}"`));
  }
  assert.match(view, /script src="\/js\/event-lifecycle\.js"/);
  assert.match(client, /settings\/messaging\?return=/);
  assert.match(client, /window\.location\.assign\('\/events\/new'\)/);
  assert.match(client, /Copy and share your public page/);
  assert.match(client, /email reminders still send free/i);
  assert.match(client, /Reminder sent yesterday/);
  assert.match(editor, /AS lifecycle_phase/);
  assert.match(editor, /AS new_follower_count/);
  assert.match(editor, /ml\.message_type='reminder_day_before'/);
  assert.match(editor, /b\.delivered_count/);
  assert.match(eventsRoute, /hostPageUrl/);
});

test('mobile and desktop expose the same adaptive lifecycle card', () => {
  const view = read('src/views/event-manage.html');
  const client = read('public/js/manage.js');
  assert.match(view, /@media \(min-width: 1024px\)/);
  assert.match(view, /@media \(max-width: 879px\)/);
  assert.match(view, /data-manage-mobile-open="promote"[^>]*aria-controls="line-card"/);
  assert.match(view, /data-lifecycle-variant="new-event"/);
  assert.match(client, /\['Recap', 'See results and plan your next event'\]/);
  assert.match(client, /\['Tonight', 'Last call and recorded reminder delivery'\]/);
});
