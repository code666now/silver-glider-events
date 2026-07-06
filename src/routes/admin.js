const express = require('express');
const pool = require('../config/db');
const requireAdmin = require('../middleware/requireAdmin');

const router = express.Router();
router.use('/api/admin', requireAdmin);

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
