'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Pool } = require('pg');
const { createSfCoverageWorker } = require('../../src/jobs/sf-transit-coverage');
const { createSfCoverageStore } = require('../../src/lib/transit/sf-coverage-store');

const connectionString = process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/sge_test';
if (new URL(connectionString).pathname !== '/sge_test') throw new Error('Transit coverage integration requires sge_test');
const schema = `sf_coverage_${randomBytes(12).toString('hex')}`;
const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 2_000 });
const pool = new Pool({ connectionString, max: 6, options: `-c search_path=${schema}`, connectionTimeoutMillis: 2_000 });
const env = { TRANSIT_GETTING_HOME_ENABLED: 'true', TRANSIT_SF_GETTING_HOME_ENABLED: 'true', GEOAPIFY_API_KEY: 'synthetic-key' };
const time = Date.parse('2026-11-28T00:00:00.000Z');
const walks = [{ stopId: 'SF:123', lat: 37.76, lon: -122.43, walkSeconds: 303 }];
let created = false;

test.before(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  assert.equal((await pool.query('SELECT current_schema() AS s')).rows[0].s, schema);
  await pool.query(`CREATE TABLE events (
    id INTEGER PRIMARY KEY, slug TEXT DEFAULT 'test', status TEXT DEFAULT 'published', visibility TEXT DEFAULT 'public',
    event_date DATE DEFAULT DATE '2026-11-29', start_time TIME DEFAULT TIME '20:00', end_time TIME,
    timezone TEXT DEFAULT 'America/Los_Angeles', venue_name TEXT DEFAULT 'Test venue',
    venue_address TEXT DEFAULT '2170 Market Street, San Francisco, CA 94114',
    venue_city TEXT DEFAULT 'San Francisco', venue_state TEXT DEFAULT 'CA', google_place_id TEXT DEFAULT 'fixturePlace',
    venue_latitude DOUBLE PRECISION DEFAULT 37.76, venue_longitude DOUBLE PRECISION DEFAULT -122.43,
    secret_show_enabled BOOLEAN DEFAULT FALSE, hide_address_until_rsvp BOOLEAN DEFAULT FALSE, archived_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT clock_timestamp()
  )`);
  await pool.query(fs.readFileSync(path.resolve(__dirname, '../../src/db/migrations/092_transit_sf_coverage.sql'), 'utf8'));
});

test.after(async () => {
  await pool.end();
  try { if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
  finally { await admin.end(); }
});

test.beforeEach(async () => {
  await pool.query(`TRUNCATE events,transit_sf_venue_coverage,transit_sf_walk_reservations RESTART IDENTITY CASCADE`);
});

const events = async () => (await pool.query('SELECT * FROM events ORDER BY id')).rows;

test('it prepares once per verified venue, validates each date, and keeps private and manual events out', async () => {
  await pool.query(`INSERT INTO events(id) VALUES (1),(2),(3),(4),(5),(6),(7),(8);
    UPDATE events SET event_date=DATE '2026-12-01' WHERE id=2;
    UPDATE events SET visibility='private' WHERE id=3;
    UPDATE events SET hide_address_until_rsvp=true WHERE id=4;
    UPDATE events SET google_place_id=NULL WHERE id=5;
    UPDATE events SET venue_city='Daly City' WHERE id=6;
    UPDATE events SET secret_show_enabled=true WHERE id=7;
    UPDATE events SET venue_name='Make-Out Room',venue_address='3225 22nd Street, San Francisco, CA 94110' WHERE id=8`);
  let prepares = 0;
  const checked = [];
  const make = overrides => createSfCoverageWorker({ db: pool, now: () => time, env,
    prepareVenue: async (_event, venue, reserveCredits) => {
      prepares++;
      assert.equal(venue.address, '2170 MARKET ST');
      assert.equal(await reserveCredits(20), true);
      assert.equal(await reserveCredits(1), false);
      return walks;
    },
    checkEvent: async event => {
      checked.push(event.id);
      return event.id === 1;
    }, ...overrides });
  assert.deepEqual(await make({ env: {} }).runPass(), { checked: 0, ready: 0 });
  assert.deepEqual(await make().runPass(), { checked: 2, ready: 1 });
  assert.deepEqual(new Set(checked), new Set([1, 2]));
  assert.equal(prepares, 1);
  const store = createSfCoverageStore({ db: pool, now: () => time });
  assert.deepEqual(await store.readyEvents(await events()), new Set(['1']));
  assert.deepEqual(await store.getReadyWalks((await events())[0]), walks);
  const expired = createSfCoverageStore({ db: pool, now: () => time + 60 * 60_000 });
  assert.equal(await expired.getReadyWalks((await events())[0]), null);
  assert.deepEqual(await make().runPass(), { checked: 0, ready: 0 });
  const reservations = await pool.query('SELECT credits FROM transit_sf_walk_reservations');
  assert.deepEqual(reservations.rows, [{ credits: 20 }]);
});

test('location and time edits invalidate old coverage; an address hidden mid-check stops the walking request', async () => {
  await pool.query('INSERT INTO events(id) VALUES (1)');
  const store = createSfCoverageStore({ db: pool, now: () => time });
  let prepares = 0;
  const worker = createSfCoverageWorker({ db: pool, now: () => time, env,
    prepareVenue: async (_event, _venue, reserveCredits) => {
      prepares++;
      if (prepares === 2) {
        await pool.query(`UPDATE events SET visibility='private',updated_at=clock_timestamp() WHERE id=1`);
        assert.equal(await reserveCredits(20), false);
        return [];
      }
      assert.equal(await reserveCredits(20), true);
      return walks;
    },
    checkEvent: async () => true });
  assert.deepEqual(await worker.runPass(), { checked: 1, ready: 1 });
  assert.ok(await store.getReadyWalks((await events())[0]));
  await pool.query(`UPDATE events SET start_time=TIME '21:00',updated_at=clock_timestamp() WHERE id=1`);
  assert.equal(await store.getReadyWalks((await events())[0]), null);
  assert.deepEqual(await worker.runPass(), { checked: 1, ready: 1 });
  assert.equal(prepares, 1);
  await pool.query(`UPDATE events SET venue_address='418 Valencia Street, San Francisco, CA 94103',google_place_id='newPlace',updated_at=clock_timestamp() WHERE id=1`);
  assert.equal(await store.getReadyWalks((await events())[0]), null);
  assert.deepEqual(await worker.runPass(), { checked: 1, ready: 0 });
  assert.equal(prepares, 2);
  assert.equal((await pool.query('SELECT count(*) FROM transit_sf_walk_reservations')).rows[0].count, '1');
  assert.equal(await store.getReadyWalks((await events())[0]), null);
});

test('workers do not overlap and the durable rolling cap includes failed walking calls', async () => {
  await pool.query(`INSERT INTO events(id) VALUES (1);
    INSERT INTO transit_sf_walk_reservations(credits) SELECT 40 FROM generate_series(1,59);
    INSERT INTO transit_sf_walk_reservations(credits,reserved_at) VALUES (40,clock_timestamp()-INTERVAL '25 hours')`);
  let unblock;
  let notify;
  const readyToBlock = new Promise(resolve => { notify = resolve; });
  const releasesBlock = new Promise(resolve => { unblock = resolve; });
  const first = createSfCoverageWorker({ db: pool, now: () => time, env,
    prepareVenue: async (_event, _venue, reserveCredits) => {
      assert.equal(await reserveCredits(40), true);
      notify();
      await releasesBlock;
      throw new Error('sensitive fixture payload');
    }, checkEvent: async () => assert.fail('No estimate after provider failure') });
  let secondChecks = 0;
  const second = clock => createSfCoverageWorker({ db: pool, now: () => clock, env,
    prepareVenue: async (_event, _venue, reserveCredits) => {
      secondChecks++;
      assert.equal(await reserveCredits(1), false);
      return [];
    }, checkEvent: async () => assert.fail('No estimate when provider cap is reached') });

  const pending = first.runPass();
  try {
    await Promise.race([readyToBlock, pending.then(() => assert.fail('Worker did not reach the route reservation'))]);
    assert.deepEqual(await second(time).runPass(), { checked: 0, ready: 0 });
  } finally { unblock(); }
  assert.deepEqual(await pending, { checked: 1, ready: 0 });
  assert.deepEqual(await second(time + 15 * 60_000).runPass(), { checked: 1, ready: 0 });
  assert.equal(secondChecks, 1);
  const reservation = await pool.query('SELECT SUM(credits) AS credits FROM transit_sf_walk_reservations');
  assert.equal(reservation.rows[0].credits, '2400');
  assert.equal((await pool.query('SELECT count(*) FROM transit_sf_venue_coverage')).rows[0].count, '0');
});
