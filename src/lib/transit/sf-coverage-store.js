'use strict';

const { createHash } = require('node:crypto');
const pool = require('../../config/db');
const { isMakeOutRoomEvent } = require('./make-out-room');
const { selectedSfVenue } = require('./sf-venue-address');

const MAX_WALKS = 40;
const MAX_WALK_SECONDS = 660;
const stopIdentifier = /^[\p{L}\p{N}_.:/-]{1,100}$/u;

function civilDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    // pg's DATE parser returns local midnight, not UTC midnight.
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function civilTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?$/.test(value)
    ? value.length === 5 ? `${value}:00` : value : null;
}

function sfCoverageInput(event) {
  if (!event || event.archived_at != null || isMakeOutRoomEvent(event)) return null;
  const venue = selectedSfVenue(event);
  const id = Number(event.id);
  const date = civilDate(event.event_date);
  const start = civilTime(event.start_time);
  const end = event.end_time == null || event.end_time === '' ? null : civilTime(event.end_time);
  if (!venue || !Number.isSafeInteger(id) || id <= 0 || id > 2147483647 || !date || !start
      || (event.end_time != null && event.end_time !== '' && !end)) return null;
  const version = createHash('sha256').update(JSON.stringify(['sf-coverage-v1', venue.key, date, start, end])).digest('hex');
  return { id, venue, version };
}

function cleanCachedWalks(value) {
  if (!Array.isArray(value) || value.length > MAX_WALKS) return null;
  const ids = new Set();
  const walks = [];
  for (const row of value) {
    if (!row || typeof row.stopId !== 'string' || !stopIdentifier.test(row.stopId) || ids.has(row.stopId)
      || (row.stationId != null && (typeof row.stationId !== 'string' || !stopIdentifier.test(row.stationId)))
      || !Number.isFinite(row.lat) || Math.abs(row.lat) > 90 || !Number.isFinite(row.lon) || Math.abs(row.lon) > 180
      || !Number.isFinite(row.walkSeconds) || row.walkSeconds <= 0 || row.walkSeconds > MAX_WALK_SECONDS) return null;
    ids.add(row.stopId);
    walks.push({ stopId: row.stopId, ...(row.stationId != null && { stationId: row.stationId }),
      lat: row.lat, lon: row.lon, walkSeconds: Math.ceil(row.walkSeconds) });
  }
  return walks;
}

function createSfCoverageStore({ db = pool, now = Date.now } = {}) {
  async function readReady(events) {
    const inputs = new Map();
    for (const event of events) {
      const input = sfCoverageInput(event);
      if (input) inputs.set(String(input.id), input);
    }
    if (!inputs.size) return new Map();
    try {
      const { rows } = await db.query(`SELECT c.event_id, c.venue_key, c.input_version, v.walks
        FROM transit_sf_event_coverage c JOIN transit_sf_venue_coverage v ON v.venue_key=c.venue_key
        WHERE c.event_id=ANY($1::integer[]) AND c.ready_until>$2 AND v.expires_at>$2`,
      [[...inputs.keys()], new Date(now())]);
      const result = new Map();
      for (const row of rows) {
        const key = String(row.event_id);
        const input = inputs.get(key);
        if (!input || row.venue_key !== input.venue.key || row.input_version !== input.version) continue;
        const walks = cleanCachedWalks(row.walks);
        if (walks?.length) result.set(key, walks);
      }
      return result;
    } catch {
      return new Map();
    }
  }

  return {
    async readyEvents(events) {
      return new Set((await readReady(events)).keys());
    },
    async getReadyWalks(event) {
      return (await readReady([event])).get(String(event?.id)) ?? null;
    }
  };
}

module.exports = { createSfCoverageStore, sfCoverageInput, cleanCachedWalks, MAX_WALKS };
