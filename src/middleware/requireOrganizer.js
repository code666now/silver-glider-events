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
