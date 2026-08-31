const express = require('express');
const crypto = require('crypto');
const pool = require('../config/db');
const requireAdmin = require('../middleware/requireAdmin');
const { ensureHostProfile, normalizeHostProfile } = require('../lib/host-profile');

const router = express.Router();
router.use('/api/admin', requireAdmin);

function positiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function slugify(value) {
  return String(value || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 70) || 'host';
}

const invitationSelect = `
  SELECT i.id, i.token, i.host_name, i.personal_note,
         i.created_by_organizer_id, i.joined_organizer_id,
         i.created_at, i.updated_at, i.joined_at, i.revoked_at,
         o.email AS joined_email, o.name AS joined_name, o.org_name AS joined_org_name
    FROM host_invitations i
    LEFT JOIN organizers o ON o.id=i.joined_organizer_id`;

const hostAccountSelect = `
  WITH account_stats AS (
    SELECT e.organizer_id,
           COUNT(DISTINCT e.id)::int AS event_count,
           COUNT(r.id) FILTER (WHERE r.status='confirmed')::int AS rsvp_count
      FROM events e
      LEFT JOIN rsvps r ON r.event_id=e.id
     GROUP BY e.organizer_id
  ), latest_invitation AS (
    SELECT DISTINCT ON (joined_organizer_id)
           joined_organizer_id, id AS invitation_id, token AS invitation_token,
           host_name AS invitation_host_name, joined_at AS invitation_joined_at,
           revoked_at AS invitation_revoked_at
      FROM host_invitations
     WHERE joined_organizer_id IS NOT NULL
     ORDER BY joined_organizer_id, joined_at DESC NULLS LAST, id DESC
  )
  SELECT o.id, o.email, o.name, o.org_name, o.public_slug, o.logo_url,
         o.header_image_url, o.bio, o.website_url, o.instagram_handle, o.instagram_url,
         o.contact_email, o.updated_at,
         o.plan, o.is_admin, o.created_at, o.last_login_at,
         COALESCE(s.event_count,0)::int AS event_count,
         COALESCE(s.rsvp_count,0)::int AS rsvp_count,
         i.invitation_id, i.invitation_token, i.invitation_host_name,
         i.invitation_joined_at, i.invitation_revoked_at
    FROM organizers o
    LEFT JOIN account_stats s ON s.organizer_id=o.id
    LEFT JOIN latest_invitation i ON i.joined_organizer_id=o.id`;

// GET /api/admin/hosts — read-only account overview for early MVP tracking
router.get('/api/admin/hosts', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`${hostAccountSelect} ORDER BY o.created_at DESC, o.id DESC`);
    res.json({ hosts: rows });
  } catch (err) { next(err); }
});

// GET /api/admin/hosts/:id — account details and owned events, still read-only
router.get('/api/admin/hosts/:id', async (req, res, next) => {
  try {
    const id = positiveId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Host account not found' });
    const { rows } = await pool.query(`${hostAccountSelect} WHERE o.id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Host account not found' });
    const events = await pool.query(
      `SELECT e.id, e.title, e.slug, e.event_date, e.start_time, e.status,
              e.visibility, e.archived_at, e.venue_name,
              e.collect_photos_enabled,
              e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE e.timezone)::date AS is_past,
              COALESCE((SELECT COUNT(*) FROM event_photos ep WHERE ep.event_id=e.id),0)::int AS photo_count,
              COUNT(r.id) FILTER (WHERE r.status='confirmed')::int AS rsvp_count
         FROM events e
         LEFT JOIN rsvps r ON r.event_id=e.id
        WHERE e.organizer_id=$1
        GROUP BY e.id
        ORDER BY e.event_date DESC, e.id DESC
        LIMIT 100`,
      [id]
    );
    res.json({ host: rows[0], events: events.rows });
  } catch (err) { next(err); }
});

// PATCH /api/admin/events/:id/collect-photos — isolated event-level beta flag.
router.patch('/api/admin/events/:id/collect-photos', async (req, res, next) => {
  try {
    const id = positiveId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Event not found' });
    if (typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'Choose whether photo collection is on or off' });

    const { rows: current } = await pool.query(
      `SELECT id, event_date < (CURRENT_TIMESTAMP AT TIME ZONE timezone)::date AS is_past, status
         FROM events WHERE id=$1`,
      [id]
    );
    if (!current.length) return res.status(404).json({ error: 'Event not found' });
    if (req.body.enabled && (!current[0].is_past || current[0].status !== 'published')) {
      return res.status(400).json({ error: 'Collect Photos can only be enabled for published past events' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    const shortToken = crypto.randomBytes(16).toString('base64url');
    const { rows } = await pool.query(
      `UPDATE events
          SET collect_photos_enabled=$2,
              photo_upload_token=CASE WHEN $2 THEN COALESCE(photo_upload_token,$3) ELSE photo_upload_token END,
              photo_short_token=CASE WHEN $2 THEN COALESCE(photo_short_token,$4) ELSE photo_short_token END,
              updated_at=NOW()
        WHERE id=$1
      RETURNING id, collect_photos_enabled, photo_upload_token, photo_short_token`,
      [id, req.body.enabled, token, shortToken]
    );
    res.json({ event: rows[0] });
  } catch (err) { next(err); }
});

// PUT /api/admin/hosts/:id/profile — targeted public-profile editing only.
router.put('/api/admin/hosts/:id/profile', async (req, res, next) => {
  try {
    const id = positiveId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Host account not found' });
    const { rows: currentRows } = await pool.query('SELECT * FROM organizers WHERE id=$1', [id]);
    const current = currentRows[0];
    if (!current) return res.status(404).json({ error: 'Host account not found' });

    const normalized = normalizeHostProfile(req.body || {}, current);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    const profile = normalized.value;
    let publicSlug = profile.publicSlug;
    if (profile.orgName && !publicSlug) {
      const ensured = await ensureHostProfile(id, profile.orgName);
      publicSlug = ensured.public_slug;
    }

    const { rows } = await pool.query(
      `UPDATE organizers
          SET org_name=$2, public_slug=$3, bio=$4, website_url=$5,
              instagram_handle=$6, contact_email=$7, updated_at=NOW()
        WHERE id=$1
        RETURNING id, email, name, org_name, public_slug, logo_url, header_image_url,
                  bio, website_url, instagram_handle, instagram_url, contact_email,
                  plan, is_admin, created_at, updated_at`,
      [
        id, profile.orgName, publicSlug, profile.bio,
        profile.websiteUrl, profile.instagramHandle, profile.contactEmail
      ]
    );
    res.json({ host: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That host page slug is already taken' });
    next(err);
  }
});

// GET /api/admin/invitations
router.get('/api/admin/invitations', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`${invitationSelect} ORDER BY i.created_at DESC`);
    res.json({ invitations: rows.map(row => ({ ...row, path: `/i/${row.token}` })) });
  } catch (err) { next(err); }
});

// POST /api/admin/invitations
router.post('/api/admin/invitations', async (req, res, next) => {
  try {
    const body = req.body || {};
    const hostName = String(body.host_name || '').trim();
    const personalNote = String(body.personal_note || '').trim();
    if (hostName.length < 2 || hostName.length > 160) {
      return res.status(400).json({ error: 'Enter a host name between 2 and 160 characters' });
    }
    if (personalNote.length < 8 || personalNote.length > 500) {
      return res.status(400).json({ error: 'Enter a personal reason between 8 and 500 characters' });
    }

    const token = `${slugify(hostName)}-${crypto.randomBytes(8).toString('hex')}`;
    const { rows } = await pool.query(
      `INSERT INTO host_invitations
         (token, host_name, personal_note, created_by_organizer_id)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [token, hostName, personalNote, req.organizer.id]
    );
    res.status(201).json({ invitation: { ...rows[0], path: `/i/${token}` } });
  } catch (err) { next(err); }
});

// PATCH /api/admin/invitations/:id — revoke or restore a private link
router.patch('/api/admin/invitations/:id', async (req, res, next) => {
  try {
    const id = positiveId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Invitation not found' });
    const body = req.body || {};
    if (typeof body.revoked !== 'boolean') {
      return res.status(400).json({ error: 'Choose whether to revoke or restore this invitation' });
    }
    const { rows } = await pool.query(
      `UPDATE host_invitations
          SET revoked_at=CASE WHEN $2::boolean THEN COALESCE(revoked_at,NOW()) ELSE NULL END,
              updated_at=NOW()
        WHERE id=$1
        RETURNING *`,
      [id, body.revoked]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invitation not found' });
    res.json({ invitation: { ...rows[0], path: `/i/${rows[0].token}` } });
  } catch (err) { next(err); }
});

// GET /api/admin/line-submissions?status=pending
router.get('/api/admin/line-submissions', async (req, res, next) => {
  try {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
    const params = [];
    const conditions = ["e.visibility='public'", "e.status='published'"];
    if (status) {
      params.push(status);
      conditions.push(`ls.status=$${params.length}`);
    }
    const { rows } = await pool.query(
      `SELECT ls.id, ls.status, ls.created_at, ls.reviewed_at,
              e.title, e.event_date, e.venue_name, e.slug, e.visibility,
              o.email AS organizer_email, o.org_name, o.name AS organizer_name
         FROM line_submissions ls
         JOIN events e ON e.id = ls.event_id
         JOIN organizers o ON o.id = ls.organizer_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY ls.created_at ASC`,
      params
    );
    res.json({ submissions: rows });
  } catch (err) { next(err); }
});

async function review(req, res, next, status) {
  try {
    const { rows } = await pool.query(
      `UPDATE line_submissions ls
          SET status=$2, reviewed_at=NOW()
         FROM events e
        WHERE ls.id=$1
          AND e.id=ls.event_id
          AND e.visibility='public'
          AND e.status='published'
        RETURNING ls.*`,
      [req.params.id, status]
    );
    if (!rows.length) return res.status(404).json({ error: 'Submission not found' });
    res.json({ submission: rows[0] });
  } catch (err) { next(err); }
}

router.post('/api/admin/line-submissions/:id/approve', (req, res, next) => review(req, res, next, 'approved'));
router.post('/api/admin/line-submissions/:id/reject', (req, res, next) => review(req, res, next, 'rejected'));

module.exports = router;
