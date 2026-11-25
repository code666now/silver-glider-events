'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderEventReminderEmail, renderDayBeforeReminderEmail } = require('../src/lib/mailer');
const { createRideEntry } = require('../src/lib/transit/ride-entry');

const env = { TRANSIT_GETTING_HOME_ENABLED: 'true', TRANSIT_DISTRIBUTION_ENABLED: 'true', SESSION_SECRET: 'fixture-only-ride-email-key' };
const now = () => Date.parse('2026-11-27T00:00:00Z');
const event = {
  id: 10, slug: 'pilot-night', status: 'published', visibility: 'public', title: 'Pilot Night',
  venue_name: 'Make-Out Room', venue_address: '3225 22nd St, San Francisco CA', timezone: 'America/Los_Angeles',
  event_date: '2026-11-27', start_time: '19:00', ends_at: '2026-11-28T07:30:00Z'
};
const rsvp = { id: 20, event_id: 10, status: 'confirmed', wants_reminders: true, manage_token: 'fixture-manage-secret', first_name: 'Guest' };

test('eligible day-before email keeps the original actions and adds only a scoped ride entry', () => {
  const html = renderDayBeforeReminderEmail({ event, rsvp, env, now });
  assert.match(html, /Don't Miss Your Last Bus!/);
  assert.match(html, /View event/);
  assert.match(html, /Add to Calendar/);
  assert.match(html, /Manage RSVP &amp; email settings/);
  const href = /href="([^"]+\/getting-home\/from-email\?t=[^"]+)"/.exec(html)[1];
  assert.doesNotMatch(href, /fixture-manage-secret|Guest/);
  const claims = createRideEntry({ secret: env.SESSION_SECRET, now }).verify(new URL(href).searchParams.get('t'));
  assert.deepEqual([claims.eventId, claims.rsvpId], [10, 20]);
});

test('day-of reminders, opted-out recipients and private/secret events do not get the ride link', () => {
  const without = html => assert.doesNotMatch(html, /Help me get home|getting-home\/from-email/);
  without(renderEventReminderEmail({ event, rsvp, kicker: 'Today', headline: 'See you tonight.' }));
  without(renderDayBeforeReminderEmail({ event, rsvp, env: { ...env, TRANSIT_DISTRIBUTION_ENABLED: 'false' }, now }));
  without(renderDayBeforeReminderEmail({ event, rsvp: { ...rsvp, wants_reminders: false }, env, now }));
  for (const bits of [{ visibility: 'private' }, { secret_show_enabled: true }, { hide_address_until_rsvp: true }, { venue_address: '100 Main St, San Francisco CA' }]) {
    without(renderDayBeforeReminderEmail({ event: { ...event, ...bits }, rsvp, env, now }));
  }
});

test('a retried day-before reminder renders the same signed URL for the same delivery', () => {
  const queued = { ...rsvp, reminder_queued_at: new Date(now() - 5000) };
  const initial = renderDayBeforeReminderEmail({ event, rsvp: queued, env, now });
  const retry = renderDayBeforeReminderEmail({ event, rsvp: queued, env, now: () => now() + 60_000 });
  assert.equal(initial, retry);
});
