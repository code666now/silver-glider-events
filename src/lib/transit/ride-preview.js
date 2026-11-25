'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');
const { PILOT } = require('./make-out-room');
const { scheduleNightEnd } = require('./gtfs-schedule');

const PREVIEW_SLUG = 'make-out-room-schedule-preview';
const PREVIEW_PATH = `/e/${PREVIEW_SLUG}/getting-home`;
const PREVIEW_COOKIE = 'sge_ride_schedule_preview';
const PREVIEW_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

module.exports = { createRidePreview, ridePreviewEnabled, PREVIEW_SLUG, PREVIEW_PATH, PREVIEW_COOKIE };
