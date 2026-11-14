const pool = require('../config/db');

// While Silver Glider has hidden an event, its organizer can still view it
// but can't change, republish, duplicate, cancel, delete or message from it.
// Only a Super Admin can unhide it. Reads pass straight through.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

module.exports = async function blockHiddenEventChanges(req, res, next) {
  if (READ_METHODS.has(req.method)) return next();
  const id = Number(req.params.eventRef);
  if (!Number.isSafeInteger(id) || id <= 0) return next();
  try {
    const { rows } = await pool.query("SELECT 1 FROM events WHERE id=$1 AND status='hidden'", [id]);
    if (!rows.length) return next();
    return res.status(409).json({
      error: 'event_hidden',
      message: 'Silver Glider has hidden this event, so it can’t be changed right now. Questions? Email support@silverglidertickets.com.'
    });
  } catch (error) {
    return next(error);
  }
};
