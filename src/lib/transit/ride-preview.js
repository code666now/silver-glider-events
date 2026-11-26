'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');
const { PILOT } = require('./make-out-room');
const { scheduleNightEnd } = require('./gtfs-schedule');

const PREVIEW_SLUG = 'make-out-room-schedule-preview';
const PREVIEW_PATH = `/e/${PREVIEW_SLUG}/getting-home`;
const PREVIEW_COOKIE = 'sge_ride_schedule_preview';
const PREVIEW_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CITY_PREVIEW_SLUG = 'san-francisco-schedule-preview';
const CITY_PREVIEW_PATH = `/e/${CITY_PREVIEW_SLUG}/getting-home`;
const CITY_PREVIEW_COOKIE = 'sge_sf_ride_schedule_preview';
const CITY_PREVIEW_MAX_WALKS = 12;
const CITY_PREVIEW_MAX_TOKEN = 3000;

function ridePreviewEnabled(env = process.env) {
  return env.TRANSIT_GETTING_HOME_ENABLED === 'true' && env.TRANSIT_TEST_PREVIEW_ENABLED === 'true';
}

// An operations-only fixture with public venue data. No events, RSVPs, or
// identities are inserted or used by a preview request.
function ridePreviewEvent(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return null;
  const start_time = '15:38';
  const ends_at = scheduleNightEnd(date, start_time, PILOT.timezone);
  if (!ends_at) return null;
  return {
    slug: PREVIEW_SLUG, event_date: date, start_time, ends_at,
    venue_name: PILOT.name, venue_address: PILOT.address, venue_city: PILOT.city, venue_state: PILOT.state,
    status: 'published', visibility: 'public', timezone: PILOT.timezone
  };
}

function createRidePreview({ env = process.env, now = Date.now } = {}) {
  const key = String(env.SESSION_SECRET || '').trim();
  const sign = (kind, date) => createHmac('sha256', key)
    .update(`sge:transit-preview:${kind}:v1\0`).update(date).digest('base64url');

  function issue(kind, date) {
    if (!key || !ridePreviewEnabled(env)) return null;
    const event = ridePreviewEvent(date);
    const remaining = event?.ends_at - now();
    if (remaining <= 0 || remaining > PREVIEW_MAX_AGE_MS || !Number.isFinite(remaining)) return null;
    return `${date}.${sign(kind, date)}`;
  }

  function verify(kind, value) {
    if (!key || !ridePreviewEnabled(env) || typeof value !== 'string' || value.length !== 54) return null;
    const match = /^(\d{4}-\d{2}-\d{2})\.([A-Za-z0-9_-]{43})$/.exec(value);
    if (!match) return null;
    const [, date, signature] = match;
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(sign(kind, date)))) return null;
    return issue(kind, date) ? ridePreviewEvent(date) : null;
  }

  return {
    issueLink: date => {
      const token = issue('link', date);
      return token ? `${PREVIEW_PATH}/from-test?t=${encodeURIComponent(token)}` : null;
    },
    verifyLink: value => verify('link', value),
    issueCookie: date => issue('cookie', date),
    verifyCookie: value => verify('cookie', value)
  };
}

const CITY_PREVIEW_VENUES = Object.freeze({
  haight: Object.freeze({ venue_name: 'Haight Street (sample venue)', venue_address: '1725 Haight St, San Francisco, CA, USA',
    google_place_id: 'sge-sf-preview-haight', venue_latitude: 37.769, venue_longitude: -122.451 }),
  kilowatt: Object.freeze({ venue_name: 'Kilowatt', venue_address: '3160 16th St, San Francisco, CA 94103, USA',
    google_place_id: 'sge-sf-preview-kilowatt', venue_latitude: 37.765, venue_longitude: -122.423 })
});

function cityRidePreviewEvent(date, testVenue = 'haight') {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!Object.hasOwn(CITY_PREVIEW_VENUES, testVenue)) return null;
  const start_time = '20:00';
  const ends_at = scheduleNightEnd(date, start_time, PILOT.timezone);
  if (!ends_at) return null;
  return {
    // Sentinel id and selection metadata only. The preview never looks up
    // this id; the walking preparer independently resolves the address.
    id: 2147483647,
    slug: CITY_PREVIEW_SLUG, event_date: date, start_time, end_time: '22:00', ends_at, testVenue,
    ...CITY_PREVIEW_VENUES[testVenue], venue_city: 'San Francisco', venue_state: 'CA',
    status: 'published', visibility: 'public', timezone: PILOT.timezone
  };
}

function cityPreviewWalks(value) {
  // Reuse the cache validator without connecting to the database. Only the
  // allowlisted fields from public GTFS stop records enter preview tokens.
  const walks = require('./sf-coverage-store').cleanCachedWalks(value);
  return walks?.length && walks.every(({ lat, lon, walkSeconds }) =>
    lat >= 37.69 && lat <= 37.85 && lon >= -122.56 && lon <= -122.35 && walkSeconds <= 600) ? walks : null;
}

function createCityRidePreview({ env = process.env, now = Date.now } = {}) {
  const key = String(env.SESSION_SECRET || '').trim();
  const enabled = () => Boolean(key) && ridePreviewEnabled(env) && env.TRANSIT_SF_GETTING_HOME_ENABLED === 'true';
  const sign = (kind, payload) => createHmac('sha256', key)
    .update(`sge:transit-sf-preview:${kind}:v1\0`).update(payload).digest('base64url');
  const eventInWindow = (date, venue) => {
    const event = cityRidePreviewEvent(date, venue);
    const remaining = event?.ends_at - now();
    return remaining > 0 && remaining <= PREVIEW_MAX_AGE_MS ? event : null;
  };

  function issue(kind, date, value, venue = 'haight') {
    if (!enabled() || !eventInWindow(date, venue)) return null;
    const walks = cityPreviewWalks(value);
    if (!walks) return null;
    const stops = walks.sort((a, b) => a.walkSeconds - b.walkSeconds).slice(0, CITY_PREVIEW_MAX_WALKS)
      .map(({ stopId, stationId, lat, lon, walkSeconds }) => [stopId, stationId ?? null, lat, lon, walkSeconds]);
    // Keep the nearest verified walks if unusually long feed identifiers
    // would make the URL/cookie too long. Typical feed IDs fit all 12.
    while (stops.length) {
      const payload = Buffer.from(JSON.stringify(venue === 'haight' ? [date, stops] : [date, stops, venue])).toString('base64url');
      if (payload.length + 44 <= CITY_PREVIEW_MAX_TOKEN) return `${payload}.${sign(kind, payload)}`;
      stops.pop();
    }
    return null;
  }

  function verify(kind, token) {
    if (!enabled() || typeof token !== 'string' || token.length > CITY_PREVIEW_MAX_TOKEN) return null;
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match) return null;
    const [, payload, signature] = match;
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(sign(kind, payload)))) return null;
    let claims;
    try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
    catch { return null; }
    if (!Array.isArray(claims) || ![2, 3].includes(claims.length)) return null;
    const [date, stops, venue = 'haight'] = claims;
    const event = eventInWindow(date, venue);
    if (!event || !Array.isArray(stops) || stops.length > CITY_PREVIEW_MAX_WALKS ||
      stops.some(stop => !Array.isArray(stop) || stop.length !== 5)) return null;
    const sfWalks = cityPreviewWalks(stops.map(([stopId, stationId, lat, lon, walkSeconds]) => (
      { stopId, stationId, lat, lon, walkSeconds }
    )));
    return sfWalks ? { ...event, sfWalks } : null;
  }

  return {
    issueLink: (date, walks, venue) => {
      const token = issue('link', date, walks, venue);
      return token ? `${CITY_PREVIEW_PATH}/from-test?t=${encodeURIComponent(token)}` : null;
    },
    verifyLink: value => verify('link', value),
    issueCookie: (date, walks, venue) => issue('cookie', date, walks, venue),
    verifyCookie: value => verify('cookie', value)
  };
}

module.exports = {
  createRidePreview, ridePreviewEnabled, PREVIEW_SLUG, PREVIEW_PATH, PREVIEW_COOKIE,
  createCityRidePreview, cityRidePreviewEvent, CITY_PREVIEW_SLUG, CITY_PREVIEW_PATH, CITY_PREVIEW_COOKIE
};
