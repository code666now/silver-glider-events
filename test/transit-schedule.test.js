'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGtfsSchedule, currentServiceNight } = require('../src/lib/transit/gtfs-schedule');
const { createMakeOutRoomTransit, selectPilotStopTimes } = require('../src/lib/transit');

const bus = 'SF:14';
const origin = 'SF:15562';
const friday = '2026-11-27';
const regular = { service_id: 'daily', monday: '1', tuesday: '1', wednesday: '1', thursday: '1', friday: '1', saturday: '1', sunday: '1', start_date: '20261001', end_date: '20270101' };
const tables = () => ({
  agency: [
    { agency_id: 'SF', agency_name: 'San Francisco Municipal Transportation Agency', agency_timezone: 'America/Los_Angeles' },
    { agency_id: 'BA', agency_name: 'Bay Area Rapid Transit', agency_timezone: 'America/Los_Angeles' }
  ],
  routes: [
    { route_id: bus, agency_id: 'SF', route_type: '3', route_short_name: '14' },
    ...['yellow', 'red', 'blue'].map(route_id => ({ route_id, agency_id: 'BA', route_type: '1', route_short_name: route_id }))
  ],
  stops: [
    { stop_id: origin, stop_code: '15562', stop_name: 'Mission & 22nd', stop_lat: '37.75517', stop_lon: '-122.4188' },
    { stop_id: 'SF:end', stop_name: 'Down the line', stop_lat: '37.71', stop_lon: '-122.42' },
    ...['BA:24TH', 'BA:X', 'BA:DEST', 'BA:END'].flatMap(stop_id => [
      { stop_id, location_type: '1', stop_name: stop_id, stop_lat: '37.7523', stop_lon: '-122.4183' },
      { stop_id: `${stop_id}:p`, parent_station: stop_id, location_type: '0' }
    ])
  ],
  trips: [], stop_times: [], calendar: [regular], calendar_dates: [], frequencies: [], transfers: []
});

function addTrip(feed, id, calls, { route = bus, service = 'daily', direction = '0', headsign = 'Downtown' } = {}) {
  feed.trips.push({ trip_id: id, route_id: route, service_id: service, direction_id: direction, trip_headsign: headsign });
  calls.forEach(([stop_id, time, attributes], i) => feed.stop_times.push({
    trip_id: id, stop_id, arrival_time: time, departure_time: time, stop_sequence: String(i + 1), ...attributes
  }));
}

function addBus(feed, id, time, after, attributes, called) {
  addTrip(feed, id, [[origin, time, called], ['SF:end', after]], attributes);
}

const whenBus = (feed, options) => createGtfsSchedule(feed).departure({
  date: friday, stopId: origin, routeId: bus, direction: '0', startTime: '20:00', ...options
});
const iso = result => new Date(result.departureAt).toISOString();
const planFrom = (timestamp, boardingLeadMs = 7 * 60_000) => ({ nowMs: Date.parse(timestamp), boardingLeadMs });

test('GTFS route choices mark bus, trolleybus and light rail using the feed mode', () => {
  const feed = tables();
  feed.routes.push({ route_id: 'M', agency_id: 'SF', route_type: '0', route_short_name: 'M' },
    { route_id: '49', agency_id: 'SF', route_type: '800', route_short_name: '49' });
  addBus(feed, 'bus', '22:00:00', '23:00:00');
  addBus(feed, 'rail', '22:00:00', '23:00:00', { route: 'M' });
  addBus(feed, 'trolleybus', '22:00:00', '23:00:00', { route: '49' });
  assert.deepEqual(createGtfsSchedule(feed).choices(origin).map(({ name, mode }) => [name, mode]), [
    ['14', 'bus'], ['M', 'rail'], ['49', 'bus']
  ]);
});

test('a later trip after midnight beats civil-date 00:40, with warning when it leaves before the event ends', () => {
  const feed = tables();
  addBus(feed, 'extended', '25:10:00', '25:35:00');
  addBus(feed, 'civil-morning', '00:40:00', '00:53:00');
  addBus(feed, 'tomorrow-morning', '05:45:00', '06:00:00');
  addBus(feed, 'other-direction', '25:55:00', '26:20:00', { direction: '1' });
  const result = whenBus(feed, { endTime: '01:30' });
  assert.equal(result.status, 'scheduled');
  assert.equal(iso(result), '2026-11-28T09:10:00.000Z');
  assert.equal(result.departsBeforeEventEnds, true);
  assert.equal(result.timing, 'scheduled');
});

test('a 1 AM event stays in the same night and not the following evening', () => {
  const feed = tables();
  addBus(feed, 'night-trip', '25:20:00', '25:40:00');
  addBus(feed, 'late-tomorrow', '23:45:00', '24:00:00');
  const result = whenBus(feed, { date: '2026-11-28', startTime: '01:00' });
  assert.equal(result.tripId, 'night-trip');
  assert.equal(iso(result), '2026-11-28T09:20:00.000Z');
});

test('next rides use the selected direction and stop, walk plus buffer, and chronological order across midnight', () => {
  const feed = tables();
  addBus(feed, 'already-gone', '23:48:00', '24:07:00');
  addBus(feed, 'too-close', '23:56:00', '24:12:00');
  addBus(feed, 'first', '23:57:00', '24:18:00');
  addBus(feed, 'same-time', '23:57:00', '24:18:00');
  addBus(feed, 'wrong-headsign', '23:59:00', '24:16:00', { headsign: 'Short turn' });
  addTrip(feed, 'wrong-stop', [['SF:other', '24:00:00'], ['SF:end', '24:16:00']]);
  addBus(feed, 'wrong-direction', '24:01:00', '24:23:00', { direction: '1' });
  addBus(feed, 'no-pickup', '24:02:00', '24:17:00', undefined, { pickup_type: '1' });
  addBus(feed, 'second', '24:03:00', '24:23:00', undefined, { timepoint: '0' });
  addBus(feed, 'last', '24:50:00', '25:10:00');
  const result = whenBus(feed, { headsign: 'Downtown', ridePlanning: planFrom('2026-11-28T07:50:00Z') });
  assert.equal(result.tripId, 'last');
  assert.deepEqual(result.upcoming, {
    context: 'leaving-now', includesLast: false,
    departures: [
      { departureAt: Date.parse('2026-11-28T07:57:00Z'), timing: 'scheduled' },
      { departureAt: Date.parse('2026-11-28T08:03:00Z'), timing: 'feed-estimate' }
    ]
  });
});

test('advance planning uses the event night and show end; without an end it falls back to the real start', () => {
  const feed = tables();
  addBus(feed, 'from-start', '20:08:00', '20:25:00');
  addBus(feed, 'before-end', '24:59:00', '25:20:00');
  addBus(feed, 'after-end', '25:09:00', '25:25:00');
  addBus(feed, 'last', '25:45:00', '26:05:00');
  addBus(feed, 'morning', '05:45:00', '06:05:00');
  const ridePlanning = planFrom('2026-11-26T04:00:00Z');
  const afterShow = whenBus(feed, { endTime: '01:00', ridePlanning });
  assert.equal(afterShow.tripId, 'last');
  assert.deepEqual(afterShow.upcoming, {
    context: 'after-show', includesLast: true, departures: [{ departureAt: Date.parse('2026-11-28T09:09:00Z'), timing: 'scheduled' }]
  });
  const fromStart = whenBus(feed, { ridePlanning });
  assert.equal(fromStart.upcoming.context, 'from-show-start');
  assert.equal(iso(fromStart.upcoming.departures[0]), '2026-11-28T04:08:00.000Z');
  assert.equal(fromStart.upcoming.departures.length, 2);
  const onlyLast = whenBus(feed, { endTime: '01:22', ridePlanning });
  assert.deepEqual(onlyLast.upcoming, { context: 'after-show', includesLast: true, departures: [] });
  const missed = whenBus(feed, { ridePlanning: planFrom('2026-11-28T09:40:00Z') });
  assert.deepEqual(missed.upcoming, { context: 'leaving-now', includesLast: false, departures: [] });
});

test('leave now uses the current local night, even from an event shared a day ahead', () => {
  const feed = tables();
  addBus(feed, 'too-close', '14:06:00', '14:15:00');
  addBus(feed, 'early-first', '14:07:00', '14:25:00');
  addBus(feed, 'early-second', '14:20:00', '14:40:00');
  addBus(feed, 'night-last', '24:45:00', '25:00:00');
  const ridePlanning = { ...planFrom('2026-11-27T22:00:00Z'), leaveNow: true };
  const result = whenBus(feed, { date: '2026-11-28', endTime: '23:00', ridePlanning });
  assert.equal(iso(result), '2026-11-28T08:45:00.000Z');
  assert.equal(result.departsBeforeEventEnds, undefined);
  assert.deepEqual(result.upcoming, {
    context: 'leaving-now', includesLast: false,
    departures: ['2026-11-27T22:07:00Z', '2026-11-27T22:20:00Z'].map(departure => ({ departureAt: Date.parse(departure), timing: 'scheduled' }))
  });
});

test('leave now preserves the only reachable last bus and rolls the night at 4 a.m.', () => {
  const feed = tables();
  addBus(feed, 'last', '25:05:00', '25:30:00');
  const from = date => ({ ridePlanning: { ...planFrom(date), leaveNow: true } });
  const late = whenBus(feed, from('2026-11-28T08:50:00Z'));
  assert.equal(iso(late), '2026-11-28T09:05:00.000Z');
  assert.deepEqual(late.upcoming, { context: 'leaving-now', includesLast: true, departures: [] });
  const missed = whenBus(feed, from('2026-11-28T09:00:00Z'));
  assert.equal(iso(missed), '2026-11-28T09:05:00.000Z');
  assert.deepEqual(missed.upcoming, { context: 'leaving-now', includesLast: false, departures: [] });
  const zone = 'America/Los_Angeles';
  assert.equal(currentServiceNight(Date.parse('2026-11-28T11:59:59Z'), zone).anchor, friday);
  assert.equal(currentServiceNight(Date.parse('2026-11-28T12:00:00Z'), zone).anchor, '2026-11-28');
  const dstNight = currentServiceNight(Date.parse('2026-11-01T09:20:00Z'), zone);
  assert.equal(dstNight.anchor, '2026-10-31');
  assert.equal(dstNight.endsAt - dstNight.startAt, 25 * 60 * 60_000);
  assert.equal(iso(whenBus(feed, from('2026-11-28T12:00:00Z'))), '2026-11-29T09:05:00.000Z');
});

test('weekends and holidays follow the service calendar and dated overrides, not just weekdays', () => {
  const feed = tables();
  feed.calendar = [{ ...regular, saturday: '0', sunday: '0' }];
  feed.calendar_dates = [
    { service_id: 'daily', date: '20261126', exception_type: '2' },
    { service_id: 'special', date: '20261126', exception_type: '1' },
    { service_id: 'weekend', date: '20261128', exception_type: '1' }
  ];
  addBus(feed, 'weekdays', '23:00:00', '23:22:00');
  addBus(feed, 'holiday', '21:00:00', '21:20:00', { service: 'special' });
  addBus(feed, 'weekends', '22:00:00', '22:23:00', { service: 'weekend' });
  assert.equal(whenBus(feed, { date: '2026-11-26' }).tripId, 'holiday');
  assert.equal(whenBus(feed, { date: '2026-11-28' }).tripId, 'weekends');
  assert.equal(whenBus(feed, { date: '2026-11-29' }).status, 'no-service');
  assert.equal(whenBus(feed, { date: '2026-09-20' }).status, 'schedule-unavailable');
});

test('an exception-only feed has no fabricated service in a gap between known dates', () => {
  const feed = tables();
  feed.calendar = [];
  feed.calendar_dates = ['20261126', '20261203'].map(date => ({ service_id: 'daily', date, exception_type: '1' }));
  addBus(feed, 'ordinary', '23:50:00', '24:10:00');
  assert.equal(whenBus(feed).status, 'schedule-unavailable');
});

test('DST uses GTFS elapsed time from agency-local noon, not a fixed UTC offset', () => {
  const feed = tables();
  addBus(feed, 'sunday-after-change', '23:30:00', '23:45:00');
  assert.equal(iso(whenBus(feed, { date: '2026-11-01' })), '2026-11-02T07:30:00.000Z');
  assert.equal(whenBus(feed, { date: '2026-11-01', startTime: '01:30', direction: '1' }).status, 'no-service');
});

test('an out-of-service train or terminal-only call cannot be a final boarding', () => {
  const feed = tables();
  addBus(feed, 'boardable', '22:00:00', '22:20:00');
  addBus(feed, 'no-pickup', '23:30:00', '23:50:00', undefined, { pickup_type: '1' });
  addTrip(feed, 'terminates-here', [['SF:end', '23:30:00'], [origin, '23:50:00']]);
  assert.equal(whenBus(feed).tripId, 'boardable');
});

test('continuous service across the night is labeled overnight, not as the last bus', () => {
  const feed = tables();
  for (const hour of [0, 1, 2, 3, 4, 5, 6, 23]) {
    const prefix = String(hour).padStart(2, '0');
    addBus(feed, `hour-${prefix}`, `${prefix}:00:00`, `${prefix}:20:00`);
  }
  assert.deepEqual(whenBus(feed), { status: 'overnight', timezone: 'America/Los_Angeles' });
  const nearMorning = whenBus(feed, { ridePlanning: planFrom('2026-11-28T11:58:00Z') });
  assert.equal(nearMorning.status, 'overnight');
  assert.equal(nearMorning.departureAt, undefined);
  assert.deepEqual(nearMorning.upcoming, {
    context: 'leaving-now', includesLast: false,
    departures: ['2026-11-28T13:00:00Z', '2026-11-28T14:00:00Z'].map(date => ({ departureAt: Date.parse(date), timing: 'scheduled' }))
  });
  const leaveNow = whenBus(feed, { date: '2026-11-30', ridePlanning: { ...planFrom('2026-11-28T11:58:00Z'), leaveNow: true } });
  assert.deepEqual(leaveNow, nearMorning);
});

test('a frequency without exact times never produces an invented last departure', () => {
  const feed = tables();
  addBus(feed, 'headway', '00:00:00', '00:10:00');
  feed.frequencies.push({ trip_id: 'headway', start_time: '21:00:00', end_time: '23:00:00', headway_secs: '900', exact_times: '0' });
  assert.deepEqual(whenBus(feed, { ridePlanning: planFrom('2026-11-28T04:30:00Z') }), { status: 'schedule-unavailable' });
  feed.frequencies[0].exact_times = '1';
  assert.equal(iso(whenBus(feed)), '2026-11-28T06:45:00.000Z');
});

test('BART requires a destination and finds the latest origin train with an onward connection', () => {
  const feed = tables();
  addTrip(feed, 'last-train-misses', [['BA:24TH:p', '24:50:00'], ['BA:X:p', '25:06:00']], { route: 'yellow' });
  addTrip(feed, 'last-viable', [['BA:24TH:p', '24:30:00'], ['BA:X:p', '24:52:00']], { route: 'blue' });
  addTrip(feed, 'direct-but-earlier', [['BA:24TH:p', '23:50:00'], ['BA:DEST:p', '24:25:00']], { route: 'red' });
  addTrip(feed, 'transfer', [['BA:X:p', '25:10:00'], ['BA:DEST:p', '25:40:00']], { route: 'red' });
  const options = { date: friday, startTime: '20:00', stationId: 'BA:24TH' };
  const schedule = createGtfsSchedule(feed);
  assert.equal(schedule.departure(options).status, 'destination-required');
  const selection = { ...options, destinationStationId: 'BA:DEST', ridePlanning: planFrom('2026-11-27T03:00:00Z') };
  assert.equal(schedule.departure(selection).tripId, 'last-viable');
  assert.equal(schedule.departure(selection).upcoming, undefined);
  assert.deepEqual(schedule.departure(selection).itinerary.map(leg => leg.toStopId), ['BA:X:p', 'BA:DEST:p']);
  feed.transfers.push({ from_stop_id: 'BA:X', to_stop_id: 'BA:X', transfer_type: '3', from_route_id: 'blue', to_route_id: 'red' });
  assert.equal(createGtfsSchedule(feed).departure(selection).tripId, 'direct-but-earlier');
});

test('pilot service only loads approved events, refuses unverified stops, and redacts upstream failures', async () => {
  const feed = tables();
  addBus(feed, 'late', '24:30:00', '24:40:00');
  const date = { status: 'published', visibility: 'public', venue_name: 'Make-Out Room', venue_address: '3225 22nd St, San Francisco, CA 94110', event_date: friday, start_time: '20:00' };
  let loads = 0;
  const transit = createMakeOutRoomTransit({ source: { getSchedule: async () => { loads++; return { tables: feed, fetchedAt: 42 }; } } });
  assert.equal((await transit.getOptions({ ...date, visibility: 'private' })).status, 'unsupported-event');
  assert.equal(loads, 0);
  const options = await transit.getOptions(date);
  assert.equal(options.status, 'available');
  assert.equal(options.attribution.label, 'data provided by 511.org');
  assert.equal(options.stops[0].walkSeconds, 120);
  const trip = await transit.getDeparture(date, { stopId: origin, routeId: bus, direction: '0', headsign: 'Downtown' });
  assert.equal(trip.status, 'scheduled');
  assert.equal(trip.fetchedAt, 42);
  const tooLate = await transit.getDeparture(date, { stopId: origin, routeId: bus, direction: '0', headsign: 'Downtown' },
    { now: () => Date.parse('2026-11-28T08:24:00Z'), safetyBufferMinutes: 5 });
  assert.deepEqual(tooLate.upcoming, { context: 'leaving-now', includesLast: false, departures: [] });
  const leaveNow = await transit.getDeparture({ ...date, event_date: '2026-11-28', start_time: '20:00' },
    { stopId: origin, routeId: bus, direction: '0', headsign: 'Downtown' },
    { now: () => Date.parse('2026-11-28T08:00:00Z'), safetyBufferMinutes: 5, leaveNow: true });
  assert.equal(iso(leaveNow), '2026-11-28T08:30:00.000Z');
  assert.deepEqual(leaveNow.upcoming, { context: 'leaving-now', includesLast: true, departures: [] });
  assert.equal((await transit.getDeparture(date, { stopId: 'elsewhere' })).status, 'unsupported-selection');
  const unavailable = createMakeOutRoomTransit({ source: { getSchedule: async () => { throw new Error('raw upstream detail'); } } });
  assert.deepEqual(await unavailable.getOptions(date), { status: 'schedule-unavailable' });
});

test('region selector keeps candidate stops and every BART trip for transfer search', () => {
  const feed = tables();
  addTrip(feed, 'transfer', [['BA:X:p', '25:10:00'], ['BA:DEST:p', '25:40:00']], { route: 'red' });
  const { stop_times, ...metadata } = feed;
  const select = selectPilotStopTimes(metadata);
  assert.equal(select({ stop_id: origin, trip_id: 'anything' }), true);
  assert.equal(select({ stop_id: 'removed', trip_id: 'transfer' }), true);
  assert.equal(select({ stop_id: 'removed', trip_id: 'other bus' }), false);
});
