'use strict';

const { isMakeOutRoomEvent, PILOT } = require('./make-out-room');
const { createMakeOutRoomTransit, eventDate } = require('./index');
const { scheduleNightEnd } = require('./gtfs-schedule');
const { sfTransit, sfTransitEnabled } = require('./sf-transit');
const { sfCoverageInput } = require('./sf-coverage-store');

const MINUTE = 60_000;
const RIDE_BUFFER_MINUTES = 5;
const RIDE_NOTICE_MINUTES = 30;

function gettingHomeEnabled(env = process.env) {
  return env.TRANSIT_GETTING_HOME_ENABLED === 'true';
}

function gettingHomeEligible(event, env = process.env, now = Date.now()) {
  return gettingHomeEnabled(env) && isMakeOutRoomEvent(event) && planningWindowOpen(event, now);
}

function sfGettingHomeEligible(event, env = process.env, now = Date.now()) {
  return sfTransitEnabled(env) && Boolean(sfCoverageInput(event)) && planningWindowOpen(event, now);
}

function planningWindowEnd(event) {
  if (event?.timezone !== PILOT.timezone || !event.ends_at) return null;
  const ends = new Date(event.ends_at).getTime();
  const nightEnd = scheduleNightEnd(eventDate(event.event_date), event.start_time, event.timezone);
  // The relevant trip can be hours after the show, so keep an authorized
  // attendee's plan/cancellation and the send-time recheck available for the
  // rest of that service night. The dashboard still hides ended show cards.
  return Number.isFinite(ends) ? Math.max(ends, nightEnd || 0) : null;
}

function planningWindowOpen(event, now) {
  const end = planningWindowEnd(event);
  return end !== null && end > now;
}

function readTransitSelection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const id = key => typeof input[key] === 'string' && /^[\p{L}\p{N}_.:/-]{1,100}$/u.test(input[key]) ? input[key] : null;
  if (input.stationId !== undefined) {
    const stationId = id('stationId');
    const destinationStationId = id('destinationStationId');
    return stationId && destinationStationId && stationId !== destinationStationId ? { stationId, destinationStationId } : null;
  }
  const stopId = id('stopId');
  const routeId = id('routeId');
  const { direction, headsign } = input;
  if (!stopId || !routeId || !['', '0', '1'].includes(direction) || typeof headsign !== 'string' ||
      headsign.length > 160 || /[\x00-\x1f\x7f]/.test(headsign)) return null;
  return { stopId, routeId, direction, headsign };
}

function createGettingHome({ transit = createMakeOutRoomTransit(), cityTransit = sfTransit, now = Date.now, env = process.env } = {}) {
  function adapter(event) {
    if (gettingHomeEligible(event, env, now())) return transit;
    if (event?.sfWalks?.length && sfGettingHomeEligible(event, env, now())) return cityTransit;
    return null;
  }
  return {
    async getOptions(event) {
      const selected = adapter(event);
      if (!selected) return { status: 'unsupported-event' };
      const result = await selected.getOptions(event);
      if (result.status !== 'available') return { status: result.status };
      return {
        status: 'available', venue: result.venue || PILOT.name, stops: result.stops, attribution: result.attribution,
        ...(result.walkingAttribution && { walkingAttribution: result.walkingAttribution }),
        directionsUrl: `/e/${encodeURIComponent(event.slug)}#event-location-map`
      };
    },
    async getDeparture(event, form, { includeUpcoming = false } = {}) {
      const selected = adapter(event);
      if (!selected) return { status: 'unsupported-event' };
      const selection = readTransitSelection(form);
      if (!selection) return { status: 'unsupported-selection' };
      const safetyBufferMinutes = RIDE_BUFFER_MINUTES;
      const plan = await selected.getDeparture(event, selection, includeUpcoming ? { now, safetyBufferMinutes } : undefined);
      const { status, attribution, stopName, walkSeconds, timezone, timing, departureAt, fetchedAt, departsBeforeEventEnds } = plan;
      const upcoming = includeUpcoming && plan.upcoming;
      if (status !== 'scheduled') return { status, attribution, stopName, walkSeconds, timezone, ...(status === 'overnight' && upcoming && { upcoming }) };
      if (!Number.isSafeInteger(departureAt) || !Number.isSafeInteger(walkSeconds) || walkSeconds <= 0) return { status: 'schedule-unavailable' };
      const checkedAt = now();
      if (departureAt <= checkedAt) return { status: 'no-service', attribution, stopName, timezone };
      const leaveByAt = departureAt - (walkSeconds * 1000 + safetyBufferMinutes * MINUTE);
      const proposed = leaveByAt - RIDE_NOTICE_MINUTES * MINUTE;
      return {
        status, timing, timezone, attribution, stopName, walkSeconds, safetyBufferMinutes, departureAt, leaveByAt,
        proposedReminderAt: selected === transit && timing === 'scheduled' && proposed > checkedAt ? proposed : null,
        departsBeforeEventEnds, fetchedAt,
        ...(upcoming && { upcoming }),
        ...(includeUpcoming && { leaveByPassed: leaveByAt < checkedAt })
      };
    }
  };
}

module.exports = { gettingHomeEligible, sfGettingHomeEligible, gettingHomeEnabled, planningWindowEnd, readTransitSelection, createGettingHome, RIDE_NOTICE_MINUTES };
