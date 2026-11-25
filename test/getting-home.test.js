'use strict';

process.env.SESSION_SECRET ||= 'getting-home-unit-test-only';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGettingHome, gettingHomeEligible, readTransitSelection } = require('../src/lib/transit/getting-home');
const { accessForGettingHome, verifiedRideUser } = require('../src/routes/getting-home');
const { attendeeCookieName } = require('../src/lib/private-events');

const env = { TRANSIT_GETTING_HOME_ENABLED: 'true' };
const now = () => Date.parse('2026-11-28T03:00:00Z');
const event = {
  id: 10, slug: 'abc123', status: 'published', visibility: 'public', timezone: 'America/Los_Angeles',
  venue_name: 'Make-Out Room', venue_address: '3225 22nd St, San Francisco, CA',
  ends_at: '2026-11-28T10:00:00Z'
};
const choice = { stopId: 'SF:15562', routeId: 'SF:14', direction: '0', headsign: 'Downtown' };

test('pilot flag and exact public venue gate everything, even if there is an RSVP', () => {
  assert.equal(gettingHomeEligible(event, env, now()), true);
  assert.equal(gettingHomeEligible(event, {}, now()), false);
  for (const override of [{ visibility: 'private' }, { status: 'cancelled' }, { status: 'hidden' }, { secret_show_enabled: true }, { hide_address_until_rsvp: true }, { venue_address: '1234 22nd St, San Francisco CA' }, { ends_at: '2026-11-27T11:00:00Z' }]) {
    assert.equal(gettingHomeEligible({ ...event, ...override }, env, now()), false);
  }
});

test('authorized planning and send-time rechecks stay available after the show through the same service night', () => {
  const evening = { ...event, event_date: '2026-11-27', start_time: '19:00', ends_at: '2026-11-28T05:00:00Z' };
  assert.equal(gettingHomeEligible(evening, env, Date.parse('2026-11-28T08:00:00Z')), true);
  assert.equal(gettingHomeEligible(evening, env, Date.parse('2026-11-28T12:00:00Z')), false);
  const late = { ...evening, event_date: '2026-11-28', start_time: '01:30', ends_at: '2026-11-28T11:00:00Z' };
  assert.equal(gettingHomeEligible(late, env, Date.parse('2026-11-28T11:59:00Z')), true);
  assert.equal(gettingHomeEligible(late, env, Date.parse('2026-11-28T12:00:00Z')), false);
});

test('signed-in account wins over a stale other-guest cookie; signed-out attendee still needs a confirmed token', async () => {
  const cookie = `${attendeeCookieName(event.id)}=fixture-token`;
  const request = { params: { slug: event.slug }, headers: { cookie } };
  const calls = [];
  const db = { query: async (sql, args) => {
    calls.push({ sql, args });
    return { rows: calls.length % 2 === 1 ? [event] : [{ id: 21, user_id: 3 }] };
  } };
  assert.equal((await accessForGettingHome(db, request, { env, now })).rsvp.id, 21);
  assert.deepEqual(calls[1].args, [10, null, null, 'fixture-token']);
  assert.match(calls[1].sql, /status='confirmed'/);
  await accessForGettingHome(db, { ...request, sessionAccount: { id: 2, user_id: 3 } }, { env, now });
  assert.deepEqual(calls[3].args, [10, 3, 2, '']);
  assert.equal(await accessForGettingHome(db, { ...request, headers: {} }, { env, now }), null);
  assert.equal(calls.length, 5);
  assert.equal(await accessForGettingHome(db, request, { env: {}, now }), null);
  assert.equal(calls.length, 5);
});

test('only schedule identifiers and short direction labels enter the lookup', () => {
  assert.deepEqual(readTransitSelection({ ...choice, phone: 'not-retained', departureAt: 12 }), choice);
  assert.equal(readTransitSelection({ ...choice, direction: '99' }), null);
  assert.equal(readTransitSelection({ ...choice, stopId: 'evil\nsecond' }), null);
  assert.equal(readTransitSelection({ stationId: '24TH', destinationStationId: '24TH' }), null);
  assert.deepEqual(readTransitSelection({ stationId: 'BA:24TH', destinationStationId: 'BA:FRMT' }), { stationId: 'BA:24TH', destinationStationId: 'BA:FRMT' });
});

test('a bare RSVP cookie cannot request a text or claim a saved preference', async () => {
  let guest;
  const db = { query: async () => ({ rows: guest ? [guest] : [] }) };
  const rsvp = { id: 21, user_id: 3 };
  const req = { headers: { cookie: `${attendeeCookieName(event.id)}=example` }, gettingHome: { event, rsvp } };
  assert.equal(await verifiedRideUser(db, req), null);
  guest = { user_id: 3, verified_at: new Date(), verified_event_id: 10 };
  const proof = { ...req, headers: { cookie: 'sge_guest=event-proof' } };
  assert.equal(await verifiedRideUser(db, proof), 3);
  assert.equal(await verifiedRideUser(db, proof, { accountWide: true }), null);
  guest.verified_event_id = null;
  assert.equal(await verifiedRideUser(db, proof, { accountWide: true }), 3);
  guest.user_id = 12;
  assert.equal(await verifiedRideUser(db, proof), null);
  assert.equal(await verifiedRideUser(db, { ...req, gettingHome: { event, rsvp, signedInUserId: 3 } }), 3);
  assert.equal(await verifiedRideUser(db, { ...req, gettingHome: { event, rsvp, signedInUserId: 12 } }), null);
});

test('leave-by subtracts walk and buffer, and proposed text is 30 minutes before leave-by', async () => {
  const departureAt = Date.parse('2026-11-28T08:50:00Z');
  const raw = { status: 'scheduled', timing: 'scheduled', timezone: event.timezone, fetchedAt: now(), departureAt, stopName: 'Mission at 22nd', walkSeconds: 120, tripId: 'internal' };
  const home = createGettingHome({ env, now, transit: { getDeparture: async () => raw } });
  const planned = await home.getDeparture(event, choice);
  assert.equal(planned.departureAt, departureAt);
  assert.equal(planned.leaveByAt, Date.parse('2026-11-28T08:43:00Z'));
  assert.equal(planned.proposedReminderAt, Date.parse('2026-11-28T08:13:00Z'));
  assert.equal('tripId' in planned, false);
  raw.timing = 'feed-estimate';
  assert.equal((await home.getDeparture(event, choice)).proposedReminderAt, null);
  raw.timing = 'scheduled';
  raw.departureAt = now() + 10 * 60_000;
  assert.equal((await home.getDeparture(event, choice)).proposedReminderAt, null);
  raw.departureAt = now() - 1000;
  assert.equal((await home.getDeparture(event, choice)).status, 'no-service');
});

test('unverified regional stops and exact venue addresses do not leave the options handler', async () => {
  const home = createGettingHome({ env, now, transit: { getOptions: async () => ({ status: 'available', stops: [], unverifiedStops: [{}] }) } });
  const options = await home.getOptions(event);
  assert.equal(options.directionsUrl, '/e/abc123#event-location-map');
  assert.equal(Object.hasOwn(options, 'unverifiedStops'), false);
  assert.equal(JSON.stringify(options).includes('3225'), false);
});
