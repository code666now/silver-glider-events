const express = require('express');
const pool = require('../config/db');
const requireOrganizer = require('../middleware/requireOrganizer');

const router = express.Router();

router.get('/api/host-onboarding', requireOrganizer, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT host.org_name,host.public_slug,host.logo_url,host.bio,
              host.instagram_handle,host.website_url,
              host.host_page_created_at,host.host_page_success_seen_at,
              EXISTS (
                SELECT 1 FROM events event WHERE event.organizer_id=host.id
              ) AS has_event
         FROM organizers host
        WHERE host.id=$1`,
      [req.organizer.id]
    );
    const host = rows[0];
    if (!host) return res.status(404).json({ error: 'Account not found' });
    const profileComplete = Boolean(
      String(host.logo_url || '').trim()
      && String(host.bio || '').trim()
      && (String(host.instagram_handle || '').trim() || String(host.website_url || '').trim())
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      showHostPageSuccess: Boolean(
        host.public_slug
        && host.host_page_created_at
        && !host.host_page_success_seen_at
      ),
      hostPageUrl: host.public_slug ? `/h/${encodeURIComponent(host.public_slug)}` : null,
      hostName: host.org_name || null,
      profileComplete,
      hasEvent: Boolean(host.has_event)
    });
  } catch (error) { next(error); }
});

router.post('/api/host-onboarding/seen', requireOrganizer, async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE organizers
          SET host_page_success_seen_at=COALESCE(host_page_success_seen_at,NOW())
        WHERE id=$1 AND host_page_created_at IS NOT NULL`,
      [req.organizer.id]
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true });
  } catch (error) { next(error); }
});

module.exports = router;
