const pool = require('../config/db');
const {
  loadSessionAccount, setSessionCookie, clearSessionCookie, MAX_AGE_SECONDS
} = require('../lib/session');

function reject(req, res) {
  if (req.path.startsWith('/api/') || req.baseUrl.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not signed in' });
  }
  return res.redirect('/login');
}

function sameOriginMutation(req) {
  const site = req.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.get('origin');
  if (!origin || origin === 'null') return true;

  let parsedOrigin;
  try { parsedOrigin = new URL(origin).origin; } catch (_) { return false; }
  const allowed = new Set();
  const host = req.get('host');
  if (host) allowed.add(`${req.protocol}://${host}`);
  try { allowed.add(new URL(process.env.APP_URL).origin); } catch (_) {}
  return allowed.has(parsedOrigin);
}

function rejectCrossOriginMutation(req, res) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || sameOriginMutation(req)) {
    return false;
  }
  if (req.path.startsWith('/api/') || req.baseUrl.startsWith('/api/')) {
    res.status(403).json({ error: 'forbidden' });
  } else {
    res.status(403).type('text').send('Forbidden');
  }
  return true;
}

// sessionMiddleware normally resolved the account already; fall back for any
// router mounted outside it.
async function resolveSession(req) {
  if (Object.prototype.hasOwnProperty.call(req, 'sessionAccount')) {
    return { account: req.sessionAccount, session: req.sessionInfo, stale: req.sessionStale };
  }
  return loadSessionAccount(pool, req);
}

async function requireOrganizer(req, res, next) {
  try {
    const resolved = await resolveSession(req);
    if (!resolved.account) {
      // A validly signed cookie for a deleted or signed-out-everywhere account is
      // cleared so /login doesn't bounce back to /dashboard in a loop.
      if (resolved.stale) clearSessionCookie(res);
      return reject(req, res);
    }
    if (rejectCrossOriginMutation(req, res)) return;

    // Sliding refresh: once past the halfway mark, re-issue a fresh 30-day cookie
    // so active users never get bounced back to the magic-link screen.
    const remaining = resolved.session.exp - Math.floor(Date.now() / 1000);
    if (remaining < MAX_AGE_SECONDS / 2) setSessionCookie(res, resolved.account.id);

    req.organizer = resolved.account;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = requireOrganizer;
module.exports.resolveSession = resolveSession;
module.exports.sameOriginMutation = sameOriginMutation;
