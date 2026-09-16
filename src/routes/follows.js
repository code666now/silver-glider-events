const express = require('express');
const pool = require('../config/db');
const requireOrganizer = require('../middleware/requireOrganizer');
const {
  findPublicHost, followHost, unfollowHost, followStatus, enableFollowSms
} = require('../lib/host-follows');

const router = express.Router();

async function inFollowTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

router.post('/api/hosts/:slug/follow', requireOrganizer, async (req, res, next) => {
  try {
    const result = await inFollowTransaction(async client => {
      const host = await findPublicHost(client, req.params.slug);
      if (!host) return null;
      await followHost(client, req.organizer.id, host.id);
      return followStatus(client, req.organizer.id, host.id);
    });
    if (!result) return res.status(404).json({ error: 'Host Page not found' });
    res.json(result);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

router.delete('/api/hosts/:slug/follow', requireOrganizer, async (req, res, next) => {
  try {
    const result = await inFollowTransaction(async client => {
      const host = await findPublicHost(client, req.params.slug);
      if (!host) return null;
      await unfollowHost(client, req.organizer.id, host.id);
      return followStatus(client, req.organizer.id, host.id);
    });
    if (!result) return res.status(404).json({ error: 'Host Page not found' });
    res.json(result);
  } catch (err) { next(err); }
});

router.patch('/api/hosts/:slug/follow/texts', requireOrganizer, async (req, res, next) => {
  try {
    const result = await inFollowTransaction(async client => {
      const host = await findPublicHost(client, req.params.slug);
      if (!host) return null;
      await enableFollowSms(client, req.organizer.id, host.id, req.body?.phone);
      return followStatus(client, req.organizer.id, host.id);
    });
    if (!result) return res.status(404).json({ error: 'Host Page not found' });
    res.json(result);
  } catch (err) {
    if (err.statusCode || err.status) return res.status(err.statusCode || err.status).json({ error: err.message });
    next(err);
  }
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
