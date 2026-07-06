const pool = require('../config/db');
const { verifySession, readSessionCookie } = require('../lib/session');

async function requireOrganizer(req, res, next) {
  const organizerId = verifySession(readSessionCookie(req));
  if (!organizerId) {
    if (req.path.startsWith('/api/') || req.baseUrl.startsWith('/api/')) {
      return res.status(401).json({ error: 'Not signed in' });
    }
    return res.redirect('/login');
  }
  try {
    const { rows } = await pool.query('SELECT * FROM organizers WHERE id=$1', [organizerId]);
    if (!rows.length) return res.status(401).json({ error: 'Not signed in' });
    req.organizer = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = requireOrganizer;
