const test = require('node:test');
const assert = require('node:assert/strict');
const { PILOT, PILOT_WALKS, isMakeOutRoomEvent, discoverPilotStops } = require('../src/lib/transit/make-out-room');

const event = Object.freeze({
  status: 'published', visibility: 'public', venue_name: '  Make – Out  Room! ',
  venue_address: '3225 22nd St., San Francisco, CA 94110, U.S.A.'
});

test('pilot accepts only the exact public Make-Out Room venue and address', () => {
  assert.ok(isMakeOutRoomEvent(event));
  assert.ok(isMakeOutRoomEvent({ ...event, venue_address: '3225 22nd Street @ Mission, San Francisco, California 94110' }));
  assert.ok(isMakeOutRoomEvent({ ...event, venue_address: '3225 22nd Street', venue_city: 'San Francisco', venue_state: 'CA' }));
  assert.ok(isMakeOutRoomEvent({ ...event, venue_address: '3225 22nd St, San Francisco', venue_state: 'California' }));
  for (const overrides of [
    { status: 'draft' }, { status: 'cancelled' }, { status: 'hidden' }, { status: null },
    { visibility: 'private' }, { visibility: null }, { hide_address_until_rsvp: true }, { secret_show_enabled: true },
    { venue_name: 'Make-Out Room II' }, { venue_name: 'Make-Out Room SF' }, { venue_name: '' },
    { venue_address: '3225 22nd Street' }, { venue_address: '3225 22nd Street, San Francisco, TX' },
    { venue_address: '3225 22nd Street, San Francisco, CA 94112' }, { venue_address: '3226 22nd St, San Francisco, CA' },
    { venue_address: '32.25 22nd St, San Francisco, CA' }, { venue_address: '3225 22nd Avenue, San Francisco, CA' },
    { venue_city: 'Oakland' }, { venue_state: 'NY' }, { venue_address: 'Near 3225 22nd St, San Francisco, CA' }
  ]) assert.equal(isMakeOutRoomEvent({ ...event, ...overrides }), false, JSON.stringify(overrides));
});

function stop(stop_id, stop_lat, stop_lon, extra = {}) {
  return { stop_id, stop_name: stop_id, stop_lat: String(stop_lat), stop_lon: String(stop_lon), location_type: '', ...extra };
}

const example = {
  agency: [
    { agency_id: 'SF', agency_name: 'San Francisco Municipal Transportation Agency' },
    { agency_id: 'BA', agency_name: 'Bay Area Rapid Transit' }, { agency_id: 'AC', agency_name: 'AC Transit' }
  ],
  stops: [
    stop('SF_15562', 37.75517, -122.4188),
    stop('15561', 37.75582, -122.41871),
    stop('regional-stop-14r', 37.75817, -122.41909, { stop_code: '15558' }),
    stop('SF_13476', 37.756321, -122.418333), // Same stop code, relocated beyond verified distance.
    stop('AC_15562', 37.75517, -122.4188), // Another operator reuses these digits.
    stop('SF_no-pickup', PILOT.lat, PILOT.lon),
    stop('BA_24TH', 37.7523, -122.4181, { location_type: '1', stop_name: '24th Street Mission' }),
    stop('BA_M60-1', 37.7523, -122.4181, { location_type: '0', parent_station: 'BA_24TH' }),
    stop('BA_M60-2', 37.7522, -122.4182, { location_type: '0', parent_station: 'BA_24TH' }),
    stop('BA_24TH_1', 37.75258328, -122.4183299, { location_type: '2', parent_station: 'BA_24TH' }),
    stop('AC_far', 37.7700, -122.4200), stop('AC_invalid', '', -122.4200)
  ],
  routes: [['muni', 'SF', '3'], ['bart', 'BA', '1'], ['ac', 'AC', '700']]
    .map(([route_id, agency_id, route_type]) => ({ route_id, agency_id, route_type })),
  trips: ['muni', 'bart', 'ac'].map(route_id => ({ trip_id: `${route_id}-trip`, route_id })),
  stop_times: []
};
example.stop_times = example.stops.map(({ stop_id }) => {
  const kind = stop_id.startsWith('BA_') ? 'bart' : stop_id.startsWith('AC_') ? 'ac' : 'muni';
  return { trip_id: `${kind}-trip`, stop_id, pickup_type: stop_id === 'SF_no-pickup' ? '1' : '' };
});

test('walking estimates use the verified stop identity and location, never aerial distance', () => {
  const { muni, bart, other } = discoverPilotStops(example);
  assert.deepEqual(muni.map(({ stopId, walkSeconds }) => [stopId, walkSeconds]), [
    ['SF_15562', 120], ['15561', 120], ['SF_13476', null], ['regional-stop-14r', 360]
  ]);
  assert.ok(muni[0].airDistanceMeters > 0 && muni[0].airDistanceMeters < 100);
  assert.deepEqual(bart.map(({ stopId, stationId, name, walkSeconds }) => [stopId, stationId, name, walkSeconds]).sort(), [
    ['BA_M60-1', 'BA_24TH', '24th Street Mission', 360], ['BA_M60-2', 'BA_24TH', '24th Street Mission', 360]
  ]);
  assert.deepEqual(other.map(({ stopId, agency, agencyId, walkSeconds }) => [stopId, agency, agencyId, walkSeconds]), [
    ['AC_15562', 'AC Transit', 'AC', null]
  ]);
  assert.ok(PILOT_WALKS.every(estimate => estimate.source && estimate.stopSource && estimate.attribution && estimate.walkSeconds % 60 === 0));
});

test('before stop-time ingestion, all nearby boarding-stop IDs are retained for agency-neutral discovery', () => {
  const { stop_times, ...withoutCalls } = example;
  const { muni, bart, other } = discoverPilotStops(withoutCalls, { verifiedWalks: [] });
  const rows = [...muni, ...bart, ...other];
  assert.deepEqual(rows.map(row => row.stopId).sort(), [
    '15561', 'AC_15562', 'BA_M60-1', 'BA_M60-2', 'SF_13476', 'SF_15562', 'SF_no-pickup', 'regional-stop-14r'
  ]);
  assert.ok(rows.every(row => row.walkSeconds === null));
  assert.deepEqual(discoverPilotStops(undefined), { muni: [], bart: [], other: [] });
});

test('regional 511 BART parent ID matches only the verified station location and BART service', () => {
  const regional = (latitude, longitude, agencyId = 'BA') => ({
    agency: example.agency,
    routes: [{ route_id: 'b', agency_id: agencyId, route_type: '1' }],
    trips: [{ trip_id: 'b1', route_id: 'b' }],
    stops: [
      stop('901609', latitude, longitude, { location_type: '1', stop_name: '24th Street / Mission' }),
      stop('901601', latitude, longitude, { location_type: '0', parent_station: '901609' })
    ],
    stop_times: [{ trip_id: 'b1', stop_id: '901601', pickup_type: '0' }]
  });
  assert.deepEqual(discoverPilotStops(regional(37.75242, -122.41847)).bart
    .map(({ stopId, stationId, walkSeconds }) => ({ stopId, stationId, walkSeconds })), [
    { stopId: '901601', stationId: '901609', walkSeconds: 360 }
  ]);
  assert.equal(discoverPilotStops(regional(37.7515, -122.42075)).bart[0].walkSeconds, null);
  assert.equal(discoverPilotStops(regional(37.75242, -122.41847, 'AC')).other[0].walkSeconds, null);
});
