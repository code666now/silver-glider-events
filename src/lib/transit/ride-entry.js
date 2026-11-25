'use strict';

const crypto = require('node:crypto');
const { gettingHomeEligible } = require('./getting-home');

const RIDE_ENTRY_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const EMAIL_LINK = 'sge:transit-ride-email-link:v1';
const BROWSER_GRANT = 'sge:transit-ride-browser-grant:v1';
const MAX_ID = 2147483647;
const validId = id => Number.isInteger(id) && id > 0 && id <= MAX_ID;

function rideEntryCookieName(eventId) {
  return validId(eventId) ? `sge_ride_access_${eventId}` : null;
}

function createRideEntry({ secret = process.env.SESSION_SECRET, now = Date.now } = {}) {
  const key = typeof secret === 'string' ? secret.trim() : '';
  const sign = (purpose, payload) => crypto.createHmac('sha256', key)
    .update(purpose).update('\0').update(payload).digest('base64url');

  function issueFor(purpose, { eventId, rsvpId, expiresAt, issuedAt } = {}) {
    if (!key || !validId(eventId) || !validId(rsvpId)) return null;
    const current = now();
    const bound = expiresAt instanceof Date ? expiresAt.getTime() : expiresAt;
    const start = issuedAt ?? current;
    if (!Number.isSafeInteger(current) || !Number.isSafeInteger(bound) || !Number.isSafeInteger(start) || start > current) return null;
    const issued = Math.floor(start / 1000);
    // Keep the lifetime bounded by both the authorized event's end and the
    // general maximum, truncating sub-second precision rather than extending.
    const expiry = Math.min(Math.floor(bound / 1000), issued + RIDE_ENTRY_MAX_AGE_MS / 1000);
    if (!Number.isSafeInteger(issued) || !Number.isSafeInteger(expiry) || issued < 1 || expiry <= issued || expiry * 1000 <= current) return null;
    const payload = `${eventId}.${rsvpId}.${issued}.${expiry}`;
    return `${payload}.${sign(purpose, payload)}`;
  }

  function verifyFor(purpose, token, { eventId } = {}) {
    if (!key || typeof token !== 'string' || token.length > 100) return null;
    const match = /^(\d{1,10})\.(\d{1,10})\.(\d{1,12})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match) return null;
    const [, event, rsvp, issue, expiry, signature] = match;
    const payload = token.slice(0, token.lastIndexOf('.'));
    const expected = sign(purpose, payload);
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const claims = { eventId: Number(event), rsvpId: Number(rsvp), issuedAt: Number(issue) * 1000, expiresAt: Number(expiry) * 1000 };
    const current = now();
    if (!validId(claims.eventId) || !validId(claims.rsvpId) || (eventId !== undefined && claims.eventId !== eventId)
        || !Number.isSafeInteger(current) || claims.issuedAt < 1000 || claims.issuedAt > current
        || claims.expiresAt <= current || claims.expiresAt <= claims.issuedAt
        || claims.expiresAt - claims.issuedAt > RIDE_ENTRY_MAX_AGE_MS) return null;
    return claims;
  }

  return {
    issue: claims => issueFor(EMAIL_LINK, claims),
    verify: (token, scope) => verifyFor(EMAIL_LINK, token, scope),
    // Only mint after checking the email link and confirmed RSVP together.
    // Its distinct signature cannot be replayed as a URL credential.
    issueCookie: ({ eventId, rsvpId, expiresAt } = {}) => issueFor(BROWSER_GRANT, { eventId, rsvpId, expiresAt }),
    verifyCookie: (token, scope) => validId(scope?.eventId) ? verifyFor(BROWSER_GRANT, token, scope) : null
  };
}

function rideEmailEntryPath({ event, rsvp, env = process.env, now = Date.now,
  entry = createRideEntry({ secret: env.SESSION_SECRET, now }) } = {}) {
  if (env.TRANSIT_DISTRIBUTION_ENABLED !== 'true' || !gettingHomeEligible(event, env, now())
      || !validId(event.id) || typeof event.slug !== 'string' || !/^[a-z0-9-]{1,120}$/i.test(event.slug)
      || rsvp?.status !== 'confirmed' || rsvp.wants_reminders !== true || rsvp.event_id !== event.id) return null;
  // A retry with the same mail delivery key must render the same URL, not a
  // different token every time it re-renders the existing reminder.
  const queuedAt = rsvp.reminder_queued_at == null ? undefined : new Date(rsvp.reminder_queued_at).getTime();
  const token = entry.issue({ eventId: event.id, rsvpId: rsvp.id, issuedAt: queuedAt, expiresAt: new Date(event.ends_at).getTime() });
  return token ? `/e/${encodeURIComponent(event.slug)}/getting-home/from-email?t=${encodeURIComponent(token)}` : null;
}

module.exports = { createRideEntry, rideEntryCookieName, rideEmailEntryPath, RIDE_ENTRY_MAX_AGE_MS };
