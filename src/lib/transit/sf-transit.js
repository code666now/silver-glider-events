'use strict';

const { create511ScheduleSource } = require('./gtfs-feed');
const { compactStopTime, createGtfsSchedule } = require('./gtfs-schedule');
const { createVenueTransit, eventDate } = require('./index');
const { isMakeOutRoomEvent } = require('./make-out-room');
const { selectedSfVenue, createSfAddressResolver } = require('./sf-venue-address');
const { createGeoapifyWalking, GEOAPIFY_MAX_WALK_TARGETS, GEOAPIFY_WALK_ATTRIBUTION } = require('./geoapify-walk');

const MAX_WALK_SECONDS = 600;
const SEARCH_METERS = 850;
const MOVED_METERS = 12;
const validStopId = /^[\p{L}\p{N}_.:/-]{1,100}$/u;
const muniNames = /\bmuni\b|san francisco municipal/i;
const bartNames = /\bBART\b|Bay Area Rapid Transit/i;

function sfTransitEnabled(env = process.env) {
  return env.TRANSIT_GETTING_HOME_ENABLED === 'true' && env.TRANSIT_SF_GETTING_HOME_ENABLED === 'true'
    && typeof env.GEOAPIFY_API_KEY === 'string' && Boolean(env.GEOAPIFY_API_KEY.trim());
}

function sfRoutes(tables) {
  const agency = new Map(tables.agency.map(a => [a.agency_id, a.agency_name]));
  const result = new Map();
  for (const route of tables.routes) {
    const name = agency.get(route.agency_id) || (agency.size === 1 ? tables.agency[0].agency_name : '');
    if (bartNames.test(name)) result.set(route.route_id, 'bart');
    else if (muniNames.test(name) && /^(?:[0235]|1[12]|[46789]\d{2})$/.test(String(route.route_type))) result.set(route.route_id, 'muni');
  }
  return result;
}

function selectSfTripIds(tables) {
  const routes = sfRoutes(tables);
  return new Set(tables.trips.filter(t => routes.has(t.route_id)).map(t => t.trip_id));
}

function distance(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin((a.lat - b.lat) * rad / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((a.lon - b.lon) * rad / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, h)));
}

function point(row) {
  const lat = Number(row.stop_lat);
  const lon = Number(row.stop_lon);
  // Limit the candidate index to the SF peninsula and nearby islands. The
  // venue itself is independently resolved within San Francisco by DataSF.
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= 37.69 && lat <= 37.85 && lon >= -122.56 && lon <= -122.35
    ? { lat, lon } : null;
}

function compileSfSnapshot(tables) {
  const agencies = sfRoutes(tables);
  const schedule = createGtfsSchedule({ ...tables, trips: tables.trips.filter(t => agencies.has(t.route_id)) });
  const stopsById = new Map(tables.stops.map(row => [row.stop_id, row]));
  const points = new Map();
  const platforms = new Map();
  const edges = new Map();
  const parent = stop => {
    for (let i = 0; i < 5 && stop?.parent_station; i++) {
      stop = stopsById.get(stop.parent_station);
      if (stop?.location_type === '1') return stop.stop_id;
    }
    return null;
  };
  const connect = (from, to) => {
    if (!edges.has(from)) edges.set(from, []);
    edges.get(from).push(to);
  };
  for (const path of tables.pathways ?? []) {
    // An exit gate is not an entrance. Honor one-way station paths.
    if (!['1', '2', '3', '4', '5', '6'].includes(path.pathway_mode)) continue;
    connect(path.from_stop_id, path.to_stop_id);
    if (path.is_bidirectional === '1') connect(path.to_stop_id, path.from_stop_id);
  }

  for (const row of tables.stops) {
    if (!validStopId.test(row.stop_id) || !['', '0', undefined].includes(row.location_type)) continue;
    const choices = schedule.choices(row.stop_id);
    const stationId = parent(row);
    const bart = stationId ? choices.filter(route => agencies.get(route.routeId) === 'bart') : [];
    if (bart.length) {
      if (!platforms.has(stationId)) platforms.set(stationId, new Map());
      platforms.get(stationId).set(row.stop_id, bart);
    }
    const position = point(row);
    const muni = choices.filter(route => agencies.get(route.routeId) === 'muni');
    if (position && !stationId && muni.length && row.stop_name) {
      points.set(row.stop_id, { stopId: row.stop_id, name: row.stop_name, ...position, routes: muni });
    }
  }

  for (const row of tables.stops) {
    if (row.location_type !== '2' || !validStopId.test(row.stop_id) || !row.stop_name) continue;
    const stationId = parent(row);
    const station = stopsById.get(stationId);
    const boards = platforms.get(stationId);
    const position = point(row);
    if (!stationId || !validStopId.test(stationId) || !station?.stop_name || !boards?.size || !position) continue;
    const reachable = new Set([row.stop_id]);
    const queue = [row.stop_id];
    for (let i = 0; i < queue.length; i++) {
      for (const next of edges.get(queue[i]) ?? []) {
        if (reachable.has(next) || parent(stopsById.get(next)) !== stationId) continue;
        reachable.add(next);
        queue.push(next);
      }
    }
    // The existing BART solver may use any platform at the station. Only
    // offer entrances that the feed connects to each boarding platform.
    if ([...boards.keys()].some(id => !reachable.has(id))) continue;
    const routes = [...new Map([...boards.values()].flat().map(route => [route.routeId, route])).values()];
    points.set(row.stop_id, { stopId: row.stop_id, stationId,
      name: row.stop_name === station.stop_name ? station.stop_name : `${station.stop_name} · ${row.stop_name}`,
      ...position, routes });
  }
  return { schedule, points };
}

function stopsForWalks(points, walks, strict) {
  const stops = [];
  let stale = false;
  for (const walk of walks) {
    const stop = points.get(walk.stopId);
    if (!stop || stop.stationId !== walk.stationId || distance(stop, walk) > MOVED_METERS) {
      stale = true;
      continue;
    }
    const { lat, lon, ...publicStop } = stop;
    stops.push({ ...publicStop, walkSeconds: walk.walkSeconds });
  }
  if (strict && stale) throw Object.assign(new Error('Verified transit stop changed'), { code: 'SF_WALKS_STALE' });
  const seen = new Set();
  return stops.sort((a, b) => a.walkSeconds - b.walkSeconds).filter(stop => {
    if (!stop.stationId) return true;
    if (seen.has(stop.stationId)) return false;
    seen.add(stop.stationId);
    return true;
  });
}

function createSfTransit({
  source = create511ScheduleSource({ selectTripIds: selectSfTripIds, formatStopTime: compactStopTime,
    compileSnapshot: compileSfSnapshot, maxRetainedRows: 1_600_000 }),
  resolveAddress = createSfAddressResolver(), walking = createGeoapifyWalking(), now = Date.now
} = {}) {
  const eligible = event => selectedSfVenue(event) !== null && !isMakeOutRoomEvent(event) && event.archived_at == null;
  const load = async event => {
    if (!event.sfWalks?.length) throw new Error('No verified SF coverage');
    const snapshot = await source.getSchedule();
    return { snapshot, schedule: snapshot.schedule, stops: stopsForWalks(snapshot.points, event.sfWalks, false) };
  };
  const planner = createVenueTransit({ load, eligible, venueName: event => event.venue_name });
  return {
    ...planner,
    async getOptions(event) {
      const options = await planner.getOptions(event);
      return options.status === 'available' ? { ...options, walkingAttribution: GEOAPIFY_WALK_ATTRIBUTION } : options;
    },
    async prepareVenue(event, venue, reserveCredits) {
      if (!eligible(event) || selectedSfVenue(event).key !== venue.key) return [];
      const origin = await resolveAddress(venue);
      if (!origin) return [];
      const { points } = await source.getSchedule();
      const targets = [...points.values()].map(stop => ({ stop, meters: distance(origin, stop) }))
        .filter(x => x.meters <= SEARCH_METERS).sort((a, b) => a.meters - b.meters).slice(0, GEOAPIFY_MAX_WALK_TARGETS);
      if (!targets.length) return [];
      if (!await reserveCredits(targets.length)) throw new Error('Walking lookup not authorized');
      const durations = await walking.matrix(origin, targets.map(({ stop: { lat, lon } }) => ({ lat, lon })));
      return targets.flatMap(({ stop: { stopId, stationId, lat, lon } }, i) => {
        const walkSeconds = durations[i];
        return Number.isInteger(walkSeconds) && walkSeconds > 0 && walkSeconds <= MAX_WALK_SECONDS
          ? [{ stopId, ...(stationId && { stationId }), lat, lon, walkSeconds }] : [];
      });
    },
    async checkEvent(event, walks) {
      if (!eligible(event)) return false;
      const { schedule, points } = await source.getSchedule();
      const stops = stopsForWalks(points, walks, true);
      const checkedAt = now();
      const time = { date: eventDate(event.event_date), startTime: event.start_time, endTime: event.end_time };
      const usable = (result, walkSeconds) => result.status === 'overnight' ||
        (result.status === 'scheduled' && result.departureAt - (walkSeconds + 300) * 1000 >= checkedAt);
      for (const stop of stops) {
        if (stop.stationId) {
          if (usable(schedule.departure({ ...time, stationId: stop.stationId, boardingOnly: true }), stop.walkSeconds)) return true;
          continue;
        }
        for (const { routeId, direction, headsign } of stop.routes) {
          if (usable(schedule.departure({ ...time, stopId: stop.stopId, routeId, direction, headsign }), stop.walkSeconds)) return true;
        }
      }
      return false;
    }
  };
}

// The worker and planner share one bounded in-process snapshot. The pilot
// retains its existing independent, smaller feed and rollback boundary.
const sfTransit = createSfTransit();

module.exports = { sfTransit, sfTransitEnabled, createSfTransit, selectSfTripIds, compileSfSnapshot };
