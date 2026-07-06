const express = require('express');
const crypto = require('crypto');
const pool = require('../config/db');
const requireOrganizer = require('../middleware/requireOrganizer');
const { makePublicSlug, makePrivateSlug } = require('../lib/slug');
const { rsvpsToCsv } = require('../lib/csv');

const router = express.Router();
router.use(requireOrganizer);

const CATEGORIES = ['Music', 'Art', 'Market', 'Party', 'Community', 'Food & Drink', 'Film', 'Other'];

function validateEventBody(body, { partial = false } = {}) {
  const errors = [];
  const out = {};
  const fields = {
    title:           v => String(v).trim().slice(0, 140),
    description:     v => String(v ?? '').trim(),
    cover_image_url: v => String(v ?? '').trim() || null,
    event_date:      v => String(v).trim(),
    start_time:      v => String(v).trim(),
    end_time:        v => (v ? String(v).trim() : null),
    venue_name:      v => String(v).trim().slice(0, 140),
    venue_address:   v => String(v ?? '').trim() || null,
    category:        v => (CATEGORIES.includes(v) ? v : null),
    capacity:        v => (v === '' || v == null ? null : Math.max(1, parseInt(v, 10) || 0) || null),
    visibility:      v => (v === 'private' ? 'private' : 'public'),
    status:          v => (['draft', 'published', 'cancelled'].includes(v) ? v : undefined)
  };
  for (const [key, clean] of Object.entries(fields)) {
    if (body[key] === undefined) continue;
    out[key] = clean(body[key]);
  }
  if (!partial) {
    if (!out.title) errors.push('Title is required');
    if (!out.event_date || !/^\d{4}-\d{2}-\d{2}$/.test(out.event_date)) errors.push('Date is required');
    if (!out.start_time || !/^\d{2}:\d{2}/.test(out.start_time)) errors.push('Start time is required');
    if (!out.venue_name) errors.push('Venue name is required');
  } else {
    if (out.event_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(out.event_date || '')) errors.push('Invalid date');
    if (out.start_time !== undefined && !/^\d{2}:\d{2}/.test(out.start_time || '')) errors.push('Invalid start time');
  }
  if (out.status !== undefined && out.status === undefined) delete out.status;
  return { out, errors };
}

// GET /api/events — mine, with confirmed RSVP counts
router.get('/api/events', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.*,
              COALESCE(r.cnt, 0)::int AS rsvp_count
         FROM events e
         LEFT JOIN (
           SELECT event_id, COUNT(*) AS cnt FROM rsvps WHERE status='confirmed' GROUP BY event_id
         ) r ON r.event_id = e.id
        WHERE e.organizer_id=$1
        ORDER BY e.event_date DESC, e.id DESC`,
      [req.organizer.id]
    );
    res.json({ events: rows });
  } catch (err) { next(err); }
});

// POST /api/events — create
router.post('/api/events', async (req, res, next) => {
  try {
    const { out, errors } = validateEventBody(req.body);
    if (errors.length) return res.status(400).json({ error: errors[0] });

    for (let attempt = 0; attempt < 3; attempt++) {
      const slug = out.visibility === 'private' ? makePrivateSlug() : makePublicSlug(out.title);
      try {
        const { rows } = await pool.query(
          `INSERT INTO events (organizer_id, slug, title, description, cover_image_url, event_date,
                               start_time, end_time, venue_name, venue_address, category, capacity, visibility)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING *`,
          [req.organizer.id, slug, out.title, out.description || null, out.cover_image_url,
           out.event_date, out.start_time, out.end_time, out.venue_name, out.venue_address,
           out.category, out.capacity, out.visibility || 'public']
        );
        return res.status(201).json({ event: rows[0] });
      } catch (err) {
        if (err.code === '23505' && attempt < 2) continue; // slug collision — retry
        throw err;
      }
    }
  } catch (err) { next(err); }
});

// GET /api/events/:id
router.get('/api/events/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.*, COALESCE((SELECT COUNT(*) FROM rsvps WHERE event_id=e.id AND status='confirmed'), 0)::int AS rsvp_count
         FROM events e WHERE e.id=$1 AND e.organizer_id=$2`,
      [req.params.id, req.organizer.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Event not found' });
    res.json({ event: rows[0] });
  } catch (err) { next(err); }
});

// PUT /api/events/:id — update (slug immutable)
router.put('/api/events/:id', async (req, res, next) => {
  try {
    const { out, errors } = validateEventBody(req.body, { partial: true });
    if (errors.length) return res.status(400).json({ error: errors[0] });
    delete out.status; // status changes go through /cancel

    const keys = Object.keys(out);
    if (!keys.length) return res.status(400).json({ error: 'Nothing to update' });

    const sets = keys.map((k, i) => `${k}=$${i + 3}`).join(', ');
    const { rows } = await pool.query(
      `UPDATE events SET ${sets}, updated_at=NOW() WHERE id=$1 AND organizer_id=$2 RETURNING *`,
      [req.params.id, req.organizer.id, ...keys.map(k => out[k])]
    );
    if (!rows.length) return res.status(404).json({ error: 'Event not found' });
    res.json({ event: rows[0] });
  } catch (err) { next(err); }
});

// POST /api/events/:id/duplicate
// PRO GATE: when billing exists, require req.organizer.plan === 'pro' here.
router.post('/api/events/:id/duplicate', async (req, res, next) => {
  try {
    const { rows: src } = await pool.query(
      'SELECT * FROM events WHERE id=$1 AND organizer_id=$2', [req.params.id, req.organizer.id]
    );
    if (!src.length) return res.status(404).json({ error: 'Event not found' });
    const e = src[0];

    for (let attempt = 0; attempt < 3; attempt++) {
      const slug = e.visibility === 'private' ? makePrivateSlug() : makePublicSlug(e.title);
      try {
        const { rows } = await pool.query(
          `INSERT INTO events (organizer_id, slug, title, description, cover_image_url, event_date,
                               start_time, end_time, timezone, venue_name, venue_address, category,
                               capacity, visibility, status, duplicated_from_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft',$15)
           RETURNING *`,
          [req.organizer.id, slug, e.title, e.description, e.cover_image_url, e.event_date,
           e.start_time, e.end_time, e.timezone, e.venue_name, e.venue_address, e.category,
           e.capacity, e.visibility, e.id]
        );
        return res.status(201).json({ event: rows[0] });
      } catch (err) {
        if (err.code === '23505' && attempt < 2) continue;
        throw err;
      }
    }
  } catch (err) { next(err); }
});

// POST /api/events/:id/cancel
router.post('/api/events/:id/cancel', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE events SET status='cancelled', updated_at=NOW()
        WHERE id=$1 AND organizer_id=$2 RETURNING *`,
      [req.params.id, req.organizer.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Event not found' });
    res.json({ event: rows[0] });
  } catch (err) { next(err); }
});

// GET /api/events/:id/rsvps?search=
router.get('/api/events/:id/rsvps', async (req, res, next) => {
  try {
    const owned = await pool.query('SELECT 1 FROM events WHERE id=$1 AND organizer_id=$2', [req.params.id, req.organizer.id]);
    if (!owned.rows.length) return res.status(404).json({ error: 'Event not found' });

    const search = String(req.query.search || '').trim();
    const params = [req.params.id];
    let where = `event_id=$1`;
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (first_name ILIKE $2 OR last_name ILIKE $2 OR email ILIKE $2)`;
    }
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, email, phone, wants_reminders, organizer_optin, status, created_at
         FROM rsvps WHERE ${where} ORDER BY created_at DESC`,
      params
    );
    res.json({ rsvps: rows });
  } catch (err) { next(err); }
});

// GET /api/events/:id/rsvps.csv
router.get('/api/events/:id/rsvps.csv', async (req, res, next) => {
  try {
    const { rows: ev } = await pool.query('SELECT slug FROM events WHERE id=$1 AND organizer_id=$2', [req.params.id, req.organizer.id]);
    if (!ev.length) return res.status(404).json({ error: 'Event not found' });

    const { rows } = await pool.query(
      `SELECT first_name, last_name, email, phone, wants_reminders, organizer_optin, status, created_at
         FROM rsvps WHERE event_id=$1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${ev[0].slug}-guests.csv"`);
    res.send(rsvpsToCsv(rows));
  } catch (err) { next(err); }
});

// POST /api/events/:id/submit-to-line
router.post('/api/events/:id/submit-to-line', async (req, res, next) => {
  try {
    const { rows: ev } = await pool.query('SELECT id FROM events WHERE id=$1 AND organizer_id=$2', [req.params.id, req.organizer.id]);
    if (!ev.length) return res.status(404).json({ error: 'Event not found' });

    await pool.query(
      `INSERT INTO line_submissions (event_id, organizer_id) VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING`,
      [req.params.id, req.organizer.id]
    );
    const { rows } = await pool.query('SELECT status, created_at, reviewed_at FROM line_submissions WHERE event_id=$1', [req.params.id]);
    res.json({ submission: rows[0] });
  } catch (err) { next(err); }
});

// GET /api/events/:id/line-status
router.get('/api/events/:id/line-status', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ls.status, ls.created_at, ls.reviewed_at
         FROM line_submissions ls JOIN events e ON e.id=ls.event_id
        WHERE ls.event_id=$1 AND e.organizer_id=$2`,
      [req.params.id, req.organizer.id]
    );
    res.json({ submission: rows[0] || null });
  } catch (err) { next(err); }
});

// PUT /api/settings
router.put('/api/settings', async (req, res, next) => {
  try {
    const name = String(req.body.name ?? '').trim().slice(0, 100) || null;
    const orgName = String(req.body.org_name ?? '').trim().slice(0, 100) || null;
    const { rows } = await pool.query(
      'UPDATE organizers SET name=$2, org_name=$3 WHERE id=$1 RETURNING id, email, name, org_name, plan, is_admin',
      [req.organizer.id, name, orgName]
    );
    res.json({ organizer: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
