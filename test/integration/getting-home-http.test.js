'use strict';

process.env.SESSION_SECRET ||= 'getting-home-http-test-only';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createGettingHomeRouter } = require('../../src/routes/getting-home');
const { createRideEntry, createReminderRideEntryPath, rideEntryCookieName } = require('../../src/lib/transit/ride-entry');
const { createRidePreview, PREVIEW_PATH, PREVIEW_SLUG, PREVIEW_COOKIE } = require('../../src/lib/transit/ride-preview');
const { createRideReminders, CONSENT_VERSION, RIDE_SMS_CONSENT } = require('../../src/lib/transit/ride-reminders');
const { sfCoverageInput } = require('../../src/lib/transit/sf-coverage-store');

const START = Date.parse('2026-11-28T03:00:00Z');
const END = '2026-11-28T09:00:00Z';
const SERVICE_NIGHT_END = Date.parse('2026-11-28T12:00:00Z');
const JOIN_LINK_SECRET = 'synthetic-ride-email-link-secret';
const scenario = {
  id: 10, slug: 'night-at-the-room', organizer_id: 50, status: 'published', visibility: 'public',
  timezone: 'America/Los_Angeles', venue_name: 'Make-Out Room', venue_address: '3225 22nd St., San Francisco, CA',
  event_date: '2026-11-27', start_time: '19:00', end_time: '01:00', ends_at: END
};
const guest = { id: 21, event_id: scenario.id, user_id: 3, status: 'confirmed', wants_reminders: true, phone: '+14155550132' };
const choice = { stopId: 'SF:15562', routeId: 'SF:14', direction: '0', headsign: 'Downtown' };
const cityWalk = { stopId: choice.stopId, lat: 37.784, lon: -122.407, walkSeconds: 240 };
const cityVenue = { ...scenario, venue_name: 'City fixture', venue_address: '801 Market St, San Francisco, CA 94103, USA',
  venue_city: 'San Francisco', venue_state: 'CA', venue_latitude: 37.784, venue_longitude: -122.407, google_place_id: 'fixture-place' };
const verifiedPlan = {
  status: 'scheduled', timing: 'scheduled', departureAt: Date.parse('2026-11-28T08:50:00Z'),
  leaveByAt: Date.parse('2026-11-28T08:43:00Z'), proposedReminderAt: Date.parse('2026-11-28T08:13:00Z'),
  fetchedAt: START, timezone: 'America/Los_Angeles', stopName: 'Mission at 22nd', walkSeconds: 120
};
const upcoming = { context: 'leaving-now', includesLast: false, departures: [
  { departureAt: Date.parse('2026-11-28T05:00:00Z'), timing: 'scheduled' },
  { departureAt: Date.parse('2026-11-28T05:30:00Z'), timing: 'scheduled' }
] };
const { proposedReminderAt: _smsTime, ...readOnlyPlan } = verifiedPlan;
const page = `/e/${scenario.slug}/getting-home`;
const api = `/api/public/events/${scenario.slug}/getting-home`;
const result = (...rows) => ({ rows, rowCount: rows.length });

async function fixture(t) {
  const env = {
    NODE_ENV: 'production', SESSION_SECRET: JOIN_LINK_SECRET,
    TRANSIT_GETTING_HOME_ENABLED: 'true', TRANSIT_DISTRIBUTION_ENABLED: 'true', TRANSIT_RIDE_REMINDERS_ENABLED: 'true',
    TRANSIT_SMS_DAILY_SEGMENT_CAP: '2', TRANSIT_SMS_LIFETIME_SEGMENT_CAP: '5', TRANSIT_511_API_KEY: 'fixture-only-511-key'
  };
  const events = new Map([[scenario.id, { ...scenario }], [11, { ...scenario, id: 11, slug: 'another-night' }]]);
  const rsvps = new Map([[guest.id, { ...guest }]]);
  const metricsCalls = [];
  const savedCalls = [];
  const writes = [];
  const departures = [];
  let cityReady = null;
  let cityEnabled = false;
  let scheduleAvailable = true;
  let coverageReads = 0;
  let current = START;
  const now = () => current;
  let pending = null;

  function confirmed(row, sql) {
    return row && (!/\bstatus\s*=\s*'confirmed'/i.test(sql) || row.status === 'confirmed')
      && (!/\bwants_reminders\s*=\s*(?:true|TRUE)/.test(sql) || row.wants_reminders);
  }

  const db = {
    async connect() { return { query: db.query, release() {} }; },
    async query(sql, args = []) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.includes('pg_advisory_xact_lock')) return result();

      if (/FROM events e\b/.test(sql)) {
        const event = [...events.values()].find(item => args.includes(item.slug) || args[0] === item.id);
        return event ? result(event) : result();
      }
      if (/FROM rsvps r JOIN users guest/.test(sql)) {
        const row = [...rsvps.values()].find(item => item.event_id === args[0] && item.user_id === args[1]
          && (args[2] == null || args[2] === item.id) && confirmed(item, sql));
        return row ? result(row) : result();
      }
      if (/FROM rsvps\b/.test(sql)) {
        const row = [...rsvps.values()].find(item => {
          if (!confirmed(item, sql)) return false;
          if (/manage_token/.test(sql)) {
            const [eventId, userId, , attendeeToken] = args;
            return item.event_id === eventId && (item.user_id === userId || attendeeToken === 'fixture-attendee-cookie');
          }
          return item.event_id === args[0] && item.id === args[1];
        });
        return row ? result(row) : result();
      }
      if (/FROM transit_sf_rollout\b/.test(sql)) return result({ enabled: cityEnabled });
      if (/FROM transit_sf_event_coverage\b/.test(sql)) {
        coverageReads++;
        return cityReady && args[0].includes(String(cityReady.event_id)) && args[1].getTime() < SERVICE_NIGHT_END
          ? result(cityReady) : result();
      }
      if (/FROM guest_sessions\b/.test(sql)) return result();
      if (/FROM user_identities\b/.test(sql)) return result({ id: 901, phone: guest.phone });
      if (/FROM transit_ride_sms_optouts\b/.test(sql)) return result();
      if (/FROM transit_ride_sms_usage\b|COUNT\(\*\).*FROM transit_ride_reminders/is.test(sql)) return result({ today: 0, total: 0 });
      if (/INSERT INTO transit_ride_reminders\b/.test(sql)) {
        writes.push({ sql, args });
        pending = { status: 'pending', reminder_at: args[6], attempted_at: null };
        return result(pending);
      }
      if (/FROM transit_ride_reminders\b/.test(sql)) return pending ? result(pending) : result();
      throw new Error('Unexpected fixture query');
    }
  };
  const home = {
    async getOptions(event) {
      if (!scheduleAvailable) return { status: 'schedule-unavailable' };
      const stops = (event.sfWalks || [cityWalk]).map(({ stopId, walkSeconds }) => ({ stopId, walkSeconds, routes: [choice] }));
      return { status: 'available', venue: event.venue_name, stops };
    },
    async getDeparture(event, selection, options) {
      assert.deepEqual(selection, choice);
      departures.push({ eventId: event.id, selection, options, at: now() });
      return options?.includeUpcoming ? { ...verifiedPlan, upcoming } : verifiedPlan;
    }
  };
  const reminders = createRideReminders({ pool: db, getDeparture: home.getDeparture, env, now,
    async sendSms() { assert.fail('No HTTP test may send a text'); } });
  const saved = Object.fromEntries(['get', 'save', 'remove', 'status'].map(action => [action, async args => {
    savedCalls.push({ action, args });
    return { status: 'none' };
  }]));
  const entry = createRideEntry({ secret: env.SESSION_SECRET, now });
  const metrics = { async record(input) { metricsCalls.push(input); return true; }, async prune() { return 0; } };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const session = req.get('x-fixture-session');
    req.sessionAccount = session === 'owner' ? { id: 3, user_id: 3 } : session === 'other' ? { id: 4, user_id: 4 } : null;
    next();
  });
  app.use(createGettingHomeRouter({ db, env, now, home, reminders, saved, metrics }));
  let unexpected;
  app.use((error, _req, res, _next) => { unexpected = error; res.status(500).json({ error: 'fixture-error' }); });
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections?.();
    });
    if (unexpected) throw unexpected;
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    events, rsvps, metricsCalls, savedCalls, writes, departures, env, entry,
    setCityReady(value) {
      const input = value && sfCoverageInput(events.get(scenario.id));
      assert.ok(!value || input, 'only eligible event inputs have verified coverage');
      cityReady = input ? { event_id: input.id, venue_key: input.venue.key, input_version: input.version, walks: [cityWalk] } : null;
    },
    setCityEnabled(value) { cityEnabled = value; },
    setScheduleAvailable(value) { scheduleAvailable = value; },
    coverageReads() { return coverageReads; },
    advance(ms) { current += ms; },
    link() { return createReminderRideEntryPath({ db, event: events.get(scenario.id), rsvp: rsvps.get(guest.id), env, now }); },
    previewLink() { return createRidePreview({ env, now }).issueLink('2026-11-27'); },
    fetch(url, options = {}) { return fetch(`${base}${url}`, { redirect: 'manual', ...options }); }
  };
}

const denied = response => {
  assert.ok([401, 403, 404, 410].includes(response.status), `Expected denied response, got ${response.status}`);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('location'), null);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
};

test('SF planner is for confirmed guests with ready public Places coverage; analytics do not enable messages', async t => {
  const f = await fixture(t);
  const venue = { ...cityVenue };
  f.events.set(scenario.id, venue);
  Object.assign(f.env, { TRANSIT_DISTRIBUTION_ENABLED: 'false', TRANSIT_SF_GETTING_HOME_ENABLED: 'true', GEOAPIFY_API_KEY: 'fixture-key' });
  const headers = { 'x-fixture-session': 'owner' };
  denied(await f.fetch(`${api}/options`));
  assert.equal(f.coverageReads(), 0);
  denied(await f.fetch(`${api}/options`, { headers }));
  assert.equal(f.coverageReads(), 0);
  f.setCityEnabled(true);
  denied(await f.fetch(`${api}/options`, { headers }));
  assert.equal(f.coverageReads(), 1);
  f.setCityReady(true);
  assert.equal((await f.fetch(page, { headers })).status, 200);
  assert.deepEqual(await (await f.fetch(`${api}/options`, { headers })).json(), { status: 'available', venue: 'City fixture',
    stops: [{ stopId: choice.stopId, walkSeconds: 240, routes: [choice] }] });
  const response = await f.fetch(`${api}/departure`, json('POST', choice, headers));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...readOnlyPlan, upcoming });
  assert.deepEqual(f.metricsCalls.map(record => record.kind), ['page_open', 'route_selected']);
  assert.equal((await (await f.fetch(`${api}/reminder`, { headers })).json()).status, 'unavailable');
  assert.equal((await (await f.fetch(`${api}/saved-route`, { headers })).json()).status, 'not-eligible');
  assert.equal(await f.link(), null);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.savedCalls, []);
  f.setCityEnabled(false);
  denied(await f.fetch(`${api}/options`, { headers }));
  f.setCityEnabled(true);
  for (const override of [{ visibility: 'private' }, { hide_address_until_rsvp: true }, { secret_show_enabled: true }, { google_place_id: null }]) {
    f.events.set(scenario.id, { ...venue, ...override });
    denied(await f.fetch(`${api}/options`, { headers }));
  }
  f.events.set(scenario.id, venue);
  f.rsvps.get(guest.id).status = 'declined';
  denied(await f.fetch(`${api}/options`, { headers }));
});

async function redeem(f, original) {
  const url = original || await f.link();
  assert.ok(url, 'event reminder should get a scoped link');
  const response = await f.fetch(url);
  assert.ok([302, 303].includes(response.status));
  assert.equal(response.headers.get('location'), page);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const header = response.headers.get('set-cookie');
  const cookieName = rideEntryCookieName(scenario.id);
  assert.match(header || '', new RegExp(`^${cookieName}=`));
  assert.match(header, /\bHttpOnly\b/i);
  assert.match(header, /\bSameSite=Lax\b/i);
  assert.match(header, /\bSecure\b/i);
  assert.match(header, /\bMax-Age=[1-9][0-9]*\b/i);
  assert.doesNotMatch(header, /sge_session|sge_guest=|fixture-attendee-cookie/);
  const cookie = header.split(';', 1)[0];
  assert.equal(f.entry.verifyCookie(decodeURIComponent(cookie.slice(cookieName.length + 1)), { eventId: scenario.id }).rsvpId, guest.id);
  return cookie;
}

function json(method, body, headers = {}) {
  return { method, headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers }, body: JSON.stringify(body) };
}

test('real pilot guests record allowlisted interactions with delivery off, never analytics metadata', async t => {
  const f = await fixture(t);
  f.env.TRANSIT_DISTRIBUTION_ENABLED = 'false';
  f.env.TRANSIT_RIDE_REMINDERS_ENABLED = 'false';
  const headers = { 'x-fixture-session': 'owner' };
  denied(await f.fetch(`${api}/interaction`, json('POST', { kind: 'bus_click' })));
  denied(await f.fetch(`${api}/interaction`, json('POST', { kind: 'lyft_click' }, { ...headers, 'sec-fetch-site': 'cross-site' })));
  assert.equal((await f.fetch(`${api}/interaction`, json('POST', { kind: 'reminder_sent' }, headers))).status, 400);
  assert.equal(f.metricsCalls.length, 0);
  assert.equal((await f.fetch(page, { headers })).status, 200);
  for (const kind of ['bus_click', 'uber_click', 'lyft_click']) {
    const tracked = await f.fetch(`${api}/interaction`, json('POST', { kind, destination: 'must not be recorded', userId: 1000 }, headers));
    assert.equal(tracked.status, 204);
    assert.equal(await tracked.text(), '');
  }
  assert.deepEqual(f.metricsCalls, ['page_open', 'bus_click', 'uber_click', 'lyft_click'].map(kind => ({
    kind, eventId: scenario.id, rsvpId: guest.id, userId: guest.user_id
  })));
  const departure = await f.fetch(`${api}/departure`, json('POST', choice, headers));
  assert.deepEqual(await departure.json(), { ...readOnlyPlan, upcoming });
  assert.equal(f.writes.length, 0);
  f.rsvps.get(guest.id).status = 'declined';
  denied(await f.fetch(`${api}/interaction`, json('POST', { kind: 'bus_click' }, headers)));
});

test('a signed reminder link opens the planner directly; scraper GETs never increment email analytics', async t => {
  const f = await fixture(t);
  denied(await f.fetch(page));
  denied(await f.fetch(`${api}/options`));
  const link = await f.link();
  assert.equal((await f.fetch(link, { method: 'HEAD' })).headers.get('set-cookie'), null);
  const cookie = await redeem(f);
  const view = await f.fetch(page, { headers: { cookie } });
  assert.equal(view.status, 200);
  assert.equal(view.headers.get('location'), null);
  assert.match(await view.text(), /Getting home/i);
  const options = await f.fetch(`${api}/options`, { headers: { cookie } });
  assert.equal(options.status, 200);
  assert.deepEqual(await options.json(), { status: 'available', venue: 'Make-Out Room',
    stops: [{ stopId: choice.stopId, walkSeconds: 240, routes: [choice] }], emailEntry: true });
  f.setScheduleAvailable(false);
  assert.deepEqual(await (await f.fetch(`${api}/options`, { headers: { cookie } })).json(), { status: 'schedule-unavailable' });
  f.setScheduleAvailable(true);
  assert.deepEqual(f.metricsCalls, []);
  assert.deepEqual(f.departures, []);

  denied(await f.fetch(`${api}/interaction?from=email`, json('POST', { kind: 'email_link_open', from: 'email' })));
  denied(await f.fetch(`${api}/interaction?from=email`, json('POST', { kind: 'email_link_open', from: 'email' },
    { 'x-fixture-session': 'owner' })));
  f.rsvps.set(22, { ...guest, id: 22, user_id: 4 });
  denied(await f.fetch(`${api}/interaction`, json('POST', { kind: 'email_link_open' },
    { cookie, 'x-fixture-session': 'other' })));
  assert.equal((await f.fetch(`${api}/interaction`, json('POST', { kind: 'email_link_open' }, { cookie }))).status, 204);
  const departure = await f.fetch(`${api}/departure`, json('POST', choice, { cookie }));
  assert.equal(departure.status, 200);
  assert.deepEqual(await departure.json(), { ...readOnlyPlan, upcoming });
  assert.deepEqual(f.departures, [{ eventId: scenario.id, selection: choice, options: { includeUpcoming: true }, at: START }]);
  denied(await f.fetch('/e/another-night/getting-home', { headers: { cookie } }));
  assert.deepEqual(f.metricsCalls.map(({ kind }) => kind), ['page_open', 'email_planner_open', 'route_selected']);
  assert.ok(f.metricsCalls.every(call => call.eventId === scenario.id && call.rsvpId === guest.id));
  assert.ok(f.metricsCalls.every(call => !Object.hasOwn(call, 'selection') && !Object.hasOwn(call, 'ip')));
});

test('wrong, expired, cancelled, and private event email links never mint or retain a ride grant', async t => {
  const f = await fixture(t);
  const original = await f.link();
  denied(await f.fetch(original.replace(scenario.slug, 'another-night')));
  denied(await f.fetch(`${original.slice(0, -1)}${original.endsWith('A') ? 'B' : 'A'}`));
  const cookie = await redeem(f);
  f.rsvps.get(guest.id).status = 'cancelled';
  denied(await f.fetch(original));
  denied(await f.fetch(page, { headers: { cookie } }));
  f.rsvps.get(guest.id).status = 'confirmed';
  f.rsvps.get(guest.id).wants_reminders = false;
  denied(await f.fetch(original));
  denied(await f.fetch(page, { headers: { cookie } }));
  f.rsvps.get(guest.id).wants_reminders = true;
  for (const patch of [{ visibility: 'private' }, { hide_address_until_rsvp: true }, { status: 'cancelled' }]) {
    f.events.set(scenario.id, { ...scenario, ...patch });
    denied(await f.fetch(original));
    denied(await f.fetch(`${api}/options`, { headers: { cookie } }));
  }
  f.events.set(scenario.id, { ...scenario });
  f.env.TRANSIT_DISTRIBUTION_ENABLED = 'false';
  denied(await f.fetch(original));
  denied(await f.fetch(page, { headers: { cookie } }));
  f.env.TRANSIT_DISTRIBUTION_ENABLED = 'true';
  f.advance(SERVICE_NIGHT_END - START);
  denied(await f.fetch(original));
  denied(await f.fetch(page, { headers: { cookie } }));
});

test('a citywide reminder requires a current verified public venue and reopens after the show', async t => {
  const f = await fixture(t);
  f.events.set(scenario.id, { ...cityVenue });
  Object.assign(f.env, { TRANSIT_SF_GETTING_HOME_ENABLED: 'true', GEOAPIFY_API_KEY: 'fixture-key',
    TRANSIT_RIDE_REMINDERS_ENABLED: 'false' });
  assert.equal(await f.link(), null);
  f.setCityEnabled(true);
  assert.equal(await f.link(), null);
  f.setCityReady(true);
  const original = await f.link();
  assert.ok(original);
  const cookie = await redeem(f, original);
  assert.equal((await f.fetch(page, { headers: { cookie } })).status, 200);
  const options = await f.fetch(`${api}/options`, { headers: { cookie } });
  assert.deepEqual(await options.json(), { status: 'available', venue: 'City fixture', emailEntry: true,
    stops: [{ stopId: choice.stopId, walkSeconds: 240, routes: [choice] }] });
  assert.deepEqual(f.metricsCalls, []);
  assert.equal((await f.fetch(`${api}/interaction`, json('POST', { kind: 'email_link_open' }, { cookie }))).status, 204);
  assert.deepEqual(f.metricsCalls.map(call => call.kind), ['page_open', 'email_planner_open']);
  const plan = await f.fetch(`${api}/departure`, json('POST', choice, { cookie }));
  assert.deepEqual(await plan.json(), { ...readOnlyPlan, upcoming });
  assert.equal((await (await f.fetch(`${api}/reminder`, { headers: { cookie } })).json()).status, 'unavailable');

  f.setCityReady(false);
  denied(await f.fetch(original));
  denied(await f.fetch(`${api}/options`, { headers: { cookie } }));
  f.setCityReady(true);
  f.setCityEnabled(false);
  denied(await f.fetch(original));
  denied(await f.fetch(`${api}/options`, { headers: { cookie } }));
  f.setCityEnabled(true);
  for (const override of [
    { visibility: 'private' }, { hide_address_until_rsvp: true }, { secret_show_enabled: true }, { google_place_id: null },
    { start_time: '20:00' }, { venue_address: '802 Market St, San Francisco, CA 94103, USA' }
  ]) {
    f.events.set(scenario.id, { ...cityVenue, ...override });
    assert.equal(await f.link(), null);
    const unavailable = await f.fetch(original);
    denied(unavailable);
    assert.doesNotMatch(await unavailable.text(), /City fixture|801 Market St|802 Market St/);
    denied(await f.fetch(page, { headers: { cookie } }));
  }
  f.events.set(scenario.id, { ...cityVenue });
  f.advance(Date.parse(END) - START + 1_000);
  const reopened = await redeem(f, original);
  assert.equal((await f.fetch(page, { headers: { cookie: reopened } })).status, 200);
  assert.equal((await (await f.fetch(`${api}/options`, { headers: { cookie: reopened } })).json()).emailEntry, true);
  f.advance(SERVICE_NIGHT_END - Date.parse(END) - 1_000);
  denied(await f.fetch(original));
  denied(await f.fetch(page, { headers: { cookie: reopened } }));
  assert.equal(f.writes.length, 0);
});

test('the email credential grants no saved-route or reminder authority', async t => {
  const f = await fixture(t);
  const cookie = await redeem(f);
  const preferences = await f.fetch(`${api}/saved-route`, { headers: { cookie } });
  assert.ok([200, 401, 403, 404].includes(preferences.status));
  assert.ok(['not-eligible', 'unavailable'].includes((await preferences.json()).status));
  const save = await f.fetch(`${api}/saved-route`, json('POST', { remember: true, selection: choice }, { cookie }));
  assert.ok(['not-eligible', 'unavailable'].includes((await save.json()).status));
  assert.equal((await f.fetch('/api/account/saved-transit-route', { headers: { cookie } })).status, 401);
  const reminder = await f.fetch(`${api}/reminder`, json('POST', {
    consent: true, selection: choice, expectedReminderAt: verifiedPlan.proposedReminderAt
  }, { cookie }));
  assert.ok(['identity-required', 'unavailable'].includes((await reminder.json()).status));
  assert.equal(f.savedCalls.length, 0);
  assert.equal(f.writes.length, 0);
});

test('only a verified, same-origin, explicit opt-in queues the event-specific consent version once', async t => {
  const f = await fixture(t);
  const auth = { 'x-fixture-session': 'owner' };
  const body = { selection: choice, expectedReminderAt: verifiedPlan.proposedReminderAt };
  const crossOrigin = await f.fetch(`${api}/reminder`, json('POST', { ...body, consent: true }, { ...auth, 'sec-fetch-site': 'cross-site' }));
  assert.equal(crossOrigin.status, 403);
  const status = await f.fetch(`${api}/reminder`, { headers: auth });
  assert.equal((await status.json()).consentLabel, RIDE_SMS_CONSENT);
  for (const consent of [undefined, 'true', false]) {
    const rejected = await f.fetch(`${api}/reminder`, json('POST', { ...body, consent }, auth));
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).status, 'consent-required');
  }
  assert.equal(f.writes.length, 0);
  for (let i = 0; i < 2; i++) {
    const accepted = await f.fetch(`${api}/reminder`, json('POST', { ...body, consent: true, consentVersion: 'client-cannot-label-this' }, auth));
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).status, 'pending');
  }
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0].args.slice(0, 3), [scenario.id, guest.user_id, guest.id]);
  assert.equal(f.writes[0].args[8], CONSENT_VERSION);
});

test('one test link opens the sample and schedules without real attendee authority', async t => {
  const f = await fixture(t);
  f.env.TRANSIT_TEST_PREVIEW_ENABLED = 'true';
  f.env.TRANSIT_DISTRIBUTION_ENABLED = 'false';
  const previewApi = `/api/public/events/${PREVIEW_SLUG}/getting-home`;
  denied(await f.fetch(PREVIEW_PATH));
  denied(await f.fetch(`${PREVIEW_PATH}/from-test?t=invalid`));
  const url = f.previewLink();
  const head = await f.fetch(url, { method: 'HEAD' });
  assert.equal(head.headers.get('set-cookie'), null);
  const response = await f.fetch(url);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), PREVIEW_PATH);
  const header = response.headers.get('set-cookie');
  assert.match(header, new RegExp(`^${PREVIEW_COOKIE}=`));
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  const cookie = header.split(';', 1)[0];
  const options = await f.fetch(`${previewApi}/options`, { headers: { cookie } });
  assert.equal((await options.json()).previewDate, '2026-11-27');
  assert.equal((await f.fetch(PREVIEW_PATH, { headers: { cookie } })).status, 200);
  denied(await f.fetch(page, { headers: { cookie } }));
  const plan = await f.fetch(`${previewApi}/departure`, json('POST', choice, { cookie }));
  assert.deepEqual(await plan.json(), { ...readOnlyPlan, upcoming });
  denied(await f.fetch(`${previewApi}/interaction`, json('POST', { kind: 'email_link_open' }, { cookie })));
  assert.equal((await f.fetch(`${previewApi}/interaction`, json('POST', { kind: 'uber_click' }, { cookie }))).status, 204);
  const reminder = await f.fetch(`${previewApi}/reminder`, json('POST', { consent: true, selection: choice }, { cookie }));
  assert.equal((await reminder.json()).status, 'unavailable');
  const saved = await f.fetch(`${previewApi}/saved-route`, json('POST', { remember: true, selection: choice }, { cookie }));
  assert.equal((await saved.json()).status, 'not-eligible');
  f.env.TRANSIT_DISTRIBUTION_ENABLED = 'true';
  assert.equal((await f.fetch(PREVIEW_PATH, { headers: { cookie } })).status, 200);
  assert.equal(f.metricsCalls.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.savedCalls.length, 0);
  f.advance(Date.parse('2026-11-28T12:00:00Z') - START);
  denied(await f.fetch(PREVIEW_PATH, { headers: { cookie } }));
});
