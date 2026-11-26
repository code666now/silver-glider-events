'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');
const pool = require('../../config/db');
const { currentServiceNight } = require('./gtfs-schedule');
const { PILOT, isMakeOutRoomEvent } = require('./make-out-room');
const { sfTransit } = require('./sf-transit');
const { selectedSfVenue } = require('./sf-venue-address');
const { cleanCachedWalks, MAX_WALKS } = require('./sf-coverage-store');
const { sfRolloutBlockReason } = require('./sf-rollout');

const TESTER_PAGE = '/admin/transportation/venue-test';
const TESTER_PLAN = `${TESTER_PAGE}/plan`;
const TESTER_API = '/api/admin/transportation/venue-test';
const TESTER_COOKIE = 'sge_admin_venue_test';
const TESTER_MAX_AGE = 15 * 60_000;
const TESTER_ID = 2147483647; // Never inserted into or resolved through the events table.
const MAX_ROLLING_CREDITS = 2400;
const WALK_JOB_LOCK = 'transit:sf-coverage-worker-v1'; // Same lock used by the background worker.
const HOUR = 3_600_000;
const validUser = id => Number.isSafeInteger(id) && id > 0 && id <= 2147483647;
const invalid = (status, code) => Object.assign(new Error(code), { status, code });
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : '';

function selectionEvent(value, current) {
  if (!value || typeof value !== 'object') return null;
  const night = currentServiceNight(current, PILOT.timezone);
  const { lat, lng } = value;
  if (!night || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < 37.68 || lat > 37.84 || lng < -122.53 || lng > -122.34) return null;
  const event = {
    id: TESTER_ID, slug: 'admin-venue-test', event_date: night.anchor, start_time: '04:00', ends_at: night.endsAt,
    venue_name: text(value.name, 140), venue_address: text(value.address, 250), venue_city: text(value.city, 100),
    venue_state: text(value.state, 20), google_place_id: text(value.placeId, 180), venue_latitude: lat, venue_longitude: lng,
    status: 'published', visibility: 'public', timezone: PILOT.timezone
  };
  const venue = selectedSfVenue(event);
  return venue && event.venue_name ? { event, venue } : null;
}

function createVenueTester({ db = pool, env = process.env, now = Date.now, prepareVenue = sfTransit.prepareVenue } = {}) {
  const key = String(env.SESSION_SECRET || '').trim();
  const sign = value => createHmac('sha256', key).update('sge:admin-venue-tester:v1\0').update(value).digest('base64url');
  const sessionMatches = (scope, current) => validUser(scope?.operatorId) && Number.isSafeInteger(scope?.sessionIssuedAt)
    && scope.sessionIssuedAt > 0 && scope.sessionIssuedAt <= current;

  async function readCache(connection, venue, current) {
    const { rows: [row] } = await connection.query(`SELECT walks FROM transit_sf_venue_coverage
      WHERE venue_key=$1 AND expires_at>$2`, [venue.key, new Date(current)]);
    return row ? cleanCachedWalks(row.walks) : null;
  }

  async function resolveWalks(event, venue, current) {
    const cached = await readCache(db, venue, current);
    if (cached !== null) return cached;
    const client = await db.connect();
    let locked;
    let discard = false;
    try {
      const result = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [WALK_JOB_LOCK]);
      locked = result.rows[0]?.locked === true;
      // The background worker can have completed the same lookup between our first read and this lock.
      const currentCache = await readCache(client, venue, now());
      if (currentCache !== null) return currentCache;
      if (!locked) throw invalid(503, 'coverage_busy');

      let reserved = false;
      let requested = false;
      const reserve = async credits => {
        if (requested || !Number.isInteger(credits) || credits < 1 || credits > MAX_WALKS) return false;
        requested = true;
        const charge = await client.query(`INSERT INTO transit_sf_walk_reservations(credits)
          SELECT $1::int WHERE $1::int + COALESCE((SELECT SUM(credits) FROM transit_sf_walk_reservations
            WHERE reserved_at > clock_timestamp() - INTERVAL '24 hours'),0)<=$2`, [credits, MAX_ROLLING_CREDITS]);
        reserved = charge.rowCount === 1;
        if (!reserved) throw invalid(429, 'walk_budget');
        return true;
      };
      const walks = cleanCachedWalks(await prepareVenue(event, venue, reserve));
      if (!walks || (walks.length > 0 && !reserved)) throw invalid(503, 'coverage_unavailable');
      const expires = new Date(now() + (walks.length ? 24 * HOUR : HOUR));
      await client.query(`INSERT INTO transit_sf_venue_coverage(venue_key,walks,expires_at) VALUES ($1,$2::jsonb,$3)
        ON CONFLICT (venue_key) DO UPDATE SET walks=EXCLUDED.walks,expires_at=EXCLUDED.expires_at`, [venue.key, JSON.stringify(walks), expires]);
      return walks;
    } finally {
      if (locked) {
        try {
          const result = await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked', [WALK_JOB_LOCK]);
          discard = result.rows[0]?.unlocked !== true;
        } catch { discard = true; }
      } else if (locked === undefined) discard = true;
      client.release(discard);
    }
  }

  return {
    async prepare(selection, scope) {
      const current = now();
      if (!key || !sessionMatches(scope, current)) throw invalid(401, 'session_required');
      if (sfRolloutBlockReason(env)) throw invalid(503, 'coverage_unavailable');
      const result = selectionEvent(selection, current);
      if (!result) throw invalid(400, 'sf_venue_required');
      const { event, venue } = result;
      if (!isMakeOutRoomEvent(event)) await resolveWalks(event, venue, current);
      const cleanSelection = {
        name: event.venue_name, address: event.venue_address, city: event.venue_city, state: event.venue_state,
        placeId: event.google_place_id, lat: event.venue_latitude, lng: event.venue_longitude
      };
      const payload = Buffer.from(JSON.stringify([scope.operatorId, scope.sessionIssuedAt, now() + TESTER_MAX_AGE, cleanSelection])).toString('base64url');
      return `${payload}.${sign(payload)}`;
    },

    async read(token, scope) {
      const current = now();
      if (!key || sfRolloutBlockReason(env) || !sessionMatches(scope, current) || typeof token !== 'string' || token.length > 1800) return null;
      const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
      if (!match || !timingSafeEqual(Buffer.from(sign(match[1])), Buffer.from(match[2]))) return null;
      let claims;
      try { claims = JSON.parse(Buffer.from(match[1], 'base64url').toString()); } catch { return null; }
      if (!Array.isArray(claims) || claims.length !== 4) return null;
      const [operator, session, expires, selection] = claims;
      if (operator !== scope.operatorId || session !== scope.sessionIssuedAt || !Number.isSafeInteger(expires)
          || expires <= current || expires - current > TESTER_MAX_AGE) return null;
      const result = selectionEvent(selection, current);
      if (!result) return null;
      const { event, venue } = result;
      if (isMakeOutRoomEvent(event)) return event;
      const sfWalks = await readCache(db, venue, current);
      return sfWalks === null ? null : { ...event, sfWalks };
    }
  };
}

module.exports = { createVenueTester, TESTER_PAGE, TESTER_PLAN, TESTER_API, TESTER_COOKIE, TESTER_MAX_AGE };
