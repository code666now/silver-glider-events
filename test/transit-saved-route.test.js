'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSavedRouteService } = require('../src/lib/transit/saved-route');

const event = Object.freeze({ status: 'published', visibility: 'public', venue_name: 'Make-Out Room',
  venue_address: '3225 22nd Street, San Francisco, CA', event_date: '2026-11-27', start_time: '21:00' });
const laterEvent = Object.freeze({ ...event, event_date: '2026-12-11' });
const bus = Object.freeze({ stopId: 'SF_33_22', routeId: 'SF_33', direction: '1', headsign: 'The Richmond District' });
const rail = Object.freeze({ stationId: 'BA_24TH', destinationStationId: 'BA_DALY' });
const now = Date.parse('2026-11-24T12:00:00Z');
const scheduled = { status: 'scheduled', departureAt: now + 60_000 };

function fixture() {
  const data = {
    users: new Set([7, 8]), preferences: new Map(), queries: [], optionsCalls: [], departureCalls: [],
    options: { status: 'available', stops: [
      { stopId: bus.stopId, name: 'Mission & 22nd', walkSeconds: 120, routes: [
        { routeId: bus.routeId, name: '33', direction: bus.direction, headsign: bus.headsign }
      ] },
      { stopId: 'BA_24TH_plat', stationId: rail.stationId, name: '24th St Mission', walkSeconds: 360, routes: [
        { routeId: 'BART_blue', requiresDestination: true }
      ], destinations: [{ stationId: rail.destinationStationId, name: 'Daly City' }] }
    ] },
    departure: scheduled,
    deniedDuringWrite: false
  };
  const db = { async query(sql, args) {
    data.queries.push({ sql, args });
    assert.match(sql, /u\.id=\$1 AND u\.account_status='active'/);
    assert.match(sql, /identity\.user_id=u\.id AND identity\.verification_scope='account'/);
    assert.match(sql, /identity\.verified_at IS NOT NULL AND identity\.revoked_at IS NULL/);
    const [id] = args;
    const allowed = data.users.has(id);
    if (sql.includes('LEFT JOIN')) return { rows: allowed ? [data.preferences.get(id) || { selection_kind: null }] : [] };
    if (sql.includes('INSERT INTO')) {
      assert.match(sql, /FOR SHARE OF u/);
      if (!allowed || data.deniedDuringWrite) return { rowCount: 0 };
      const [, selection_kind, stop_id, route_id, direction, headsign, station_id, destination_station_id] = args;
      data.preferences.set(id, { selection_kind, stop_id, route_id, direction, headsign, station_id, destination_station_id });
      return { rowCount: 1 };
    }
    if (sql.includes('DELETE FROM')) {
      if (allowed) data.preferences.delete(id);
      return { rows: [{ allowed }] };
    }
    throw new Error('Unexpected SQL');
  } };
  const transit = {
    async getOptions(target) {
      data.optionsCalls.push(target);
      if (data.options instanceof Error) throw data.options;
      return data.options;
    },
    async getDeparture(target, selection) {
      data.departureCalls.push({ target, selection });
      return data.departure;
    }
  };
  return { data, service: createSavedRouteService({ db, transit, now: () => now }) };
}

test('remembering is explicit and writes only an owned, verified selection; future dates are rechecked', async () => {
  const { data, service } = fixture();
  assert.deepEqual(await service.get({ userId: 7, event }), { status: 'none' });
  assert.equal(data.optionsCalls.length, 0);
  for (const remember of [undefined, false, 1, 'true']) {
    assert.deepEqual(await service.save({ userId: 7, event, selection: bus, remember }), { status: 'not-requested' });
  }
  assert.equal(data.queries.length, 1);
  const result = await service.save({ userId: 7, event, selection: { ...bus, userId: 8, routeLabel: 'imposter', homeAddress: 'not retained' }, remember: true });
  assert.deepEqual(result, {
    status: 'available', selection: bus, routeLabel: '33', stopLabel: 'Mission & 22nd', directionLabel: bus.headsign
  });
  assert.deepEqual(data.queries.at(-1).args, [7, 'stop', bus.stopId, bus.routeId, bus.direction, bus.headsign, null, null]);
  assert.deepEqual(await service.get({ userId: 8, event: laterEvent }), { status: 'none' });
  assert.deepEqual(await service.get({ userId: 7, event: laterEvent }), result);
  assert.deepEqual(data.departureCalls.map(({ target, selection }) => [target.event_date, selection]), [
    [event.event_date, bus], [laterEvent.event_date, bus]
  ]);
});

test('an exact stop, direction and serviceable departure are required; stale preference can still be removed', async () => {
  const { data, service } = fixture();
  for (const selection of [{ ...bus, routeId: 'SF_other' }, { ...bus, direction: '0' },
    { ...bus, stopId: 'SF_other_stop' }, { ...bus, headsign: 'Wrong branch' }, { ...bus, routeId: 'SF\0_33' }]) {
    assert.equal((await service.save({ userId: 7, event, selection, remember: true })).status, 'not-applicable');
  }
  assert.equal(data.departureCalls.length, 0);
  assert.equal(data.preferences.size, 0);
  await service.save({ userId: 7, event, selection: bus, remember: true });
  data.departure = { status: 'no-service' };
  assert.deepEqual(await service.get({ userId: 7, event: laterEvent }), { status: 'not-applicable', hasPreference: true });
  data.departure = { status: 'scheduled', departureAt: now - 1 };
  assert.deepEqual(await service.get({ userId: 7, event: laterEvent }), { status: 'not-applicable', hasPreference: true });
  data.departure = { status: 'overnight' };
  assert.equal((await service.get({ userId: 7, event: laterEvent })).status, 'available');
  data.options = { status: 'available', stops: [{ ...data.options.stops[0], walkSeconds: null }] };
  assert.deepEqual(await service.get({ userId: 7, event: laterEvent }), { status: 'not-applicable', hasPreference: true });
  assert.deepEqual(await service.remove({ userId: 7 }), { status: 'removed' });
  assert.deepEqual(await service.remove({ userId: 7 }), { status: 'removed' });
  assert.deepEqual(await service.get({ userId: 7, event: laterEvent }), { status: 'none' });
});

test('BART stores both stations only if the destination exists and the itinerary serves the night', async () => {
  const { data, service } = fixture();
  for (const selection of [{ stationId: rail.stationId }, { ...rail, destinationStationId: 'BA_missing' },
    { ...rail, destinationStationId: rail.stationId }, { ...rail, stopId: 'BA_24TH_plat' }]) {
    assert.equal((await service.save({ userId: 7, event, selection, remember: true })).status, 'not-applicable');
  }
  data.departure = { status: 'no-service' };
  assert.equal((await service.save({ userId: 7, event, selection: rail, remember: true })).status, 'not-applicable');
  data.departure = scheduled;
  assert.deepEqual(await service.save({ userId: 7, event, selection: rail, remember: true }), {
    status: 'available', selection: rail, routeLabel: 'BART', stopLabel: '24th St Mission', directionLabel: 'Daly City', destinationLabel: 'Daly City'
  });
  assert.deepEqual(data.queries.at(-1).args, [7, 'rail', null, null, null, null, rail.stationId, rail.destinationStationId]);
  data.options = { status: 'available', stops: [{ ...data.options.stops[1], destinations: [] }] };
  assert.deepEqual(await service.get({ userId: 7, event: laterEvent }), { status: 'not-applicable', hasPreference: true });
});

test('only verified canonical guests on supported public events can use preferences; sources fail closed', async () => {
  const { data, service } = fixture();
  assert.deepEqual(await service.get({ userId: 1, event }), { status: 'not-eligible' });
  assert.deepEqual(await service.save({ userId: 1, event, selection: bus, remember: true }), { status: 'not-eligible' });
  assert.deepEqual(await service.remove({ userId: 1 }), { status: 'not-eligible' });
  assert.deepEqual(await service.get({ userId: '7', event }), { status: 'not-eligible' });
  for (const target of [{ ...event, hide_address_until_rsvp: true }, { ...event, visibility: 'private' },
    { ...event, secret_show_enabled: true }, { ...event, venue_name: 'Another Club' }]) {
    assert.deepEqual(await service.get({ userId: 7, event: target }), { status: 'not-applicable' });
    assert.deepEqual(await service.save({ userId: 7, event: target, selection: bus, remember: true }), { status: 'not-applicable' });
  }
  assert.equal(data.optionsCalls.length, 0);
  data.deniedDuringWrite = true;
  assert.deepEqual(await service.save({ userId: 7, event, selection: bus, remember: true }), { status: 'not-eligible' });
  data.deniedDuringWrite = false;
  await service.save({ userId: 7, event, selection: bus, remember: true });
  data.options = new Error('internal 511 connection detail');
  assert.deepEqual(await service.get({ userId: 7, event: laterEvent }), { status: 'unavailable', hasPreference: true });
});

test('schema stores one preference per guest without contact, event or host data and purges on account erasure', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../src/db/migrations/090_transit_saved_route.sql'), 'utf8');
  assert.match(migration, /user_id INTEGER PRIMARY KEY REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(migration, /AFTER UPDATE OF account_status ON users/);
  assert.match(migration, /NEW\.account_status = 'deleted'/);
  assert.match(migration, /DELETE FROM transit_saved_routes WHERE user_id = NEW\.id/);
  assert.doesNotMatch(migration, /\b(?:event_id|organizer_id|email|phone|ip_address|venue_address)\b/);
});
