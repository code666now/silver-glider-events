'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Pool } = require('pg');
const { createRideReminders, recordRideSmsOptOut } = require('../../src/lib/transit/ride-reminders');

const connectionString = process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/sge_test';
if (new URL(connectionString).pathname !== '/sge_test') throw new Error('Transit integration requires sge_test');
// The normal public integration suite is intentionally excluded from this
// schema's search path. All rows and teardown targets belong to this test.
const schema = `ride_test_${randomBytes(12).toString('hex')}`;
const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 2000 });
let pool;
let created = false;
const STUB_SCHEMA = `
  CREATE TABLE users (id INTEGER PRIMARY KEY, account_status TEXT DEFAULT 'active');
  CREATE TABLE organizers (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id));
  CREATE TABLE events (
    id INTEGER PRIMARY KEY, organizer_id INTEGER REFERENCES organizers(id), slug TEXT NOT NULL,
    status TEXT DEFAULT 'published', visibility TEXT DEFAULT 'public', timezone TEXT DEFAULT 'America/Los_Angeles',
    event_date DATE DEFAULT DATE '2026-12-11', start_time TIME DEFAULT TIME '20:00', end_time TIME DEFAULT TIME '23:30',
    venue_name TEXT DEFAULT 'Make-Out Room', venue_address TEXT DEFAULT '3225 22nd Street, San Francisco, CA',
    venue_city TEXT DEFAULT 'San Francisco', venue_state TEXT DEFAULT 'CA',
    secret_show_enabled BOOLEAN DEFAULT FALSE, hide_address_until_rsvp BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE rsvps (
    id INTEGER PRIMARY KEY, event_id INTEGER REFERENCES events(id), user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status TEXT DEFAULT 'confirmed', phone TEXT
  );
  CREATE TABLE user_identities (
    id BIGINT PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, identity_type TEXT,
    normalized_value TEXT, verification_scope TEXT, verified_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
    is_primary BOOLEAN DEFAULT TRUE
  );
  CREATE TABLE sms_notification_recipients (
    id BIGINT PRIMARY KEY, rsvp_id INTEGER REFERENCES rsvps(id), recipient TEXT,
    accessed_at TIMESTAMPTZ
  );
`;

test.before(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 8, connectionTimeoutMillis: 2000 });
  assert.equal((await pool.query('SELECT current_schema() AS s')).rows[0].s, schema);
  await pool.query(STUB_SCHEMA);
  await pool.query(fs.readFileSync(path.resolve(__dirname, '../../src/db/migrations/089_transit_ride_reminders.sql'), 'utf8'));
});

test.after(async () => {
  await pool?.end();
  try {
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally { await admin.end(); }
});

test.beforeEach(async () => {
  await pool.query(`
    TRUNCATE users,transit_ride_sms_usage,transit_ride_sms_optouts RESTART IDENTITY CASCADE;
    INSERT INTO users (id) VALUES (1),(2),(3),(4);
    INSERT INTO organizers (id,user_id) VALUES (1,1);
    INSERT INTO events (id,organizer_id,slug) VALUES (10,1,'ride-demo-a'),(20,1,'ride-demo-b');
    INSERT INTO rsvps (id,event_id,user_id,phone) VALUES
      (11,10,2,'+14155550132'),(12,10,3,'+14155550133'),(13,10,4,'+14155550134'),(21,20,2,'+14155550132');
    INSERT INTO user_identities (id,user_id,identity_type,normalized_value,verification_scope,verified_at) VALUES
      (22,2,'phone','+14155550132','account',NOW()),(23,3,'phone','+14155550133','account',NOW()),
      (24,4,'phone','+14155550134','unverified',NULL);
  `);
});

const START = Date.parse('2026-12-12T03:00:00Z');
const REMINDER = START + 60 * 60_000;
const CONSENT = {
  eventId: 10, userId: 2, consent: true, expectedReminderAt: REMINDER,
  selection: { stopId: 'SF:15562', routeId: '14', direction: '0', headsign: 'Daly City' }
};

function harness({ daily = 10, lifetime = 20, provider, env: extra = {}, departure } = {}) {
  let time = START;
  let result = { status: 'scheduled', timing: 'scheduled', leaveByAt: REMINDER + 30 * 60_000, fetchedAt: START };
  const env = {
    TRANSIT_RIDE_REMINDERS_ENABLED: 'true',
    TRANSIT_SMS_DAILY_SEGMENT_CAP: String(daily),
    TRANSIT_SMS_LIFETIME_SEGMENT_CAP: String(lifetime),
    ...extra
  };
  const calls = [];
  const service = createRideReminders({
    pool, now: () => time, env,
    getDeparture: async (event, selection) => departure ? departure(result, event, selection) : result,
    async sendSms(payload) {
      calls.push(payload);
      if (provider) return provider(payload);
      return { sid: `SM${String(calls.length).padStart(32, '0')}` };
    }
  });
  return {
    service, calls, env, setClock: value => { time = value; },
    changeRide: changes => { result = { ...result, ...changes }; }
  };
}

test('explicit consent queues once and concurrent workers hand one text to the provider', async () => {
  const { service, calls, setClock } = harness({
    departure(result, event) {
      assert.ok(event.ends_at instanceof Date && event.ends_at.getTime() > result.leaveByAt);
      return result;
    }
  });
  const [a, b] = await Promise.all([service.schedule(CONSENT), service.schedule(CONSENT)]);
  assert.deepEqual(a, { status: 'pending', reminderAt: REMINDER, canRequest: false, canCancel: true });
  assert.deepEqual(b, a);
  assert.equal(calls.length, 0);
  assert.equal(await service.processDue(), 0);
  setClock(REMINDER + 100);
  await Promise.all([service.processDue(), service.processDue()]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].validityPeriod, 300);
  assert.deepEqual(await service.getStatus(CONSENT), { status: 'sent', canRequest: false, canCancel: false });
  const { rows } = await pool.query('SELECT status,selection,consent_version FROM transit_ride_reminders');
  assert.deepEqual(rows, [{ status: 'sent', selection: null, consent_version: 'transit_ride_reminder_v1' }]);
  assert.equal((await pool.query('SELECT attempted_segments FROM transit_ride_sms_usage')).rows[0].attempted_segments, 1);
});

test('daily and lifetime reservations are atomic, release on cancellation, and do not reset on user deletion', async () => {
  const { service, setClock } = harness({ daily: 1, lifetime: 1 });
  const requests = await Promise.allSettled([service.schedule(CONSENT), service.schedule({ ...CONSENT, userId: 3 })]);
  assert.equal(requests.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(requests.find(item => item.status === 'rejected').reason.code, 'budget-exhausted');
  const first = requests[0].status === 'fulfilled' ? 2 : 3;
  const next = first === 2 ? 3 : 2;
  assert.equal((await service.cancel({ eventId: 10, userId: first })).status, 'cancelled');
  assert.equal((await service.schedule({ ...CONSENT, userId: next })).status, 'pending');
  setClock(REMINDER);
  await service.processDue();
  await pool.query('DELETE FROM users WHERE id=$1', [next]);
  assert.equal((await pool.query('SELECT SUM(attempted_segments)::int AS n FROM transit_ride_sms_usage')).rows[0].n, 1);
});

test('no verified phone means no text; an RSVP phone proof must refer to the identical recipient', async () => {
  const { service, calls, setClock } = harness();
  assert.equal((await service.getStatus({ eventId: 10, userId: 4 })).status, 'verification-required');
  await assert.rejects(service.schedule({ ...CONSENT, userId: 4 }), { code: 'verification-required' });
  await pool.query(`INSERT INTO sms_notification_recipients VALUES (81,13,'+14155550134',NOW());`);
  assert.equal((await service.getStatus({ eventId: 10, userId: 4 })).status, 'available');
  await service.schedule({ ...CONSENT, userId: 4 });
  await pool.query(`UPDATE rsvps SET phone='+14155550139' WHERE id=13`);
  setClock(REMINDER);
  await service.processDue();
  assert.equal(calls.length, 0);
  assert.equal((await service.getStatus({ eventId: 10, userId: 4 })).status, 'cancelled');
});

test('STOP cancels pending texts and prevents new requests', async () => {
  const { service, calls, setClock } = harness();
  await service.schedule(CONSENT);
  await recordRideSmsOptOut(pool, '+14155550132');
  await recordRideSmsOptOut(pool, '+14155550132');
  assert.equal((await service.getStatus(CONSENT)).status, 'cancelled');
  assert.equal((await service.getStatus(CONSENT)).canRequest, false);
  await assert.rejects(service.schedule({ ...CONSENT, eventId: 20 }), { code: 'opted-out' });
  setClock(REMINDER);
  await service.processDue();
  assert.equal(calls.length, 0);
});

test('an ambiguous provider failure counts once and cannot retry or recreate the reminder', async () => {
  const { service, calls, setClock } = harness({
    provider() { throw Object.assign(new Error('synthetic timeout'), { acceptance: 'unknown' }); }
  });
  await service.schedule(CONSENT);
  setClock(REMINDER);
  await service.processDue();
  await service.processDue();
  assert.equal(calls.length, 1);
  setClock(START);
  assert.deepEqual(await service.schedule(CONSENT), { status: 'unknown', canRequest: false, canCancel: false });
  assert.equal((await pool.query('SELECT attempted_segments FROM transit_ride_sms_usage')).rows[0].attempted_segments, 1);
});

test('a provider opt-out prevents further requests without sending again', async () => {
  const { service, calls, setClock } = harness({
    provider() { throw Object.assign(new Error('synthetic opt-out'), { acceptance: 'rejected', providerCode: 21610 }); }
  });
  await service.schedule(CONSENT);
  await service.schedule({ ...CONSENT, eventId: 20 });
  setClock(REMINDER);
  await service.processDue();
  await service.processDue();
  assert.equal(calls.length, 1);
  assert.equal((await service.getStatus(CONSENT)).status, 'failed');
  assert.equal((await service.getStatus({ ...CONSENT, eventId: 20 })).status, 'cancelled');
  setClock(START);
  await assert.rejects(service.schedule({ ...CONSENT, eventId: 20 }), { code: 'opted-out' });
});

test('a provider response already marked failed is not counted as sent', async () => {
  const { service, calls, setClock } = harness({ provider: () => ({ sid: `SM${'1'.repeat(32)}`, status: 'failed' }) });
  await service.schedule(CONSENT);
  setClock(REMINDER);
  await service.processDue();
  await service.processDue();
  assert.equal(calls.length, 1);
  assert.equal((await service.getStatus(CONSENT)).status, 'failed');
  const row = (await pool.query('SELECT status,sent_at FROM transit_ride_reminders')).rows[0];
  assert.deepEqual(row, { status: 'failed', sent_at: null });
});

test('schedule edits, stale departures, revoked RSVP and hidden venues are suppressed', async () => {
  const { service, calls, setClock, changeRide } = harness();
  await service.schedule(CONSENT);
  await service.schedule({ ...CONSENT, userId: 3 });
  await pool.query(`UPDATE rsvps SET status='cancelled' WHERE id=12`);
  changeRide({ leaveByAt: REMINDER + 31 * 60_000 });
  setClock(REMINDER);
  await service.processDue();
  assert.equal(calls.length, 0);
  assert.equal((await service.getStatus(CONSENT)).status, 'cancelled');
  await assert.rejects(service.getStatus({ ...CONSENT, userId: 3 }), { code: 'not-eligible' });
  await pool.query('UPDATE events SET hide_address_until_rsvp=TRUE WHERE id=10');
  await assert.rejects(service.getStatus(CONSENT), { code: 'not-eligible' });
  setClock(START);
  changeRide({ fetchedAt: START - 13 * 60 * 60_000, leaveByAt: REMINDER + 30 * 60_000 });
  await assert.rejects(service.schedule({ ...CONSENT, eventId: 20 }), { code: 'schedule-changed' });
});

test('a cancel made during the schedule recheck wins before the durable claim', async () => {
  let finish;
  const recheck = new Promise(resolve => { finish = resolve; });
  let started;
  const waitUntilRecheck = new Promise(resolve => { started = resolve; });
  let pause = false;
  const { service, calls, setClock } = harness({
    async departure(result) {
      if (pause) {
        started();
        await recheck;
      }
      return result;
    }
  });
  await service.schedule(CONSENT);
  pause = true;
  setClock(REMINDER);
  const sending = service.processDue();
  try {
    await waitUntilRecheck;
    assert.equal((await service.cancel(CONSENT)).status, 'cancelled');
  } finally { finish(); }
  await sending;
  assert.equal(calls.length, 0);
});
