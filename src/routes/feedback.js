const express = require('express');
const pool = require('../config/db');
const requireOrganizer = require('../middleware/requireOrganizer');
const requireAdmin = require('../middleware/requireAdmin');

const router = express.Router();
const TYPES = ['bug', 'suggestion', 'other'];
const STATUSES = ['new', 'reviewing', 'resolved'];

function positiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function cleanRoute(value) {
  const route = String(value || '').trim();
  return route.startsWith('/') && !route.startsWith('//') ? route.slice(0, 500) : '/';
}

function cleanPageUrl(value, route, req) {
  const fallback = `${req.protocol}://${req.get('host')}${route}`;
  try {
    const url = new URL(String(value || ''), fallback);
    if (!['http:', 'https:'].includes(url.protocol)) return fallback;
    const requestOrigin = new URL(fallback).origin;
    const appOrigin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : requestOrigin;
    if (![requestOrigin, appOrigin].includes(url.origin)) return fallback;
    return url.toString().slice(0, 2000);
  } catch (_) {
    return fallback;
  }
}

const feedbackSelect = `
  SELECT f.id, f.type, f.message, f.status,
         f.submitted_by_organizer_id, f.organizer_id, f.user_name, f.user_email,
         f.page_url, f.route, f.event_id, f.user_agent, f.created_at, f.updated_at,
         o.name AS current_user_name, o.org_name, o.email AS current_email, o.public_slug,
         e.title AS event_title, e.slug AS event_slug
    FROM feedback_submissions f
    LEFT JOIN organizers o ON o.id=f.organizer_id
    LEFT JOIN events e ON e.id=f.event_id`;

router.post('/api/feedback', requireOrganizer, async (req, res, next) => {
  try {
    const type = TYPES.includes(req.body.type) ? req.body.type : null;
    const message = String(req.body.message || '').trim().slice(0, 4000);
    if (!type) return res.status(400).json({ error: 'Choose a feedback type' });
    if (!message) return res.status(400).json({ error: 'Enter your feedback' });

    let eventId = null;
    if (req.body.event_id !== '' && req.body.event_id != null) {
      const requestedEventId = Number(req.body.event_id);
      if (!Number.isInteger(requestedEventId) || requestedEventId <= 0) {
        return res.status(400).json({ error: 'Invalid event' });
      }
      const event = await pool.query(
        'SELECT id FROM events WHERE id=$1 AND organizer_id=$2',
        [requestedEventId, req.organizer.id]
      );
      if (!event.rows.length) return res.status(400).json({ error: 'Event not found' });
      eventId = requestedEventId;
    }

    const route = cleanRoute(req.body.route);
    const pageUrl = cleanPageUrl(req.body.page_url, route, req);
    const userName = req.organizer.name || req.organizer.org_name || null;
    const userAgent = String(req.get('user-agent') || '').slice(0, 1000) || null;
    const { rows } = await pool.query(
      `INSERT INTO feedback_submissions
         (type, message, status, submitted_by_organizer_id, organizer_id, user_name, user_email,
          page_url, route, event_id, user_agent)
       VALUES ($1,$2,'new',$3,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, type, status, created_at`,
      [type, message, req.organizer.id, userName, req.organizer.email, pageUrl, route, eventId, userAgent]
    );
    res.status(201).json({ feedback: rows[0] });
  } catch (err) { next(err); }
});

router.get('/api/admin/feedback', requireAdmin, async (req, res, next) => {
  try {
    const type = TYPES.includes(req.query.type) ? req.query.type : null;
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    const params = [];
    const conditions = [];
    if (type) { params.push(type); conditions.push(`f.type=$${params.length}`); }
    if (status) { params.push(status); conditions.push(`f.status=$${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `${feedbackSelect.replace('f.message,', 'LEFT(f.message, 180) AS message_preview,')}
       ${where}
       ORDER BY f.created_at DESC`,
      params
    );
    res.json({ feedback: rows });
  } catch (err) { next(err); }
});

router.get('/api/admin/feedback/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = positiveId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Feedback not found' });
    const { rows } = await pool.query(`${feedbackSelect} WHERE f.id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Feedback not found' });
    res.json({ feedback: rows[0] });
  } catch (err) { next(err); }
});

router.patch('/api/admin/feedback/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = positiveId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Feedback not found' });
    const status = STATUSES.includes(req.body.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ error: 'Invalid status' });
    const { rows } = await pool.query(
      `UPDATE feedback_submissions SET status=$2, updated_at=NOW() WHERE id=$1
       RETURNING id, status, updated_at`,
      [id, status]
    );
    if (!rows.length) return res.status(404).json({ error: 'Feedback not found' });
    res.json({ feedback: rows[0] });
  } catch (err) { next(err); }
});

router.delete('/api/admin/feedback/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = positiveId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Feedback not found' });
    const { rows } = await pool.query(
      'DELETE FROM feedback_submissions WHERE id=$1 RETURNING id',
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Feedback not found' });
    res.json({ deleted: true, id: rows[0].id });
  } catch (err) { next(err); }
});

module.exports = router;
