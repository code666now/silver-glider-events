const crypto = require('crypto');
const { readCookie } = require('./private-events');

// The "Add your photo" link in an RSVP confirmation proves the guest controls
// that inbox, but it must not become a full account session: confirmations get
// forwarded, and a host's own RSVP would otherwise hand out their dashboard.
// This short-lived cookie opens only the avatar page and avatar upload.
const COOKIE_NAME = 'sge_photo';
const MAX_AGE_SECONDS = 60 * 60;

function hmac(payload) {
  return crypto.createHmac('sha256', String(process.env.SESSION_SECRET || '').trim())
    .update(`photo-access:${payload}`).digest('hex');
}

function signPhotoAccess(identityId) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS;
  const payload = `${identityId}.${exp}`;
  return `${payload}.${hmac(payload)}`;
}

function readPhotoAccess(req) {
  const value = readCookie(req, COOKIE_NAME);
  if (!value || value.length > 200) return null;
  const [id, exp, sig] = value.split('.');
  if (!id || !exp || !sig) return null;
  const expected = hmac(`${id}.${exp}`);
  if (sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const identityId = parseInt(id, 10);
  const expNum = parseInt(exp, 10);
  if (!Number.isFinite(identityId) || !Number.isFinite(expNum)) return null;
  if (expNum < Math.floor(Date.now() / 1000)) return null;
  return identityId;
}

function setPhotoAccessCookie(res, identityId) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE_NAME}=${signPhotoAccess(identityId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}${secure}`);
}

function clearPhotoAccessCookie(res) {
  res.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

module.exports = {
  COOKIE_NAME,
  clearPhotoAccessCookie,
  readPhotoAccess,
  setPhotoAccessCookie,
  signPhotoAccess
};
