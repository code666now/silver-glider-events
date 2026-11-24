'use strict';

const { isMakeOutRoomEvent } = require('./make-out-room');

// The caller must supply a canonical user ID from server-side attendee/session
// authorization, never a submitted user ID, organizer ID, or RSVP email.
const verifiedUser = `u.id=$1 AND u.account_status='active' AND EXISTS (
  SELECT 1 FROM user_identities identity
   WHERE identity.user_id=u.id AND identity.verification_scope='account'
     AND identity.verified_at IS NOT NULL AND identity.revoked_at IS NULL
)`;

function validUserId(userId) {
  return Number.isInteger(userId) && userId > 0 && userId <= 2147483647;
}

function validField(value, { blank = false } = {}) {
  return typeof value === 'string' && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value)
    && (blank || Boolean(value) && value === value.trim());
}

function normalizeSavedSelection(selection) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return null;
  const { stationId, destinationStationId, stopId, routeId, direction, headsign } = selection;
  if (stationId != null || destinationStationId != null) {
    if (!validField(stationId) || !validField(destinationStationId) || stationId === destinationStationId
        || [stopId, routeId, direction, headsign].some(field => field != null)) return null;
    return { stationId, destinationStationId };
  }
  if (!validField(stopId) || !validField(routeId) || !['', '0', '1'].includes(direction)
      || !validField(headsign, { blank: true })) return null;
  return { stopId, routeId, direction, headsign };
}

function savedSelectionFromRow(row) {
  if (row.selection_kind === 'rail') {
    return normalizeSavedSelection({ stationId: row.station_id, destinationStationId: row.destination_station_id });
  }
  if (row.selection_kind === 'stop') {
    return normalizeSavedSelection({ stopId: row.stop_id, routeId: row.route_id, direction: row.direction, headsign: row.headsign });
  }
  return null;
}

function matchVerifiedOption(stops, selection) {
  for (const stop of stops) {
    if (!Number.isFinite(stop.walkSeconds) || stop.walkSeconds <= 0 || !Array.isArray(stop.routes)) continue;
    if (selection.stationId && stop.stationId === selection.stationId && stop.routes.some(route => route.requiresDestination)) {
      const destination = stop.destinations?.find(station => station.stationId === selection.destinationStationId);
      if (destination) return { routeLabel: 'BART', stopLabel: stop.name, directionLabel: destination.name, destinationLabel: destination.name };
    } else if (!selection.stationId && stop.stopId === selection.stopId) {
      const route = stop.routes.find(item => !item.requiresDestination && item.routeId === selection.routeId
        && item.direction === selection.direction && item.headsign === selection.headsign);
      if (route) return { routeLabel: route.name, stopLabel: stop.name, directionLabel: route.headsign };
    }
  }
  return null;
}

function createSavedRouteService({ db, transit, now = Date.now }) {
  const findAccountPreference = async userId => {
    const { rows } = await db.query(
      `SELECT p.selection_kind,p.stop_id,p.route_id,p.direction,p.headsign,p.station_id,p.destination_station_id
         FROM users u LEFT JOIN transit_saved_routes p ON p.user_id=u.id
        WHERE ${verifiedUser}`,
      [userId]
    );
    return rows[0] || null;
  };

  async function verifyOption(event, selection) {
    if (!isMakeOutRoomEvent(event)) return { status: 'not-applicable' };
    try {
      const options = await transit.getOptions(event);
      if (options?.status === 'unsupported-event') return { status: 'not-applicable' };
      if (options?.status !== 'available' || !Array.isArray(options.stops)) return { status: 'unavailable' };
      const labels = matchVerifiedOption(options.stops, selection);
      if (!labels) return { status: 'not-applicable' };
      // Existence in the general GTFS route list isn't enough: distinguish a
      // currently serviceable itinerary from weekend/holiday/connection gaps.
      const departure = await transit.getDeparture(event, selection);
      if (!departure || departure.status === 'schedule-unavailable') return { status: 'unavailable' };
      if (!(departure.status === 'overnight' || departure.status === 'scheduled'
          && Number.isFinite(departure.departureAt) && departure.departureAt > now())) return { status: 'not-applicable' };
      return { status: 'available', selection, ...labels };
    } catch {
      return { status: 'unavailable' };
    }
  }

  return {
    async status({ userId } = {}) {
      if (!validUserId(userId)) return { status: 'unavailable' };
      const row = await findAccountPreference(userId);
      return row ? { status: 'available', hasPreference: Boolean(row.selection_kind) } : { status: 'unavailable' };
    },
    async get({ userId, event } = {}) {
      if (!validUserId(userId)) return { status: 'not-eligible' };
      if (!isMakeOutRoomEvent(event)) return { status: 'not-applicable' };
      const row = await findAccountPreference(userId);
      if (!row) return { status: 'not-eligible' };
      if (!row.selection_kind) return { status: 'none' };
      const selection = savedSelectionFromRow(row);
      const result = selection ? await verifyOption(event, selection) : { status: 'not-applicable' };
      // A stale preference remains removable, but never disclose its route
      // or destination to a page on which it cannot be safely reused.
      return result.status === 'available' ? result : { ...result, hasPreference: true };
    },

    async save({ userId, event, selection: input, remember } = {}) {
      if (remember !== true) return { status: 'not-requested' };
      if (!validUserId(userId)) return { status: 'not-eligible' };
      if (!isMakeOutRoomEvent(event)) return { status: 'not-applicable' };
      const selection = normalizeSavedSelection(input);
      if (!selection) return { status: 'not-applicable' };
      if (!await findAccountPreference(userId)) return { status: 'not-eligible' };
      const result = await verifyOption(event, selection);
      if (result.status !== 'available') return result;

      // Recheck eligibility in the write and lock the owner against concurrent
      // erasure, so a preference cannot be recreated behind a user tombstone.
      const { rowCount } = await db.query(
        `WITH eligible_user AS MATERIALIZED (
           SELECT u.id FROM users u WHERE ${verifiedUser} FOR SHARE OF u
         )
         INSERT INTO transit_saved_routes (user_id,selection_kind,stop_id,route_id,direction,headsign,station_id,destination_station_id)
         SELECT id,$2,$3,$4,$5,$6,$7,$8 FROM eligible_user
         ON CONFLICT (user_id) DO UPDATE
           SET selection_kind=EXCLUDED.selection_kind,stop_id=EXCLUDED.stop_id,route_id=EXCLUDED.route_id,
               direction=EXCLUDED.direction,headsign=EXCLUDED.headsign,station_id=EXCLUDED.station_id,
               destination_station_id=EXCLUDED.destination_station_id,updated_at=NOW()`,
        [userId, selection.stationId ? 'rail' : 'stop', selection.stopId ?? null, selection.routeId ?? null,
          selection.direction ?? null, selection.headsign ?? null, selection.stationId ?? null, selection.destinationStationId ?? null]
      );
      return rowCount ? result : { status: 'not-eligible' };
    },

    async remove({ userId } = {}) {
      if (!validUserId(userId)) return { status: 'not-eligible' };
      const { rows } = await db.query(
        `WITH eligible_user AS (SELECT u.id FROM users u WHERE ${verifiedUser}),
         removed AS (DELETE FROM transit_saved_routes p USING eligible_user WHERE p.user_id=eligible_user.id)
         SELECT EXISTS (SELECT 1 FROM eligible_user) AS allowed`,
        [userId]
      );
      return { status: rows[0]?.allowed ? 'removed' : 'not-eligible' };
    }
  };
}

module.exports = { createSavedRouteService };
