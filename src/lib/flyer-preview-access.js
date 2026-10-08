const crypto = require('crypto');
const { readCookie } = require('./private-events');

const COOKIE_NAME = 'sge_flyer_preview';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function createPreviewToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function cleanToken(value) {
  const token = String(value || '').trim();
  return TOKEN_RE.test(token) ? token : '';
}

function cookieSuffix(maxAge = TOKEN_TTL_SECONDS) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Number(maxAge) || 0)}${secure}`;
}

function setPreviewCookie(res, token, maxAge = TOKEN_TTL_SECONDS) {
  res.append('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieSuffix(maxAge)}`);
}

function clearPreviewCookie(res) {
  res.append('Set-Cookie', `${COOKIE_NAME}=; ${cookieSuffix(0)}`);
}

async function readPreviewByToken(db, token, { eventId = null, forUpdate = false } = {}) {
  const clean = cleanToken(token);
  if (!clean) return null;
  const result = await db.query(
    `SELECT request.id,request.submitter_name,request.host_name,request.email,
            request.phone_e164,request.status,request.event_id,request.done_for_you_client_id,
            request.preview_revision,request.preview_token_expires_at,
            request.latest_fix_request,request.promoter_approved_at,request.phone_verified_at,
            event.slug AS event_slug,event.title AS event_title,event.status AS event_status,
            event.organizer_id,event.background_theme,event.presentation_mode
       FROM admin_flyer_requests request
       JOIN events event ON event.id=request.event_id
      WHERE request.preview_token_hash=$1
        AND request.preview_token_expires_at>NOW()
        AND request.status IN ('preview_sent','changes_requested','promoter_approved','published')
        AND ($2::int IS NULL OR request.event_id=$2)
      ${forUpdate ? 'FOR UPDATE OF request' : ''}`,
    [tokenHash(clean), eventId]
  );
  return result.rows[0] || null;
}

function previewCookieToken(req) {
  try { return cleanToken(decodeURIComponent(readCookie(req, COOKIE_NAME) || '')); }
  catch (_) { return ''; }
}

async function readFlyerPreviewAccess(db, req, options = {}) {
  const token = previewCookieToken(req);
  return token ? readPreviewByToken(db, token, options) : null;
}

module.exports = {
  COOKIE_NAME,
  TOKEN_TTL_SECONDS,
  cleanToken,
  clearPreviewCookie,
  createPreviewToken,
  previewCookieToken,
  readFlyerPreviewAccess,
  readPreviewByToken,
  setPreviewCookie,
  tokenHash
};
