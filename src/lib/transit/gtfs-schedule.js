'use strict';

const MINUTE = 60_000;
const DAY = 86_400_000;
const formats = new Map();

function civilDate(value) {
  const date = String(value ?? '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const stamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === date ? date : null;
}

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

function localTime(date, time, zone) {
  if (!formats.has(zone)) formats.set(zone, new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }));
  const format = formats.get(zone);
  const target = Date.parse(`${date}T${time}Z`);
  if (!Number.isFinite(target)) throw new RangeError('Invalid local transit time');
  let instant = target;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(format.formatToParts(instant).map(({ type, value }) => [type, value]));
    const displayed = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    if (displayed === target) return instant;
    instant += target - displayed;
  }
  throw new RangeError('Local transit time does not exist');
}

const localHour = (date, hour, zone) => localTime(date, `${String(hour).padStart(2, '0')}:00:00`, zone);
const parseClock = time => /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time ?? '')
  ? (time.length === 5 ? `${time}:00` : time) : null;

function gtfsSeconds(value) {
  const match = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/.exec(value ?? '');
  return match ? +match[1] * 3600 + +match[2] * 60 + +match[3] : null;
}

const indexBy = (rows, key) => new Map(rows.map(row => [row[key], row]));
function groupBy(rows, key) {
  const result = new Map();
  for (const row of rows) {
    const id = row[key];
    if (!result.has(id)) result.set(id, []);
    result.get(id).push(row);
  }
  return result;
}

const regularStop = value => !value || value === '0';
const pickup = row => regularStop(row.pickup_type);
const dropOff = row => regularStop(row.drop_off_type);
const daysOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const UNAVAILABLE = Object.freeze({ status: 'schedule-unavailable' });

function createGtfsSchedule(tables) {
  const agencies = tables.agency ?? [];
  const agenciesById = indexBy(agencies, 'agency_id');
  const routes = indexBy(tables.routes ?? [], 'route_id');
  const stops = indexBy(tables.stops ?? [], 'stop_id');
  const trips = tables.trips ?? [];
  const calendar = indexBy(tables.calendar ?? [], 'service_id');
  const exceptions = groupBy(tables.calendar_dates ?? [], 'service_id');
  const stopTimes = groupBy(tables.stop_times ?? [], 'trip_id');
  const frequencies = groupBy(tables.frequencies ?? [], 'trip_id');
  const transfers = groupBy(tables.transfers ?? [], 'from_stop_id');
  const agencyFor = route => agenciesById.get(route?.agency_id) ?? (agencies.length === 1 ? agencies[0] : null);
  const isBart = route => /\bBART\b|Bay Area Rapid Transit/i.test(agencyFor(route)?.agency_name ?? '');

  const agencyService = new Map();
  for (const trip of trips) {
    const agency = agencyFor(routes.get(trip.route_id));
    if (!agencyService.has(agency)) agencyService.set(agency, new Set());
    agencyService.get(agency).add(trip.service_id);
  }

  function covered(agency, date, nextDate) {
    const service = agencyService.get(agency) ?? [];
    let startCovered = false;
    let endCovered = false;
    const include = (from, to) => {
      if (from && to && from <= to) {
        startCovered ||= from <= date && date <= to;
        endCovered ||= from <= nextDate && nextDate <= to;
      }
    };
    for (const id of service) {
      const row = calendar.get(id);
      if (row) include(civilDate(row.start_date), civilDate(row.end_date));
      for (const row of exceptions.get(id) ?? []) {
        const day = civilDate(row.date);
        include(day, day);
      }
    }
    // A sole feed_info row can assert non-service weekdays/holidays for a
    // single agency; a regional coverage claim doesn't substitute for ours.
    if (agencies.length === 1 && service.size && tables.feed_info?.length === 1) {
      const { feed_start_date, feed_end_date } = tables.feed_info[0];
      include(civilDate(feed_start_date), civilDate(feed_end_date));
    }
    return startCovered && endCovered;
  }

  function active(serviceId, date) {
    const exception = exceptions.get(serviceId)?.find(row => civilDate(row.date) === date);
    if (exception) return exception.exception_type === '1';
    const base = calendar.get(serviceId);
    const from = civilDate(base?.start_date);
    const through = civilDate(base?.end_date);
    const weekday = daysOfWeek[new Date(`${date}T00:00:00Z`).getUTCDay()];
    return Boolean(from && through && date >= from && date <= through && base[weekday] === '1');
  }

  function stationOf(id) {
    for (let depth = 0; depth < 5; depth++) {
      const stop = stops.get(id);
      if (!stop?.parent_station) return id;
      id = stop.parent_station;
    }
    return id;
  }

  const rowsByTrip = new Map([...stopTimes].map(([id, rows]) => [id, rows.map(row => ({
    stop_id: row.stop_id, stop_headsign: row.stop_headsign, stop_sequence: row.stop_sequence,
    pickup_type: row.pickup_type, drop_off_type: row.drop_off_type, timepoint: row.timepoint,
    arrival: gtfsSeconds(row.arrival_time || row.departure_time),
    departure: gtfsSeconds(row.departure_time || row.arrival_time)
  })).sort((a, b) => +a.stop_sequence - +b.stop_sequence)]));

  const choicesByStop = new Map();
  const bartStations = new Map();
  for (const trip of trips) {
    const rows = rowsByTrip.get(trip.trip_id);
    const route = routes.get(trip.route_id);
    if (!rows?.length || !route) continue;
    const rail = isBart(route);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (rail && dropOff(row)) {
        const id = stationOf(row.stop_id);
        if (stops.has(id)) bartStations.set(id, { stationId: id, name: stops.get(id).stop_name });
      }
      if (i + 1 < rows.length && pickup(row)) {
        if (!choicesByStop.has(row.stop_id)) choicesByStop.set(row.stop_id, new Map());
        const headsign = row.stop_headsign || trip.trip_headsign || '';
        const direction = trip.direction_id || '';
        const key = JSON.stringify([route.route_id, direction, headsign]);
        choicesByStop.get(row.stop_id).set(key, {
          routeId: route.route_id, name: route.route_short_name || route.route_long_name || route.route_id,
          agencyId: agencyFor(route)?.agency_id ?? '', agency: agencyFor(route)?.agency_name ?? '',
          direction, headsign, requiresDestination: rail
        });
      }
    }
  }

  function nextLegs(from, stopIndex, to) {
    const fromStop = from.rows[stopIndex].stop_id;
    const toStop = to.rows[to.board].stop_id;
    const fromStation = stationOf(fromStop);
    const toStation = stationOf(toStop);
    const candidates = [...(transfers.get(fromStop) ?? []), ...(fromStation === fromStop ? [] : transfers.get(fromStation) ?? [])];
    const rules = candidates.filter(rule =>
      (rule.to_stop_id === toStop || rule.to_stop_id === toStation) &&
      (!rule.from_route_id || rule.from_route_id === from.trip.route_id) &&
      (!rule.to_route_id || rule.to_route_id === to.trip.route_id) &&
      (!rule.from_trip_id || rule.from_trip_id === from.trip.trip_id) &&
      (!rule.to_trip_id || rule.to_trip_id === to.trip.trip_id));
    const priority = rule => 100 * Boolean(rule.from_trip_id) + 100 * Boolean(rule.to_trip_id) +
      10 * Boolean(rule.from_route_id) + 10 * Boolean(rule.to_route_id) +
      Number(rule.from_stop_id === fromStop) + Number(rule.to_stop_id === toStop);
    rules.sort((a, b) => priority(b) - priority(a));
    const strongest = rules.filter(rule => priority(rule) === priority(rules[0]));
    if (strongest.some(rule => rule.transfer_type === '3')) return null;
    // No platform interchange is assumed faster than five minutes. Do not
    // turn in-seat or timed exceptions into a guarantee of a connection.
    return Math.max(5 * MINUTE, ...strongest.map(rule => 1000 * (Number(rule.min_transfer_time) || 0)));
  }

  const actual = (instance, row, key) => row[key] === null ? null : instance.epoch + row[key] * 1000;

  function bartConnection(origin, destination, boards, deadline) {
    const queue = [{ ...origin, earlier: [] }];
    const visited = new Set();
    for (let head = 0; head < queue.length; head++) {
      const leg = queue[head];
      for (let i = leg.board + 1; i < leg.rows.length; i++) {
        const row = leg.rows[i];
        const arrivalAt = actual(leg, row, 'arrival');
        if (arrivalAt === null || arrivalAt > deadline || arrivalAt < leg.departureAt || !dropOff(row)) continue;
        const state = `${leg.index}:${i}`;
        if (visited.has(state)) continue;
        visited.add(state);
        const station = stationOf(row.stop_id);
        const path = [...leg.earlier, {
          routeId: leg.trip.route_id, fromStopId: leg.rows[leg.board].stop_id, toStopId: row.stop_id,
          departureAt: leg.departureAt, arrivalAt
        }];
        if (station === destination) return path;
        for (const to of boards.get(station) ?? []) {
          if (to.index === leg.index || to.departureAt < arrivalAt + 5 * MINUTE || to.departureAt > arrivalAt + 60 * MINUTE) continue;
          const minimum = nextLegs(leg, i, to);
          if (minimum !== null && to.departureAt >= arrivalAt + minimum) queue.push({ ...to, earlier: path });
        }
      }
    }
    return null;
  }

  function departure({ date, stopId, stationId, routeId, direction, headsign, destinationStationId, startTime, endTime }) {
    date = civilDate(date);
    const bartOrigin = stationId ? stationOf(stationId) : null;
    const route = bartOrigin ? [...routes.values()].find(isBart) : routes.get(routeId);
    const agency = agencyFor(route);
    if (!date || !(bartOrigin ? bartStations.has(bartOrigin) : stops.has(stopId)) || !route || !agency?.agency_timezone) return UNAVAILABLE;
    const bart = isBart(route);
    if (bart && !destinationStationId) return { status: 'destination-required' };
    const destination = bart ? stationOf(destinationStationId) : null;
    if (bart && (!bartStations.has(destination) || destination === (bartOrigin || stationOf(stopId)))) return { status: 'invalid-destination' };
    const zone = agency.agency_timezone;
    const startClock = parseClock(startTime);
    const endClock = parseClock(endTime);
    if ((startTime && !startClock) || (endTime && !endClock)) return UNAVAILABLE;
    const anchor = startClock && startClock < '04:00:00' ? addDays(date, -1) : date;
    const nightEnd = addDays(anchor, 1);
    if (!covered(agency, anchor, nightEnd)) return UNAVAILABLE;
    let start, midnight, cutoff, morning, eventEndsAt;
    const epochs = new Map();
    try {
      start = startClock ? localTime(date, startClock, zone) : localHour(date, 0, zone);
      if (endClock && startClock) eventEndsAt = localTime(endClock <= startClock ? addDays(date, 1) : date, endClock, zone);
      midnight = localHour(nightEnd, 0, zone);
      cutoff = localHour(nightEnd, 4, zone);
      morning = localHour(nightEnd, 6, zone);
      for (let offset = -4; offset <= 1; offset++) {
        const serviceDate = addDays(anchor, offset);
        // GTFS time zero is local noon minus 12 elapsed hours (DST-safe).
        epochs.set(serviceDate, localHour(serviceDate, 12, zone) - DAY / 2);
      }
    } catch {
      return UNAVAILABLE;
    }

    const boards = new Map();
    const origins = [];
    let index = 0;
    let incomplete = false;
    const prior = addDays(anchor, -1);
    const serviceDays = new Map();
    for (const trip of trips) {
      const tripRoute = routes.get(trip.route_id);
      const matches = bartOrigin ? isBart(tripRoute) : trip.route_id === routeId && (direction === undefined || (trip.direction_id || '') === direction);
      if (!matches && !(bart && agencyFor(tripRoute) === agency && isBart(tripRoute))) continue;
      const rows = rowsByTrip.get(trip.trip_id);
      const originRow = (row, i) => (bartOrigin ? stationOf(row.stop_id) === bartOrigin : row.stop_id === stopId) && pickup(row) && i + 1 < rows.length &&
        (headsign === undefined || (row.stop_headsign || trip.trip_headsign || '') === headsign);
      if (!rows?.length || (!bart && !rows.some(originRow))) continue;
      const freq = frequencies.get(trip.trip_id) ?? [];
      if (!serviceDays.has(trip.service_id)) serviceDays.set(trip.service_id, [...epochs].filter(([day]) => active(trip.service_id, day)));
      for (const [serviceDate, epoch] of serviceDays.get(trip.service_id)) {
        if (serviceDate < prior && !rows.some(row => (row.departure ?? 0) >= 48 * 3600)) continue;
        const shifts = [];
        if (!freq.length) shifts.push(0);
        for (const entry of freq) {
          const begin = gtfsSeconds(entry.start_time);
          const end = gtfsSeconds(entry.end_time);
          const interval = Number(entry.headway_secs);
          const first = rows[0].departure;
          if (begin === null || end === null || first === null || end <= begin || !Number.isInteger(interval) || interval <= 0) {
            incomplete = true;
            continue;
          }
          if (epoch + end * 1000 < start - DAY || epoch + begin * 1000 > morning) continue;
          if (entry.exact_times !== '1' || (end - begin) / interval > 2000) {
            // A headway isn't a departure time. Don't give a fake exact last ride.
            if (epoch + (end + Math.max(0, (rows.at(-1).departure ?? first) - first)) * 1000 >= start) incomplete = true;
            continue;
          }
          for (let second = begin; second < end; second += interval) shifts.push((second - first) * 1000);
        }
        for (const shift of new Set(shifts)) {
          const instance = { epoch: epoch + shift, trip, rows, index: index++ };
          for (let board = 0; board + 1 < rows.length; board++) {
            const row = rows[board];
            if (!pickup(row)) continue;
            const departureAt = actual(instance, row, 'departure');
            if (departureAt === null) {
              if (matches && originRow(row, board) && serviceDate >= anchor) incomplete = true;
              continue;
            }
            if (departureAt < (bart ? start : Math.min(start, midnight - 90 * MINUTE)) || departureAt > morning) continue;
            const leg = { ...instance, board, departureAt };
            if (bart) {
              const station = stationOf(row.stop_id);
              if (!boards.has(station)) boards.set(station, []);
              boards.get(station).push(leg);
            }
            if (matches && originRow(row, board) &&
                rows.slice(board + 1).some(next => dropOff(next) && next.arrival !== null && next.arrival >= row.departure)) origins.push(leg);
          }
        }
      }
    }
    if (incomplete) return UNAVAILABLE;

    origins.sort((a, b) => b.departureAt - a.departureAt);
    if (!bart) {
      // Label as overnight only when this boarding direction has continuous
      // scheduled service across midnight into morning. A 1 AM final bus is
      // a final departure, not Owl service.
      const night = [...new Set(origins.map(leg => leg.departureAt))].reverse();
      const first = night.findIndex(at => at >= midnight - 90 * MINUTE);
      if (first >= 0 && night[first] <= midnight && night.at(-1) >= morning - 90 * MINUTE &&
          night.slice(first + 1).every((at, i) => at - night[first + i] <= 90 * MINUTE)) {
        return { status: 'overnight', timezone: zone };
      }
    }

    for (const origin of origins) {
      if (origin.departureAt < start || origin.departureAt >= cutoff) continue;
      const itinerary = bart ? bartConnection(origin, destination, boards, morning) : undefined;
      if (bart && !itinerary) continue;
      return {
        status: 'scheduled', departureAt: origin.departureAt, timezone: zone,
        stopId: origin.rows[origin.board].stop_id, routeId: origin.trip.route_id, tripId: origin.trip.trip_id,
        timing: origin.rows[origin.board].timepoint === '0' ? 'feed-estimate' : 'scheduled',
        ...(itinerary && { itinerary }),
        ...(Number.isFinite(eventEndsAt) && { departsBeforeEventEnds: origin.departureAt < eventEndsAt })
      };
    }
    return { status: 'no-service', timezone: zone };
  }

  return {
    choices: stopId => [...(choicesByStop.get(stopId)?.values() ?? [])],
    destinations: stopId => [...bartStations.values()].filter(station => station.stationId !== stationOf(stopId))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
    departure
  };
}

module.exports = { createGtfsSchedule };
