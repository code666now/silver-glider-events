'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Pool } = require('pg');
const { createRideMetrics, getTransportationAnalytics } = require('../../src/lib/transit/ride-metrics');

const connectionString = process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/sge_test';
if (new URL(connectionString).pathname !== '/sge_test') throw new Error('Transportation analytics integration requires sge_test');
const schema = `transportation_metrics_${randomBytes(10).toString('hex')}`;
const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 2_000 });
const db = new Pool({ connectionString, max: 8, options: `-c search_path=${schema}`, connectionTimeoutMillis: 2_000 });
const SECRET = 'fixture-key-for-transportation-only';
const DAY = 86_400_000;
const START = Date.parse('2026-11-28T00:00Z');
let created = false;

test.before(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  assert.equal((await db.query('SELECT current_schema() AS active')).rows[0].active, schema);
  await db.query(`CREATE TABLE organizers(id integer PRIMARY KEY, name text, org_name text);
    CREATE TABLE events(id integer PRIMARY KEY, organizer_id integer REFERENCES organizers(id), title text,
      visibility text NOT NULL DEFAULT 'public', status text NOT NULL DEFAULT 'published', event_date date NOT NULL,
      secret_show_enabled boolean NOT NULL DEFAULT false, hide_address_until_rsvp boolean NOT NULL DEFAULT false);
    INSERT INTO organizers VALUES (1,'Fallback name','Fixture Studio'),(2,'By Name',''),(3,'Quiet Studio','');
    INSERT INTO events(id,organizer_id,title,event_date) VALUES
      (1,1,'First show','2026-11-29'),(2,1,'Second show','2026-12-02'),(3,2,'Third show','2026-12-03'),
      (4,3,'Private fixture','2026-12-04'),(5,3,'Hidden fixture','2026-12-05'),(6,3,'No use','2026-12-06');
    UPDATE events SET visibility='private' WHERE id=4;
    UPDATE events SET status='hidden' WHERE id=5;`);
  for (const file of ['091_transit_ride_metrics.sql', '093_transit_transportation_metrics.sql']) {
    await db.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations', file), 'utf8'));
  }
});

test.after(async () => {
  await db.end();
  try { if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
  finally { await admin.end(); }
});

test('transportation reports dedupe real guest/event taps, group by host and count each active returner once', async () => {
  let time = START;
  const now = () => time;
  const metrics = createRideMetrics({ db, secret: SECRET, now });
  const read = () => getTransportationAnalytics({ db, now });
  const record = (kind, eventId, rsvpId, userId) => metrics.record({
    kind, eventId, rsvpId, userId, destination: '99 fixture private lane', route: 'Private Route'
  });
  assert.deepEqual(await read(), {
    summary: { eventCount: 0, hostCount: 0, returningUsers45d: 0, pageOpens: 0, routeSelections: 0,
      busClicks: 0, uberClicks: 0, lyftClicks: 0, repeatOpens: 0 }, events: [], hosts: []
  });
  assert.equal(await record('page_open', 1, 65601, 70101), true);
  assert.equal(await record('page_open', 1, 65601, 70101), false);
  assert.equal(await record('route_selected', 1, 65601, 70101), true);
  const bus = await Promise.all(Array.from({ length: 5 }, () => record('bus_click', 1, 65601, 70101)));
  assert.equal(bus.filter(Boolean).length, 1);
  assert.equal(await record('uber_click', 1, 65601, 70101), true);
  assert.equal(await record('lyft_click', 1, 65601, 70101), true);
  assert.equal(await record('uber_click', 1, 65601, 70101), false);
  time += DAY;
  assert.equal(await record('page_open', 2, 65602, 70101), true);
  assert.equal(await record('bus_click', 2, 65602, 70101), true);
  assert.equal(await record('page_open', 2, 65603), true);
  time += DAY;
  assert.equal(await record('page_open', 3, 65604, 70101), true);
  assert.equal(await record('page_open', 3, 65605), true);
  assert.equal(await record('uber_click', 3, 65605), true);
  assert.equal(await record('page_open', 4, 65606), true);
  assert.equal(await record('page_open', 5, 65607), true);
  assert.equal(await record('email_link_open', 6, 65608), true);

  const analytics = await read();
  assert.deepEqual(analytics.summary, { eventCount: 3, hostCount: 2, returningUsers45d: 1,
    pageOpens: 5, routeSelections: 1, busClicks: 2, uberClicks: 2, lyftClicks: 1, repeatOpens: 2 });
  assert.deepEqual(analytics.events.map(event => [event.id, event.hostId, event.hostName, event.eventDate, event.pageOpens, event.repeatOpens]), [
    [3, 2, 'By Name', '2026-12-03', 2, 1], [2, 1, 'Fixture Studio', '2026-12-02', 2, 1],
    [1, 1, 'Fixture Studio', '2026-11-29', 1, 0]
  ]);
  assert.deepEqual(analytics.hosts.map(host => [host.id, host.name, host.eventCount, host.busClicks, host.uberClicks, host.repeatOpens]), [
    [2, 'By Name', 1, 0, 1, 1], [1, 'Fixture Studio', 2, 2, 1, 1]
  ]);
  assert.doesNotMatch(JSON.stringify(analytics), /6560|70101|fixture private lane|Private Route|subject_key|first_event_key|Private fixture|Hidden fixture/);
  time = START + 46 * DAY;
  assert.equal((await read()).summary.returningUsers45d, 0);
  assert.ok(await metrics.prune() > 0);
  assert.deepEqual((await read()).summary, { ...analytics.summary, returningUsers45d: 0 });
});
