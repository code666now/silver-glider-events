const crypto = require('crypto');

const SESSION_SECRET = (process.env.SESSION_SECRET || '').trim();
if (!SESSION_SECRET) throw new Error('SESSION_SECRET is required');

const COOKIE_NAME = 'sge_session';
const MAX_AGE_SECONDS = 30 * 24 * 3600;

function hmac(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
}

// The issue time (milliseconds) lets the server reject every cookie issued
// before organizers.sessions_valid_after — what "Sign out of all devices" sets.
function signSession(organizerId, issuedAt = Date.now()) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS;
  const payload = `${organizerId}.${Math.floor(issuedAt)}.${exp}`;
  return `${payload}.${hmac(payload)}`;
}

// Returns { id, iat, exp } for a validly signed, unexpired cookie, else null.
// Cookies issued before v1.0.85 carry no issue time (`id.exp.sig`); they are
// treated as issued one full lifetime before they expire.
function parseSession(cookieVal) {
  if (!cookieVal) return null;
  const parts = cookieVal.split('.');
  if (parts.length !== 3 && parts.length !== 4) return null;
  const sig = parts[parts.length - 1];
  const payload = parts.slice(0, -1).join('.');
  const expected = hmac(payload);
  if (sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const idNum = parseInt(parts[0], 10);
  const expNum = parseInt(parts[parts.length - 2], 10);
  if (!Number.isFinite(expNum) || !Number.isFinite(idNum)) return null;
  if (expNum < Math.floor(Date.now() / 1000)) return null; // expired
  const iatNum = parts.length === 4 ? parseInt(parts[1], 10) : (expNum - MAX_AGE_SECONDS) * 1000;
  if (!Number.isFinite(iatNum)) return null;
  return { id: idNum, iat: iatNum, exp: expNum };
}

function readSessionCookie(req) {
  const header = req.headers.cookie || '';
  const part = header.split(';').map(c => c.trim()).find(c => c.startsWith(COOKIE_NAME + '='));
  return part ? decodeURIComponent(part.split('=').slice(1).join('=')) : null;
}

// Appended rather than set, so one response can carry the account session
// alongside guest, sign-in-request, or attendee cookies.
function setSessionCookie(res, organizerId) {
  const isProd = process.env.NODE_ENV === 'production';
  res.append('Set-Cookie',
    `${COOKIE_NAME}=${signSession(organizerId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}${isProd ? '; Secure' : ''}`);
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function sessionRevoked(session, account) {
  if (!account?.sessions_valid_after) return false;
  return session.iat < new Date(account.sessions_valid_after).getTime();
}

// Resolves the signed-in account: a valid signature, an organizer that still
// exists, and a cookie issued after any "sign out everywhere". `stale` means a
// cookie was presented but must no longer be honored.
async function loadSessionAccount(db, req) {
  const cookie = readSessionCookie(req);
  const session = parseSession(cookie);
  if (!session) return { session: null, account: null, stale: Boolean(cookie) };
  const { rows } = await db.query('SELECT * FROM organizers WHERE id=$1', [session.id]);
  const account = rows[0] || null;
  if (!account || sessionRevoked(session, account)) return { session: null, account: null, stale: true };
  return { session, account, stale: false };
}

// Runs once per request so routes can make synchronous ownership checks
// (`req.sessionAccount`) that still respect server-side revocation. Requests
// without a session cookie cost nothing.
function sessionMiddleware(db) {
  return async (req, res, next) => {
    req.sessionAccount = null;
    req.sessionInfo = null;
    req.sessionStale = false;
    if (!readSessionCookie(req)) return next();
    try {
      const result = await loadSessionAccount(db, req);
      req.sessionAccount = result.account;
      req.sessionInfo = result.session;
      req.sessionStale = result.stale;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  signSession, parseSession,
  readSessionCookie, setSessionCookie, clearSessionCookie,
  loadSessionAccount, sessionMiddleware, sessionRevoked,
  COOKIE_NAME, MAX_AGE_SECONDS
};
