'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderEventReminderEmail, renderDayBeforeReminderEmail, renderRsvpConfirmationEmail } = require('../src/lib/mailer');
const { createRideEntry } = require('../src/lib/transit/ride-entry');

const env = { TRANSIT_GETTING_HOME_ENABLED: 'true', TRANSIT_DISTRIBUTION_ENABLED: 'true', SESSION_SECRET: 'fixture-only-ride-email-key' };
const now = () => Date.parse('2026-11-27T00:00:00Z');
const event = {
  id: 10, slug: 'pilot-night', status: 'published', visibility: 'public', title: 'Pilot Night',
  venue_name: 'Make-Out Room', venue_address: '3225 22nd St, San Francisco CA', timezone: 'America/Los_Angeles',
  event_date: '2026-11-27', start_time: '19:00', ends_at: '2026-11-28T07:30:00Z'
};
const rsvp = { id: 20, event_id: 10, status: 'confirmed', wants_reminders: true, manage_token: 'fixture-manage-secret', first_name: 'Guest' };
const entry = createRideEntry({ secret: env.SESSION_SECRET, now });
const token = entry.issue({ eventId: event.id, rsvpId: rsvp.id, expiresAt: Date.parse(event.ends_at) });
const rideEntryPath = `/e/${event.slug}/getting-home/from-email?t=${token}`;

test('both reminder layouts keep the original actions and add only the scoped planner link', () => {
  const variants = [
    renderDayBeforeReminderEmail({ event, rsvp, rideEntryPath }),
    renderEventReminderEmail({ event, rsvp, kicker: 'Today', headline: 'See you tonight.', rideEntryPath })
  ];
  for (const html of variants) {
    assert.match(html, />Need help getting home\?<\/a>/);
    assert.match(html, /Save this link for when you’re ready to leave\./);
    assert.match(html, /View event/);
    assert.match(html, /Make-Out Room/);
    assert.match(html, /Add to Calendar/);
    assert.match(html, /Manage RSVP &amp; email settings/);
    assert.doesNotMatch(html, /Don.t Miss Your Last Bus|See buses and trains from|View venue|text me|SMS|30 minutes before/i);
    assert.equal((html.match(/Need help getting home\?/g) || []).length, 1);
    assert.ok(html.indexOf('>View event<') < html.indexOf('>Need help getting home?') &&
      html.indexOf('>Need help getting home?') < html.indexOf('>Add to Calendar<'));
    const href = /href="([^"]+\/getting-home\/from-email\?t=[^"]+)"/.exec(html)[1];
    assert.doesNotMatch(href, /fixture-manage-secret|Guest/);
    const claims = entry.verify(new URL(href).searchParams.get('t'));
    assert.deepEqual([claims.eventId, claims.rsvpId], [10, 20]);
  }
});

test('the Getting Home link is the only markup added to the original reminder', () => {
  const original = renderDayBeforeReminderEmail({ event, rsvp });
  const extended = renderDayBeforeReminderEmail({ event, rsvp, rideEntryPath });
  const linkMarkup = /<p class="sg-email-secondary"[^>]*>\s*<a [^>]*>Need help getting home\?<\/a><br>\s*Save this link for when you’re ready to leave\.\s*<\/p>/;
  assert.match(extended, linkMarkup);
  assert.equal(extended.replace(linkMarkup, ''), original);
});

test('the callout is absent without an authorized path and confirmation is unchanged', () => {
  const without = html => assert.doesNotMatch(html, /Need help getting home|Save this link|getting-home\/from-email/);
  without(renderEventReminderEmail({ event, rsvp, kicker: 'Today', headline: 'See you tonight.' }));
  without(renderDayBeforeReminderEmail({ event, rsvp }));
  without(renderRsvpConfirmationEmail({ event, rsvp, rideEntryPath }));
  for (const invalid of ['https://elsewhere.example/path', '@elsewhere.example/path', '/account', `${rideEntryPath}&to=untrusted`]) {
    without(renderDayBeforeReminderEmail({ event, rsvp, rideEntryPath: invalid }));
  }
  for (const fields of [{ visibility: 'private' }, { hide_address_until_rsvp: true }, { secret_show_enabled: true }]) {
    without(renderDayBeforeReminderEmail({ event: { ...event, ...fields }, rsvp, rideEntryPath }));
  }
});
