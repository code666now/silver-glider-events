const pool = require('../config/db');
const requireOrganizer = require('./requireOrganizer');
const { readPhotoAccess } = require('../lib/photo-access');

// For the avatar page and avatar upload only. A full account session passes
// straight through requireOrganizer; otherwise the short-lived photo grant
// from an RSVP confirmation's "Add your photo" link is accepted, and
// `req.photoAccessOnly` tells the handler the visitor has no account session.
async function requirePhotoAccess(req, res, next) {
  try {
    const resolved = await requireOrganizer.resolveSession(req);
    if (!resolved.account) {
      const identityId = readPhotoAccess(req);
      if (identityId) {
        const { rows } = await pool.query('SELECT * FROM organizers WHERE id=$1', [identityId]);
        if (rows[0]) {
          req.organizer = rows[0];
          req.photoAccessOnly = true;
          return next();
        }
      }
    }
    return requireOrganizer(req, res, next);
  } catch (err) {
    next(err);
  }
}

module.exports = requirePhotoAccess;
