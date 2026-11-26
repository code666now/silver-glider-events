'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVenueTester, TESTER_MAX_AGE } = require('../src/lib/transit/venue-tester');

const START = Date.parse('2026-11-27T10:30:00Z'); // 2:30 a.m. in San Francisco.
const env = { SESSION_SECRET: 'tester-session-purpose-only', TRANSIT_GETTING_HOME_ENABLED: 'true',
  TRANSIT_SF_GETTING_HOME_ENABLED: 'true', TRANSIT_511_API_KEY: 'fixture', GEOAPIFY_API_KEY: 'fixture' };
const scope = { operatorId: 12, sessionIssuedAt: START - 60_000 };
const choice = { name: 'Kilowatt', address: '3160 16th St, San Francisco, CA 94103, USA', city: 'San Francisco',
  state: 'CA', placeId: 'fixture-kilowatt', lat: 37.765, lng: -122.422 };
const walk = { stopId: 'SF:1601', lat: 37.765, lon: -122.42, walkSeconds: 240 };

function fixture() {
  let clock = START;
  const state = { connected: 0, prepared: 0, locked: true, charged: [], released: [], writes: [], cache: new Map(), exhausted: false, walks: [walk] };
  const db = {
    async query(sql, args) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: state.locked }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
      if (sql.includes('SELECT walks FROM transit_sf_venue_coverage')) {
        const row = state.cache.get(args[0]);
        return { rows: row && row.expires > args[1] ? [{ walks: row.walks }] : [] };
      }
      if (sql.includes('INSERT INTO transit_sf_walk_reservations')) {
        assert.match(sql, /INTERVAL '24 hours'/);
        assert.equal(args[1], 2400);
        state.charged.push(args[0]);
        return { rowCount: state.exhausted ? 0 : 1 };
      }
      if (sql.includes('INSERT INTO transit_sf_venue_coverage')) {
        state.writes.push(args[0]);
        state.cache.set(args[0], { walks: JSON.parse(args[1]), expires: args[2] });
        return { rowCount: 1 };
      }
      assert.fail(`Unexpected query: ${sql}`);
    },
    async connect() {
      state.connected++;
      return { query: db.query, release(discard) { state.released.push(discard); } };
    }
  };
  const tester = createVenueTester({ db, env, now: () => clock, async prepareVenue(event, venue, reserve) {
    state.prepared++;
    assert.equal(event.venue_name, choice.name);
    assert.equal(event.event_date, '2026-11-26');
    assert.equal(venue.address, '3160 16TH ST');
    assert.equal(await reserve(2), true);
    assert.equal(await reserve(2), false);
    return state.walks;
  } });
  return { tester, state, advance: ms => { clock += ms; } };
}

test('a selected venue reuses the verified venue cache and creates only a short-lived operator/session-bound grant', async () => {
  const { tester, state, advance } = fixture();
  const token = await tester.prepare({ ...choice, secret_show_enabled: true }, scope);
  assert.ok(token.length < 1800);
  assert.deepEqual(state.charged, [2]);
  assert.equal(state.prepared, 1);
  assert.deepEqual(state.released, [false]);
  const event = await tester.read(token, scope);
  assert.equal(event.venue_name, choice.name);
  assert.equal(event.event_date, '2026-11-26');
  assert.equal(event.ends_at, Date.parse('2026-11-27T12:00:00Z'));
  assert.deepEqual(event.sfWalks, [walk]);
  assert.equal(event.secret_show_enabled, undefined);
  assert.equal(await tester.read(token, { ...scope, operatorId: 13 }), null);
  assert.equal(await tester.read(token, { ...scope, sessionIssuedAt: START - 42_000 }), null);
  assert.equal(await tester.read(`${token}A`, scope), null);
  assert.equal(await tester.read(token.replace(/^[^.]/, value => value === 'a' ? 'b' : 'a'), scope), null);
  advance(TESTER_MAX_AGE);
  assert.equal(await tester.read(token, scope), null);
  assert.ok(await tester.prepare(choice, scope));
  assert.equal(state.prepared, 1);
  assert.equal(state.connected, 1);
  assert.equal(state.writes.length, 1);
});

test('invalid venues fail before provider work and an exhausted shared walking budget fails closed', async () => {
  const { tester, state } = fixture();
  for (const selection of [{ ...choice, city: 'Oakland' }, { ...choice, lat: 36 }, { ...choice, lat: '37.765' },
    { ...choice, address: 'Kilowatt', placeId: '' }, { ...choice, address: '3160 16th St, Oakland, CA 94601' }]) {
    await assert.rejects(tester.prepare(selection, scope), { code: 'sf_venue_required' });
  }
  await assert.rejects(tester.prepare(choice, { ...scope, operatorId: 0 }), { code: 'session_required' });
  assert.equal(state.connected, 0);
  state.locked = false;
  await assert.rejects(tester.prepare(choice, scope), { code: 'coverage_busy' });
  assert.equal(state.prepared, 0);
  state.locked = true;
  state.exhausted = true;
  await assert.rejects(tester.prepare(choice, scope), { code: 'walk_budget' });
  assert.equal(state.writes.length, 0);
  assert.deepEqual(state.released, [false, false]);
});

test('a venue with no verified walking routes is still an authorized empty result; pilot walks need no extra credits', async () => {
  const { tester, state } = fixture();
  state.walks = [];
  const token = await tester.prepare(choice, scope);
  assert.deepEqual((await tester.read(token, scope)).sfWalks, []);
  await tester.prepare(choice, scope);
  assert.equal(state.prepared, 1);
  const pilot = await tester.prepare({ ...choice, name: 'Make-Out Room', address: '3225 22nd St, San Francisco, CA 94110, USA' }, scope);
  assert.equal((await tester.read(pilot, scope)).venue_name, 'Make-Out Room');
  assert.equal(state.prepared, 1);
});
