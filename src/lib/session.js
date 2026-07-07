const crypto = require('crypto');

const SESSION_SECRET = (process.env.SESSION_SECRET || '').trim();
if (!SESSION_SECRET) throw new Error('SESSION_SECRET is required');

const COOKIE_NAME = 'sge_session';
const MAX_AGE_SECONDS = 30 * 24 * 3600;

function hmac(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
}

function signSession(organizerId) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS;
  const payload = `${organizerId}.${exp}`;
  return `${payload}.${hmac(payload)}`;
}

// Returns { id, exp } for a valid, unexpired session, else null.
function parseSession(cookieVal) {
  if (!cookieVal) return null;
  const parts = cookieVal.split('.');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  const payload = `${id}.${exp}`;
  const expected = hmac(payload);
  if (sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const expNum = parseInt(exp, 10);
  const idNum = parseInt(id, 10);
  if (!Number.isFinite(expNum) || !Number.isFinite(idNum)) return null;
  if (expNum < Math.floor(Date.now() / 1000)) return null; // expired
  return { id: idNum, exp: expNum };
}

function verifySession(cookieVal) {
  const s = parseSession(cookieVal);
  return s ? s.id : null;
}

function readSessionCookie(req) {
  const header = req.headers.cookie || '';
  const part = header.split(';').map(c => c.trim()).find(c => c.startsWith(COOKIE_NAME + '='));
  return part ? decodeURIComponent(part.split('=').slice(1).join('=')) : null;
}

function setSessionCookie(res, organizerId) {
  const isProd = process.env.NODE_ENV === 'production';
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${signSession(organizerId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}${isProd ? '; Secure' : ''}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

module.exports = {
  signSession, verifySession, parseSession,
  readSessionCookie, setSessionCookie, clearSessionCookie,
  MAX_AGE_SECONDS
};
