const crypto = require('crypto');
const { readCookie } = require('./private-events');

const COOKIE_NAME = 'sge_guest';
const MAX_AGE_SECONDS = 180 * 24 * 3600;

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function appendCookie(res, value, maxAge = MAX_AGE_SECONDS) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

function setGuestSessionCookie(res, token) {
  appendCookie(res, token);
}

function clearGuestSessionCookie(res) {
  appendCookie(res, '', 0);
}

// `verifiedEventId` limits a verified session to one event. Personal invitation
// links use it because invitations get forwarded; a code typed on the page
// proves the email outright and leaves it NULL.
async function createGuestSession(db, { identityId, displayFirstName, displayName, verified = false, verifiedEventId = null }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const firstName = String(displayFirstName || '').trim().slice(0, 80) || 'there';
  const fullName = String(displayName || '').trim().replace(/\s+/g, ' ').slice(0, 160) || firstName;
  const { rows } = await db.query(
    `INSERT INTO guest_sessions
       (identity_id,token_hash,display_first_name,display_name,verified_at,verified_event_id,expires_at)
     VALUES ($1,$2,$3,$4,CASE WHEN $5 THEN NOW() ELSE NULL END,$6,NOW() + INTERVAL '180 days')
     RETURNING id,identity_id,display_first_name,display_name,verified_at,verified_event_id,expires_at`,
    [identityId, tokenHash(token), firstName, fullName, verified, verified ? verifiedEventId : null]
  );
  return { ...rows[0], token };
}

async function readGuestSession(db, req, { touch = false } = {}) {
  const token = readCookie(req, COOKIE_NAME);
  if (!token || token.length > 180) return null;
  const statement = touch
    ? `UPDATE guest_sessions gs SET last_seen_at=NOW()
         FROM organizers o
        WHERE gs.token_hash=$1 AND gs.identity_id=o.id AND gs.revoked_at IS NULL AND gs.expires_at>NOW()
        RETURNING gs.id,gs.identity_id,gs.display_first_name,gs.display_name,
                  gs.verified_at,gs.verified_event_id,gs.expires_at,o.email`
    : `SELECT gs.id,gs.identity_id,gs.display_first_name,gs.display_name,
              gs.verified_at,gs.verified_event_id,gs.expires_at,o.email
         FROM guest_sessions gs JOIN organizers o ON o.id=gs.identity_id
        WHERE gs.token_hash=$1 AND gs.revoked_at IS NULL AND gs.expires_at>NOW()`;
  const { rows } = await db.query(statement, [tokenHash(token)]);
  return rows[0] || null;
}

// True when this guest session has proven its email for `eventId`: either
// outright (a typed code) or through that event's own invitation link.
function guestVerifiedFor(guest, eventId) {
  if (!guest?.verified_at) return false;
  return guest.verified_event_id == null || Number(guest.verified_event_id) === Number(eventId);
}

async function revokeIdentityGuestSessions(db, identityId) {
  const { rowCount } = await db.query(
    'UPDATE guest_sessions SET revoked_at=NOW() WHERE identity_id=$1 AND revoked_at IS NULL',
    [identityId]
  );
  return rowCount;
}

async function revokeGuestSession(db, req) {
  const token = readCookie(req, COOKIE_NAME);
  if (!token || token.length > 180) return 0;
  const { rowCount } = await db.query(
    'UPDATE guest_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE token_hash=$1',
    [tokenHash(token)]
  );
  return rowCount;
}

module.exports = {
  COOKIE_NAME,
  MAX_AGE_SECONDS,
  clearGuestSessionCookie,
  createGuestSession,
  guestVerifiedFor,
  readGuestSession,
  revokeGuestSession,
  revokeIdentityGuestSessions,
  setGuestSessionCookie,
  tokenHash
};
