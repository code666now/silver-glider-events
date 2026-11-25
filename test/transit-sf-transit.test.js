'use strict';

process.env.SESSION_SECRET ||= 'sf-transit-test-only';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSfTransit, compileSfSnapshot, selectSfTripIds, sfTransitEnabled } = require('../src/lib/transit/sf-transit');
const { selectedSfVenue } = require('../src/lib/transit/sf-venue-address');
const { createGettingHome, sfGettingHomeEligible } = require('../src/lib/transit/getting-home');

const zone = 'America/Los_Angeles';
const now = () => Date.parse('2026-11-28T04:30:00Z');
const env = { TRANSIT_GETTING_HOME_ENABLED: 'true', TRANSIT_SF_GETTING_HOME_ENABLED: 'true', GEOAPIFY_API_KEY: 'fixture-key' };
const event = {
  id: 112, slug: 'test-show', venue_name: 'Other venue', venue_address: '123 4th St, San Francisco, CA 94103, USA',
  venue_city: 'San Francisco', venue_state: 'CA', google_place_id: 'fixture_place',
  venue_latitude: 37.801, venue_longitude: -122.427, status: 'published', visibility: 'public', timezone: zone,
  event_date: '2026-11-27', start_time: '20:00', end_time: '23:30', ends_at: '2026-11-28T07:30:00Z'
};
const street = { lat: 37.781, lon: -122.407 };
const selected = selectedSfVenue(event);

function feed() {
  const stop = (stop_id, stop_name, lat, lon, extra) => ({ stop_id, stop_name, stop_lat: String(lat), stop_lon: String(lon), ...extra });
  const result = {
    agency: ['SF', 'BA', 'OTHER'].map((agency_id, i) => ({ agency_id,
      agency_name: ['San Francisco Municipal Transportation Agency', 'Bay Area Rapid Transit', 'Other buses'][i], agency_timezone: zone })),
    routes: [['SF:14', 'SF', '3', '14'], ['BA:Y', 'BA', '1', 'Yellow'], ['OTHER:bus', 'OTHER', '3', '4']].map(([route_id, agency_id, route_type, route_short_name]) =>
      ({ route_id, agency_id, route_type, route_short_name })),
    stops: [
      stop('SF:street', 'Market & 5th', 37.782, -122.407),
      stop('SF:no-walk', 'Across barrier', 37.779, -122.408),
      stop('SF:long', 'Long walk', 37.778, -122.405),
      stop('SF:end', 'Out of range', 37.702, -122.43),
      stop('BA:local', 'Powell', 37.7831, -122.407, { location_type: '1' }),
      stop('BA:entrance', '5th Street entrance', 37.783, -122.407, { location_type: '2', parent_station: 'BA:local' }),
      stop('BA:exit', 'Exit only', 37.7828, -122.407, { location_type: '2', parent_station: 'BA:local' }),
      stop('BA:local:p', 'Powell platform', 37.7831, -122.407, { location_type: '0', parent_station: 'BA:local' }),
      stop('BA:dest', 'Across the Bay', 37.8, -122.27, { location_type: '1' }),
      stop('BA:dest:p', 'Destination platform', 37.8, -122.27, { location_type: '0', parent_station: 'BA:dest' }),
      stop('OTHER:stop', 'Other service', 37.7811, -122.407)
    ],
    pathways: [
      { from_stop_id: 'BA:entrance', to_stop_id: 'BA:local:p', pathway_mode: '1', is_bidirectional: '1' },
      { from_stop_id: 'BA:local:p', to_stop_id: 'BA:exit', pathway_mode: '7', is_bidirectional: '0' }
    ],
    calendar: ['SF', 'BA', 'OTHER'].map(service_id => ({ service_id,
      sunday: '1', monday: '1', tuesday: '1', wednesday: '1', thursday: '1', friday: '1', saturday: '1', start_date: '20261101', end_date: '20261201' })),
    calendar_dates: [], trips: [], stop_times: []
  };
  const trip = (id, route, calls) => {
    result.trips.push({ trip_id: id, route_id: route, service_id: route.split(':')[0], direction_id: '0', trip_headsign: 'Outbound' });
    calls.forEach(([stop_id, departure_time], i) => result.stop_times.push({ trip_id: id, stop_id, departure_time, stop_sequence: String(i + 1) }));
  };
  for (const [i, stamp] of ['23:50:00', '24:05:00', '24:30:00'].entries()) {
    trip(`sf-${i}`, 'SF:14', [['SF:street', stamp], ['SF:no-walk', stamp], ['SF:long', stamp], ['SF:end', '25:00:00']]);
  }
  trip('bart', 'BA:Y', [['BA:local:p', '24:10:00'], ['BA:dest:p', '24:35:00']]);
  trip('other', 'OTHER:bus', [['OTHER:stop', '23:00:00'], ['SF:end', '23:50:00']]);
  return result;
}

test('city snapshot keeps Muni and BART trips and uses a connected BART street entrance, not a centroid or exit', () => {
  const tables = feed();
  assert.deepEqual([...selectSfTripIds(tables)], ['sf-0', 'sf-1', 'sf-2', 'bart']);
  const { points } = compileSfSnapshot(tables);
  assert.deepEqual([...points.keys()], ['SF:street', 'SF:no-walk', 'SF:long', 'BA:entrance']);
  assert.equal(points.get('BA:entrance').stationId, 'BA:local');
  tables.pathways = [];
  assert.equal(compileSfSnapshot(tables).points.has('BA:entrance'), false);
});

test('city preparedness uses DataSF, verified walk times, and the existing next/last and BART planner', async () => {
  let snapshot = { ...compileSfSnapshot(feed()), fetchedAt: now() };
  let calls = 0;
  let credits = 0;
  const source = { getSchedule: async () => snapshot };
  const cityTransit = createSfTransit({ source, now, resolveAddress: async venue => {
    assert.equal(venue, selected);
    return street;
  }, walking: { matrix: async (point, targets) => {
    calls++;
    assert.deepEqual(point, street);
    assert.equal(credits, targets.length);
    return targets.map(target => new Map([[37.782, 215], [37.779, null], [37.778, 601], [37.783, 240]]).get(target.lat));
  } } });
  const walks = await cityTransit.prepareVenue(event, selected, async count => { credits = count; return true; });
  assert.equal(calls, 1);
  assert.deepEqual(walks.map(w => w.stopId).sort(), ['BA:entrance', 'SF:street']);
  assert.equal(await cityTransit.checkEvent(event, walks), true);
  assert.equal(await cityTransit.checkEvent(event, walks.filter(row => row.stationId)), true);
  assert.equal(await cityTransit.checkEvent({ ...event, event_date: '2026-12-09' }, walks), false);
  const home = createGettingHome({ cityTransit, env, now });
  assert.equal(sfGettingHomeEligible(event, env, now()), true);
  assert.equal((await home.getOptions(event)).status, 'unsupported-event');
  const prepared = { ...event, sfWalks: walks };
  const options = await home.getOptions(prepared);
  assert.equal(options.venue, event.venue_name);
  assert.equal(options.walkingAttribution.url, 'https://www.geoapify.com/');
  assert.deepEqual(options.stops.map(stop => stop.name), ['Market & 5th', 'Powell · 5th Street entrance']);
  assert.equal(options.stops.some(stop => 'lat' in stop || 'lon' in stop), false);
  const plan = await home.getDeparture(prepared, { stopId: 'SF:street', routeId: 'SF:14', direction: '0', headsign: 'Outbound' }, { includeUpcoming: true });
  assert.equal(plan.status, 'scheduled');
  assert.equal(plan.upcoming.departures.length, 2);
  assert.equal(plan.leaveByAt, plan.departureAt - 515_000);
  assert.equal(plan.proposedReminderAt, null);
  assert.equal((await home.getDeparture(prepared, { stationId: 'BA:local', destinationStationId: 'BA:dest' })).status, 'scheduled');
  assert.equal((await home.getDeparture(prepared, { stationId: 'BA:local' })).status, 'unsupported-selection');
  const relocated = feed();
  relocated.stops.find(stop => stop.stop_id === 'SF:street').stop_lat = '37.784';
  snapshot = { ...compileSfSnapshot(relocated), fetchedAt: now() };
  await assert.rejects(cityTransit.checkEvent(event, walks), { code: 'SF_WALKS_STALE' });
  assert.deepEqual((await home.getOptions(prepared)).stops.map(stop => stop.stopId), ['BA:entrance']);
  assert.equal(calls, 1, 'the guest planner never calls Geoapify');
});

test('city discovery never contacts walking provider for private/manual/other venues or if its credit reservation is refused', async () => {
  let addresses = 0;
  const city = createSfTransit({ source: { getSchedule: async () => compileSfSnapshot(feed()) },
    resolveAddress: async () => { addresses++; return street; }, walking: { matrix: () => assert.fail('Geoapify must not run') } });
  for (const override of [{ visibility: 'private' }, { hide_address_until_rsvp: true }, { google_place_id: null }, { archived_at: new Date() }, { venue_city: 'Daly City' }]) {
    assert.deepEqual(await city.prepareVenue({ ...event, ...override }, selected, async () => true), []);
    assert.equal(sfGettingHomeEligible({ ...event, ...override }, env, now()), false);
  }
  assert.equal(addresses, 0);
  await assert.rejects(city.prepareVenue(event, selected, async () => false), /not authorized/);
  assert.equal(addresses, 1);
  assert.equal(sfTransitEnabled({ ...env, GEOAPIFY_API_KEY: '' }), false);
  assert.equal(sfTransitEnabled({ ...env, TRANSIT_SF_GETTING_HOME_ENABLED: 'false' }), false);
});
