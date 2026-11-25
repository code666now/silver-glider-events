const PILOT = Object.freeze({
  name: 'Make-Out Room', address: '3225 22nd Street', city: 'San Francisco', state: 'CA', timezone: 'America/Los_Angeles',
  latitude: 37.755191533084364, longitude: -122.41952096665861,
  lat: 37.755191533084364, lon: -122.41952096665861,
  searchRadiusMeters: 850,
  venueSource: 'https://www.makeoutroom.com/contact.html',
  addressPointSource: 'https://data.sf.gov/d/3mea-di5p'
});

const WALK_SOURCE = 'https://routing.openstreetmap.de/about.html';
const WALK_ATTRIBUTION = 'https://www.openstreetmap.org/copyright';
// Pedestrian-routed estimates, rounded up to whole minutes. Stop locations
// come from DataSF. At BART, use the longest of three mapped public entrance
// estimates. Station access, walking speed and accessible paths can vary.
const PILOT_WALKS = Object.freeze([
  ['15562', 37.75517, -122.4188, 2], ['15561', 37.75582, -122.41871, 2],
  ['15558', 37.75817, -122.41909, 6], ['15565', 37.752356, -122.418401, 6],
  ['13477', 37.752178, -122.41855, 6], ['13476', 37.752321, -122.418333, 6],
  ['15566', 37.751964, -122.418528, 6], ['13485', 37.752178, -122.420556, 7],
  ['14676', 37.75546, -122.414481, 7], ['13486', 37.752062, -122.42051, 7],
  ['15557', 37.75911, -122.41902, 7], ['14675', 37.755951, -122.414332, 7],
  ['16877', 37.75186, -122.42074, 7], ['13484', 37.752311, -122.416373, 9],
  ['13483', 37.752445, -122.416156, 9], ['13471', 37.752045, -122.422767, 9],
  ['17532', 37.752275, -122.416167, 9], ['13472', 37.751911, -122.422985, 9],
  ['16879', 37.75028, -122.42059, 10], ['13994', 37.754741, -122.427636, 10],
  ['15567', 37.74951, -122.4181, 10], ['16218', 37.754607, -122.42775, 11],
  ['15554', 37.761761, -122.419463, 11], ['13469', 37.75256, -122.414242, 11],
  ['14677', 37.752757, -122.414024, 11], ['13338', 37.761895, -122.41951, 11],
  ['17732', 37.758762, -122.414789, 11], ['17312', 37.752444, -122.414128, 11],
  ['16217', 37.756437, -122.426822, 11], ['15568', 37.74857, -122.41818, 11],
  ['13349', 37.761663, -122.421423, 11], ['13470', 37.752462, -122.413933, 11]
].map(([stopCode, lat, lon, minutes]) => Object.freeze({
  agency: 'muni', stopCode, lat, lon, walkSeconds: minutes * 60,
  source: WALK_SOURCE, stopSource: 'https://data.sf.gov/Transportation/Muni-Stops/i28k-bkz6', attribution: WALK_ATTRIBUTION
})).concat(Object.freeze({
  agency: 'bart', stationId: '24TH', regionalStationId: '901609', lat: 37.75258328, lon: -122.4183299,
  walkSeconds: 360, source: WALK_SOURCE,
  stopSource: 'https://www.bart.gov/schedules/developers/gtfs', attribution: WALK_ATTRIBUTION
})));

function words(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isMakeOutRoomEvent(event) {
  if (!event || event.status !== 'published' || event.visibility !== 'public'
    || event.secret_show_enabled || event.hide_address_until_rsvp) return false;
  if (words(event.venue_name).replace(/ /g, '') !== 'makeoutroom') return false;
  const city = words(event.venue_city);
  const state = words(event.venue_state);
  if ((city && city !== 'san francisco') || (state && !['ca', 'california'].includes(state))) return false;
  const address = words(event.venue_address);
  const match = /^3225 22nd (?:st|street)(?: (?:at )?mission(?: st(?:reet)?)?)?(?: (san francisco))?(?: (ca|california))?(?: 94110(?: \d{4})?)?(?: (?:usa|u s a|us|u s|united states(?: of america)?))?$/.exec(address);
  return Boolean(match && (match[1] || city) && (match[2] || state));
}

function identifier(value) { return String(value ?? '').trim(); }

function agencyKind(value) {
  const key = words(value).replace(/ /g, '');
  if (['sf', 'muni', 'sfmta', 'sanfranciscomunicipaltransportationagency', 'sanfranciscomunicipalrailway'].includes(key)) return 'muni';
  if (['ba', 'bart', 'bayarearapidtransit', 'bayarearapidtransitdistrict', 'sanfranciscobayarearapidtransitdistrict'].includes(key)) return 'bart';
  return null;
}

function localId(value, agency) {
  const id = identifier(value);
  const prefix = agency === 'muni' ? /^(?:sf|muni|sfmta)[_:-]/i : /^(?:ba|bart)[_:-]/i;
  return id.replace(prefix, '');
}

function coordinate(value, max) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= max ? number : null;
}

function point(row) {
  const lat = coordinate(row?.stop_lat, 90);
  const lon = coordinate(row?.stop_lon, 180);
  return lat == null || lon == null ? null : { lat, lon };
}

function distance(a, b = PILOT) {
  const rad = Math.PI / 180;
  const halfArc = Math.sin((a.lat - b.lat) * rad / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((a.lon - b.lon) * rad / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, halfArc)));
}

function railOrBus(value) {
  const text = identifier(value);
  if (!/^\d+$/.test(text)) return false;
  const code = Number(text);
  return [0, 1, 2, 3, 11, 12].includes(code)
    || [1, 2, 4, 5, 6, 7, 8, 9].includes(Math.floor(code / 100));
}

function discoverPilotStops(tables, { verifiedWalks = PILOT_WALKS } = {}) {
  tables ||= {};
  const result = { muni: [], bart: [], other: [] };
  const byId = new Map((tables.stops || []).map(row => [identifier(row.stop_id), row]));
  const agencies = new Map((tables.agency || []).map(row => [identifier(row.agency_id), identifier(row.agency_name)]));
  const soleAgency = agencies.size === 1 ? agencies.keys().next().value : '';
  const routes = new Map((tables.routes || []).map(row => [identifier(row.route_id), row]));
  const trips = new Map((tables.trips || []).map(row => [identifier(row.trip_id), identifier(row.route_id)]));
  const callsAvailable = Array.isArray(tables.stop_times);
  const nearby = new Map();

  function parentStation(stop) {
    let id = identifier(stop.parent_station);
    const visited = new Set();
    while (id && !visited.has(id)) {
      visited.add(id);
      const parent = byId.get(id);
      if (!parent) return null;
      if (identifier(parent.location_type) === '1') return parent;
      id = identifier(parent.parent_station);
    }
    return null;
  }

  for (const [id, stop] of byId) {
    if (!id || !['', '0'].includes(identifier(stop.location_type))) continue;
    const station = parentStation(stop);
    const coordinates = point(stop) || point(station);
    if (!coordinates) continue;
    const meters = distance(coordinates);
    if (meters > PILOT.searchRadiusMeters) continue;
    nearby.set(id, { stop, station, coordinates, meters, services: new Map() });
  }
  for (const call of tables.stop_times || []) {
    const candidate = nearby.get(identifier(call.stop_id));
    if (!candidate || !['', '0'].includes(identifier(call.pickup_type))) continue;
    const route = routes.get(trips.get(identifier(call.trip_id)));
    if (!route || !railOrBus(route.route_type)) continue;
    const agencyId = identifier(route.agency_id) || soleAgency;
    const agency = agencies.get(agencyId) || agencyId;
    const kind = agencyKind(agency) || agencyKind(agencyId) || 'other';
    candidate.services.set(agencyId, { kind, agency, agencyId });
  }
  for (const [stopId, entry] of nearby) {
    const { stop, station, coordinates, meters, services } = entry;
    const stationId = identifier(station?.stop_id);
    if (!callsAvailable) {
      // While streaming the archive's stop_times, the loader needs candidate
      // IDs before trips are joined to their stops. Keep unattributed IDs too.
      const kind = agencyKind(agencies.get(soleAgency)) || agencyKind(soleAgency)
        || agencyKind(stopId.split(/[_:-]/)[0]) || agencyKind(stationId.split(/[_:-]/)[0]) || 'other';
      services.set('', { kind, agency: '', agencyId: '' });
    }
    const seen = new Set();
    for (const { kind, agency, agencyId } of services.values()) {
      const key = kind === 'other' ? agencyId : kind;
      if (seen.has(key)) continue;
      seen.add(key);
      const walk = verifiedWalks.find(estimate => {
        if (estimate.agency !== kind || !(estimate.walkSeconds > 0) || !Number.isFinite(estimate.walkSeconds)) return false;
        if (kind === 'bart') {
          // The consolidated 511 feed assigns a different parent ID to this
          // station than BART's own feed. Keep the coordinate check for both.
          const knownStation = [estimate.stationId, estimate.regionalStationId]
            .some(id => id && identifier(id).toUpperCase() === localId(stationId, kind).toUpperCase());
          return stationId && knownStation
            && (!Number.isFinite(estimate.lat) || !Number.isFinite(estimate.lon) || distance(point(station) || coordinates, estimate) <= 150);
        }
        if (kind !== 'muni') return false;
        const ids = [stopId, stop.stop_code].map(id => localId(id, kind));
        // Require a close published position as well as a stable stop code so
        // a relocated boarding stop doesn't inherit an obsolete walking time.
        return ids.some(id => id && [estimate.stopCode, estimate.stopId].map(identifier).includes(id))
          && Number.isFinite(estimate.lat) && Number.isFinite(estimate.lon) && distance(coordinates, estimate) <= 45;
      });
      result[kind].push({
        stopId, ...(stationId && { stationId }), name: identifier(station?.stop_name || stop.stop_name),
        airDistanceMeters: Math.round(meters), walkSeconds: walk?.walkSeconds ?? null,
        ...(kind === 'other' && { agency, agencyId })
      });
    }
  }
  for (const rows of Object.values(result)) rows.sort((a, b) => a.airDistanceMeters - b.airDistanceMeters || a.stopId.localeCompare(b.stopId));
  return result;
}

module.exports = { PILOT, PILOT_WALKS, isMakeOutRoomEvent, discoverPilotStops };
