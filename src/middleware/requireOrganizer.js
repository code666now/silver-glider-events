const pool = require('../config/db');
const {
  parseSession, readSessionCookie, setSessionCookie, clearSessionCookie, MAX_AGE_SECONDS
} = require('../lib/session');

function reject(req, res) {
  if (req.path.startsWith('/api/') || req.baseUrl.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not signed in' });
  }
  return res.redirect('/login');
}

async function requireOrganizer(req, res, next) {
  const session = parseSession(readSessionCookie(req));
  if (!session) return reject(req, res);

  try {
    const { rows } = await pool.query('SELECT * FROM organizers WHERE id=$1', [session.id]);
    if (!rows.length) {
      // Cookie is validly signed but the organizer no longer exists — clear it so
      // /login doesn't bounce back to /dashboard in a loop.
      clearSessionCookie(res);
      return reject(req, res);
    }

    // Sliding refresh: once past the halfway mark, re-issue a fresh 30-day cookie
    // so active users never get bounced back to the magic-link screen.
    const remaining = session.exp - Math.floor(Date.now() / 1000);
    if (remaining < MAX_AGE_SECONDS / 2) setSessionCookie(res, session.id);

    req.organizer = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = requireOrganizer;
