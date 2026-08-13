const express = require('express');
const pool = require('../config/db');
const requireOrganizer = require('../middleware/requireOrganizer');
const { findPublicHost, followHost, unfollowHost } = require('../lib/host-follows');

const router = express.Router();

router.post('/api/hosts/:slug/follow', requireOrganizer, async (req, res, next) => {
  try {
    const host = await findPublicHost(pool, req.params.slug);
    if (!host) return res.status(404).json({ error: 'Host Page not found' });
    await followHost(pool, req.organizer.id, host.id);
    res.json({ following: true });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

router.delete('/api/hosts/:slug/follow', requireOrganizer, async (req, res, next) => {
  try {
    const host = await findPublicHost(pool, req.params.slug);
    if (!host) return res.status(404).json({ error: 'Host Page not found' });
    await unfollowHost(pool, req.organizer.id, host.id);
    res.json({ following: false });
  } catch (err) { next(err); }
});

router.get('/api/following', requireOrganizer, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.org_name, o.public_slug, o.logo_url, o.header_image_url,
              COUNT(e.id)::int AS upcoming_count
         FROM host_follows hf
         JOIN organizers o ON o.id=hf.host_organizer_id
         LEFT JOIN events e ON e.organizer_id=o.id
          AND e.status='published' AND e.visibility='public'
          AND e.event_date >= CURRENT_DATE
        WHERE hf.follower_organizer_id=$1
          AND hf.unsubscribed_at IS NULL
          AND o.org_name IS NOT NULL AND o.public_slug IS NOT NULL
        GROUP BY hf.id, o.id
        ORDER BY hf.created_at DESC, LOWER(o.org_name) ASC`,
      [req.organizer.id]
    );
    res.json({ hosts: rows });
  } catch (err) { next(err); }
});

module.exports = router;
