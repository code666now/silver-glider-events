'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { smsSegments } = require('../src/lib/sms-lifecycle');
const {
  buildRideReminderMessage, createRideReminders, RIDE_SMS_CONSENT
} = require('../src/lib/transit/ride-reminders');

test('ride text is one GSM segment, identifies Silver Glider, and avoids unverified last bus promises', () => {
  const body = buildRideReminderMessage({
    slug: 'd9e4af7eb10fbfe1',
    leaveByAt: Date.parse('2026-12-12T08:35:00Z')
  });
  assert.deepEqual(smsSegments(body), { encoding: 'GSM-7', units: body.length, segments: 1 });
  assert.match(body, /^Silver Glider: Leave by 12:35 AM for your ride\./);
  assert.match(body, /https:\/\/silvergliderevents\.com\/e\/d9e4af7eb10fbfe1\/getting-home\?from=text/);
  assert.match(body, / Reply STOP to opt out\.$/);
  assert.doesNotMatch(body, /last bus|guarantee|3225|\btoken\b/i);
  assert.match(RIDE_SMS_CONSENT, /one reminder for this event.*No marketing texts.*STOP/);
});

test('copy fails closed on invalid link identifiers or times', () => {
  assert.throws(() => buildRideReminderMessage({ slug: 'show?secret=abc', leaveByAt: 1 }), { code: 'schedule-changed' });
  assert.throws(() => buildRideReminderMessage({ slug: 'show', leaveByAt: Infinity }), { code: 'schedule-changed' });
  assert.throws(() => buildRideReminderMessage({ slug: 'z'.repeat(100), leaveByAt: 1 }), { code: 'schedule-changed' });
});

test('missing budget and implicit consent stop before database, transit or provider access', async () => {
  const bad = () => assert.fail('external operation must not run');
  const settings = {
    pool: { query: bad, connect: bad },
    getDeparture: bad,
    sendSms: bad,
    env: { TRANSIT_RIDE_REMINDERS_ENABLED: 'true', TRANSIT_SMS_DAILY_SEGMENT_CAP: '20' }
  };
  const disabled = createRideReminders(settings);
  assert.equal(await disabled.processDue(), 0);
  await assert.rejects(disabled.schedule({ eventId: 1, userId: 2, consent: true }), { code: 'unavailable' });
  const enabled = createRideReminders({
    ...settings, env: { ...settings.env, TRANSIT_SMS_LIFETIME_SEGMENT_CAP: '20' }
  });
  await assert.rejects(enabled.schedule({ eventId: 1, userId: 2, consent: 'true' }), { code: 'consent-required' });
  await assert.rejects(enabled.schedule({ eventId: 1, userId: 2 }), { code: 'consent-required' });
});
