'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRideEntry, rideEntryCookieName, rideEmailEntryPath, createReminderRideEntryPath, RIDE_ENTRY_MAX_AGE_MS } = require('../src/lib/transit/ride-entry');
const { createRideMetrics } = require('../src/lib/transit/ride-metrics');

const SECRET = 'test-key-for-transit-scope-only';
const START = Date.parse('2026-11-27T16:00Z');
const DAY = 86_400_000;
const event = { id: 91, slug: 'night-at-the-room', status: 'published', visibility: 'public', timezone: 'America/Los_Angeles',
  venue_name: 'Make-Out Room', venue_address: '3225 22nd St., San Francisco, CA', ends_at: new Date(START + DAY).toISOString() };
const rsvp = { id: 122, event_id: 91, status: 'confirmed', wants_reminders: true, email: 'guest@example.test', manage_token: 'private-manage-token' };
const env = { TRANSIT_GETTING_HOME_ENABLED: 'true', TRANSIT_DISTRIBUTION_ENABLED: 'true', SESSION_SECRET: SECRET };

test('email and read-only browser grants are purpose-scoped and site-bound by a verified event claim', () => {
  let time = START;
  const entry = createRideEntry({ secret: SECRET, now: () => time });
  const token = entry.issue({ eventId: 91, rsvpId: 122, expiresAt: START + DAY });
  const claims = entry.verify(token, { eventId: 91 });
  assert.deepEqual(claims, { eventId: 91, rsvpId: 122, issuedAt: START, expiresAt: START + DAY });
  assert.ok(token.length <= 100);
  assert.equal(entry.verify(token.replace(/^91\./, '92.')), null);
  assert.equal(entry.verify(token.replace('.122.', '.123.')), null);
  assert.equal(entry.verify(token, { eventId: 92 }), null);
  assert.equal(createRideEntry({ secret: 'other', now: () => time }).verify(token), null);
  assert.equal(entry.verifyCookie(token, { eventId: 91 }), null);
  time += 5_000;
  const cookie = entry.issueCookie(claims);
  assert.notEqual(cookie, token);
  assert.equal(entry.verify(cookie), null);
  assert.equal(entry.verifyCookie(cookie), null);
  assert.equal(entry.verifyCookie(cookie, { eventId: 92 }), null);
  assert.deepEqual(entry.verifyCookie(cookie, { eventId: 91 }), { ...claims, issuedAt: START + 5_000 });
  assert.equal(rideEntryCookieName(91), 'sge_ride_access_91');
  assert.equal(rideEntryCookieName('91;'), null);
  time += DAY;
  assert.equal(entry.verify(token), null);
  assert.equal(entry.verifyCookie(cookie, { eventId: 91 }), null);
});

test('token age is capped and the issuer fails closed for invalid inputs, missing key or event already over', () => {
  const entry = createRideEntry({ secret: SECRET, now: () => START });
  const token = entry.issue({ eventId: 91, rsvpId: 122, expiresAt: new Date(START + 30 * DAY) });
  assert.equal(entry.verify(token).expiresAt, START + RIDE_ENTRY_MAX_AGE_MS);
  assert.equal(createRideEntry({ secret: SECRET, now: () => START - 1000 }).verify(token), null);
  const params = { eventId: 91, rsvpId: 122, expiresAt: START + DAY };
  for (const invalid of [{ ...params, expiresAt: START }, { ...params, expiresAt: Infinity }, { ...params, expiresAt: '4000' },
    { ...params, eventId: '91' }, { ...params, eventId: 2 ** 31 }, { ...params, rsvpId: -1 }]) {
    assert.equal(entry.issue(invalid), null);
  }
  for (const invalid of [null, [], 'x'.repeat(101), `.${token}`, `${token}=`]) assert.equal(entry.verify(invalid), null);
  assert.equal(createRideEntry({ secret: '', now: () => START }).issue(params), null);
});

test('day-before helper issues only a public eligible, current, opted-in RSVP URL without contact or manage credentials', () => {
  const getPath = overrides => rideEmailEntryPath({ event, rsvp, env, now: () => START, ...overrides });
  const url = getPath();
  assert.match(url, /^\/e\/night-at-the-room\/getting-home\/from-email\?t=/);
  assert.doesNotMatch(url, /guest@example\.test|private-manage-token/);
  const token = new URL(url, 'https://example.test').searchParams.get('t');
  assert.equal(createRideEntry({ secret: SECRET, now: () => START }).verify(token).rsvpId, rsvp.id);
  for (const target of [{ ...event, slug: '//evil.test' }, { ...event, timezone: 'America/New_York' }, { ...event, status: 'draft' },
    { ...event, ends_at: new Date(START).toISOString() }, { ...event, venue_name: 'SOMA Other Room' }, { ...event, visibility: 'private' },
    { ...event, hide_address_until_rsvp: true }, { ...event, secret_show_enabled: true }]) assert.equal(getPath({ event: target }), null);
  assert.equal(getPath({ rsvp: { ...rsvp, status: 'declined' } }), null);
  assert.equal(getPath({ rsvp: { ...rsvp, event_id: 90 } }), null);
  assert.equal(getPath({ rsvp: { ...rsvp, wants_reminders: false } }), null);
  for (const flag of ['TRANSIT_GETTING_HOME_ENABLED', 'TRANSIT_DISTRIBUTION_ENABLED', 'SESSION_SECRET']) {
    assert.equal(getPath({ env: { ...env, [flag]: '' } }), null);
  }
});

test('city reminder links require confirmed coverage and survive the show, not the service night', async () => {
  let current = START;
  let ready = true;
  let allowed = true;
  let lookups = 0;
  const cityEvent = { ...event, venue_name: 'Public room', venue_address: '1725 Haight St, San Francisco, CA, USA',
    venue_city: 'San Francisco', venue_state: 'CA', google_place_id: 'venue-fixture',
    venue_latitude: 37.77, venue_longitude: -122.45, event_date: '2026-11-27', start_time: '19:00',
    end_time: '22:00', ends_at: '2026-11-28T06:00:00Z' };
  const cityEnv = { ...env, TRANSIT_SF_GETTING_HOME_ENABLED: 'true', GEOAPIFY_API_KEY: 'fixture' };
  const input = { event: cityEvent, rsvp: { ...rsvp, reminder_queued_at: new Date(START) }, env: cityEnv, now: () => current,
    rolloutEnabled: async () => allowed, coverage: { async getReadyWalks() { lookups++; return ready ? [{ stopId: 'fixture' }] : []; } } };
  const path = await createReminderRideEntryPath(input);
  assert.match(path, /\/from-email\?t=/);
  const token = new URL(path, 'https://example.test').searchParams.get('t');
  const entry = createRideEntry({ secret: SECRET, now: () => current });
  current += 60_000;
  assert.equal(await createReminderRideEntryPath(input), path, 'the same claimed send produces the same link on retry');
  ready = false;
  assert.equal(await createReminderRideEntryPath(input), null);
  ready = true;
  allowed = false;
  assert.equal(await createReminderRideEntryPath(input), null);
  assert.equal(lookups, 3);
  allowed = true;
  for (const patch of [{ visibility: 'private' }, { hide_address_until_rsvp: true }, { archived_at: '2026-11-25' }, { google_place_id: null }]) {
    assert.equal(await createReminderRideEntryPath({ ...input, event: { ...cityEvent, ...patch } }), null);
  }
  for (const patch of [{ wants_reminders: false }, { status: 'declined' }, { event_id: 1 }]) {
    assert.equal(await createReminderRideEntryPath({ ...input, rsvp: { ...input.rsvp, ...patch } }), null);
  }
  assert.equal(lookups, 3);
  current = Date.parse('2026-11-28T07:00:00Z');
  assert.equal(entry.verify(token).expiresAt, Date.parse('2026-11-28T12:00:00Z'));
  current = Date.parse('2026-11-28T12:00:00Z');
  assert.equal(entry.verify(token), null);
});

function analyticsFixture() {
  const data = { time: START, samples: new Map(), totals: new Map(), repeats: new Map(), calls: [] };
  const db = { async query(sql, params) {
    data.calls.push({ sql, params });
    if (sql.includes('DELETE')) {
      let deleted = 0;
      for (const table of [data.samples, data.repeats]) {
        for (const [key, { expiration }] of table) if (expiration <= params[0]) {
          table.delete(key);
          deleted++;
        }
      }
      return { rows: [{ deleted }] };
    }
    const [eventId, kind, digest, repeat, first, expiration, date] = params;
    const sample = [eventId, kind, digest].join('|');
    if (data.samples.has(sample)) return { rowCount: 0 };
    data.samples.set(sample, { expiration });
    const increment = metric => {
      const index = `${eventId}:${metric}`;
      data.totals.set(index, (data.totals.get(index) || 0) + 1);
    };
    increment(kind);
    if (!repeat) return { rowCount: 1 };
    const existing = data.repeats.get(repeat);
    if (!existing || existing.expiration <= date) data.repeats.set(repeat, { first, expiration });
    if (existing?.expiration > date && existing?.first !== first) {
      increment('repeat_open');
      return { rowCount: 2 };
    }
    return { rowCount: 1 };
  } };
  return { data, metrics: createRideMetrics({ db, secret: SECRET, now: () => data.time }) };
}

test('analytics dedup within an event, count repeat use for known guests across events, and send no raw guest/route details to SQL', async () => {
  const { data, metrics } = analyticsFixture();
  const who = { kind: 'page_open', eventId: 91, userId: 999, rsvpId: 122, ip: '10.0.0.1', selection: { stopId: 'stop-foo' } };
  assert.equal(await metrics.record(who), true);
  assert.equal(await metrics.record({ ...who, userId: undefined }), false);
  assert.equal(await metrics.record({ ...who, eventId: 92, rsvpId: 123 }), true);
  assert.equal(await metrics.record({ ...who, eventId: 93, rsvpId: 124, userId: undefined }), true);
  assert.equal(await metrics.record({ ...who, kind: 'route_selected' }), true);
  for (const kind of ['email_link_open', 'text_link_open', 'reminder_requested', 'reminder_sent']) {
    assert.equal(await metrics.record({ ...who, kind }), true);
  }
  assert.equal(data.totals.get('91:page_open'), 1);
  assert.equal(data.totals.get('92:repeat_open'), 1);
  assert.equal(data.totals.get('93:repeat_open'), undefined);
  const [first, duplicate, other, anonymous, route] = data.calls;
  assert.match(first.params[2], /^[0-9a-f]{40}$/);
  assert.equal(first.params[2], duplicate.params[2]);
  assert.notEqual(first.params[2], other.params[2]);
  assert.equal(first.params[3], other.params[3]);
  assert.notEqual(first.params[4], other.params[4]);
  assert.equal(anonymous.params[3], null);
  assert.equal(route.params[3], null);
  assert.deepEqual(first.params.filter(value => typeof value === 'number'), [91]);
  assert.ok(data.calls.every(({ params }) => !params.includes('stop-foo') && !params.includes('10.0.0.1')));
  assert.match(first.sql, /ON CONFLICT DO NOTHING RETURNING event_id,metric/);
  assert.match(first.sql, /transit_ride_totals\.unique_count\+1/);
});

test('analytics prune short-lived digests without touching aggregates; telemetry failures are optional', async () => {
  const { data, metrics } = analyticsFixture();
  assert.equal(await metrics.record({ kind: 'repeat_open', eventId: 91, userId: 999 }), false);
  assert.equal(await metrics.record({ kind: 'page_open', eventId: 91 }), false);
  assert.equal(data.calls.length, 0);
  await metrics.record({ kind: 'page_open', eventId: 91, userId: 999, rsvpId: 122 });
  assert.equal(await metrics.prune(), 0);
  data.time += 46 * DAY;
  assert.equal(await metrics.prune(), 2);
  assert.equal(data.totals.get('91:page_open'), 1);
  assert.equal(await metrics.record({ kind: 'page_open', eventId: 92, userId: 999, rsvpId: 123 }), true);
  assert.equal(data.totals.get('92:repeat_open'), undefined);
  const down = createRideMetrics({ db: { async query() { throw new Error('private DB detail'); } }, secret: SECRET });
  assert.equal(await down.record({ kind: 'page_open', eventId: 91, userId: 999 }), false);
  assert.equal(await down.prune(), 0);
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/migrations/091_transit_ride_metrics.sql'), 'utf8');
  assert.doesNotMatch(schema, /\b(?:ip_address|user_agent|user_id|rsvp_id|phone|email|stop_id|first_event_id)\s+\w+/i);
});
