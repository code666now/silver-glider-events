const express = require('express');
const crypto = require('crypto');
const pool = require('../config/db');
const requireAdmin = require('../middleware/requireAdmin');

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
    let where = '';
    if (status) { params.push(status); where = 'WHERE ls.status=$1'; }
    const { rows } = await pool.query(
      `SELECT ls.id, ls.status, ls.created_at, ls.reviewed_at,
              e.title, e.event_date, e.venue_name, e.slug, e.visibility,
              o.email AS organizer_email, o.org_name, o.name AS organizer_name
         FROM line_submissions ls
         JOIN events e ON e.id = ls.event_id
         JOIN organizers o ON o.id = ls.organizer_id
        ${where}
        ORDER BY ls.created_at ASC`,
      params
    );
    res.json({ submissions: rows });
  } catch (err) { next(err); }
});

async function review(req, res, next, status) {
  try {
    const { rows } = await pool.query(
      `UPDATE line_submissions SET status=$2, reviewed_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id, status]
    );
    if (!rows.length) return res.status(404).json({ error: 'Submission not found' });
    res.json({ submission: rows[0] });
  } catch (err) { next(err); }
}

router.post('/api/admin/line-submissions/:id/approve', (req, res, next) => review(req, res, next, 'approved'));
router.post('/api/admin/line-submissions/:id/reject', (req, res, next) => review(req, res, next, 'rejected'));

module.exports = router;
