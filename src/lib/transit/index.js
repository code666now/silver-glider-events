'use strict';

const { create511ScheduleSource, GTFS_511_ATTRIBUTION } = require('./gtfs-feed');
const { createGtfsSchedule } = require('./gtfs-schedule');
const { PILOT, isMakeOutRoomEvent, discoverPilotStops } = require('./make-out-room');

function selectPilotStopTimes(tables) {
  const nearby = new Set(Object.values(discoverPilotStops(tables)).flat().map(stop => stop.stopId));
  const bartAgencies = new Set(tables.agency.filter(agency => /\bBART\b|Bay Area Rapid Transit/i.test(agency.agency_name))
    .map(agency => agency.agency_id));
  const bartRoutes = new Set(tables.routes.filter(route => bartAgencies.has(route.agency_id)).map(route => route.route_id));
  const bartTrips = new Set(tables.trips.filter(trip => bartRoutes.has(trip.route_id)).map(trip => trip.trip_id));
  return row => nearby.has(row.stop_id) || bartTrips.has(row.trip_id);
}

function eventDate(value) {
  if (!(value instanceof Date)) return typeof value === 'string' ? value : '';
  // node-postgres parses a SQL DATE at local midnight, not as a UTC timestamp.
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

// Pilot and citywide adapters provide verified stops; both use the same
// schedule, selection validation and departure response shape.
function createVenueTransit({ load, eligible, venueName }) {
  return {
    async getOptions(event) {
      if (!eligible(event)) return { status: 'unsupported-event' };
      try {
        const { snapshot, schedule, stops } = await load(event);
        if (!stops.length) return { status: 'schedule-unavailable' };
        return {
          status: 'available', venue: venueName(event), fetchedAt: snapshot.fetchedAt, attribution: GTFS_511_ATTRIBUTION,
          stops: stops.filter(stop => stop.walkSeconds !== null).map(stop => ({
            ...stop,
            ...(stop.routes.some(route => route.requiresDestination) && { destinations: schedule.destinations(stop.stationId || stop.stopId) })
          })),
          unverifiedStops: stops.filter(stop => stop.walkSeconds === null)
        };
      } catch {
        return { status: 'schedule-unavailable' };
      }
    },
    async getDeparture(event, { stopId, stationId, routeId, direction, headsign, destinationStationId } = {}, planning) {
      if (!eligible(event)) return { status: 'unsupported-event' };
      if (!event.start_time) return { status: 'schedule-unavailable' };
      try {
        const { snapshot, schedule, stops } = await load(event);
        const stop = stops.find(stop => stop.walkSeconds !== null && (stationId
          ? stop.stationId === stationId && stop.routes.some(route => route.requiresDestination)
          : stop.stopId === stopId && stop.routes.some(route => route.routeId === routeId && route.direction === direction && route.headsign === headsign)));
        if (!stop) return { status: 'unsupported-selection' };
        const ridePlanning = planning && {
          nowMs: planning.now(), boardingLeadMs: stop.walkSeconds * 1000 + planning.safetyBufferMinutes * 60_000
        };
        const result = schedule.departure({
          date: eventDate(event.event_date), startTime: event.start_time, endTime: event.end_time,
          ...(stationId ? { stationId } : { stopId, routeId, direction, headsign }), destinationStationId, ridePlanning
        });
        return { ...result, stopName: stop.name, walkSeconds: stop.walkSeconds, fetchedAt: snapshot.fetchedAt, attribution: GTFS_511_ATTRIBUTION };
      } catch {
        return { status: 'schedule-unavailable' };
      }
    }
  };
}

function createMakeOutRoomTransit({ source = create511ScheduleSource({ selectStopTime: selectPilotStopTimes }) } = {}) {
  let memo;
  async function load() {
    const snapshot = await source.getSchedule();
    if (memo?.snapshot !== snapshot) {
      const schedule = createGtfsSchedule(snapshot.tables);
      const stops = Object.values(discoverPilotStops(snapshot.tables)).flat().map(stop => ({
        ...stop,
        routes: schedule.choices(stop.stopId).filter(route => !stop.agencyId || stop.agencyId === route.agencyId)
      })).filter(stop => stop.routes.length);
      memo = { snapshot, schedule, stops };
    }
    return memo;
  }

  function eligible(event) {
    return isMakeOutRoomEvent(event) && (!event.timezone || event.timezone === 'America/Los_Angeles');
  }

  return createVenueTransit({ load, eligible, venueName: () => PILOT.name });
}

module.exports = { createMakeOutRoomTransit, createVenueTransit, selectPilotStopTimes, eventDate };
