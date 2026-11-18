const express = require('express');
const pool = require('../config/db');
const requireOrganizer = require('../middleware/requireOrganizer');
const requireAdmin = require('../middleware/requireAdmin');
const { requireSuperAdmin } = require('../middleware/requireAdmin');
const { clientIp } = require('../lib/rate-limit');
const EventBackgrounds = require('../../public/js/event-backgrounds');
const { ALWAYS_AVAILABLE_KEYS, backgroundState, listBackgroundAvailability } = require('../lib/background-availability');

const router = express.Router();
const noStore = (req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
};

async function list(req, res, next) {
  try { res.json(await listBackgroundAvailability(pool)); } catch (error) { next(error); }
}

router.get('/api/backgrounds', noStore, requireOrganizer, list);
router.use('/api/admin/backgrounds', noStore, requireAdmin, requireSuperAdmin);
router.get('/api/admin/backgrounds', list);
router.patch('/api/admin/backgrounds/:key', async (req, res, next) => {
  const option = EventBackgrounds.options.find(item => item.key === req.params.key);
  if (!option) return res.status(404).json({ error: 'background_not_found', message: 'Background not found.' });
  if (typeof req.body?.active !== 'boolean') {
    return res.status(400).json({ error: 'invalid_background_availability', message: 'Choose Active or Inactive.' });
  }
  if (!req.body.active && ALWAYS_AVAILABLE_KEYS.includes(option.key)) {
    return res.status(409).json({ error: 'background_always_available', message: 'This core background is always available.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Recheck the actor under a lock so disable/demotion cannot race this write.
    const operator = (await client.query(
      `SELECT id,role,status,sessions_valid_after FROM admin_operators WHERE id=$1 FOR SHARE`,
      [req.adminOperator.id]
    )).rows[0];
    if (!operator || operator.role !== 'super_admin' || operator.status !== 'active' ||
        Number(req.adminSession?.issuedAt) < new Date(operator.sessions_valid_after).getTime()) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'super_admin_required', message: 'Sign in again as a Super Admin.' });
    }
    const current = (await client.query(
      'SELECT active FROM event_background_availability WHERE background_key=$1 FOR UPDATE', [option.key]
    )).rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'background_not_ready', message: 'This background is not ready. Refresh and try again.' });
    }
    if (current.active !== req.body.active) {
      await client.query(
        `UPDATE event_background_availability SET active=$2,updated_at=NOW(),updated_by_admin_operator_id=$3
          WHERE background_key=$1`, [option.key, req.body.active, operator.id]
      );
      await client.query(
        `INSERT INTO admin_account_audit_log
           (actor_admin_operator_id,action_type,reason,before_state,after_state,metadata,request_ip,user_agent)
         VALUES ($1,'background_availability_changed','Updated curated background availability',
                 $2::jsonb,$3::jsonb,$4::jsonb,$5,$6)`,
        [operator.id, JSON.stringify({ active: current.active }), JSON.stringify({ active: req.body.active }),
          JSON.stringify({ background_key: option.key }), String(clientIp(req) || '').slice(0, 100) || null,
          String(req.get('user-agent') || '').slice(0, 1000) || null]
      );
    }
    await client.query('COMMIT');
    res.json({ background: backgroundState(option, { active: req.body.active }) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

module.exports = router;
