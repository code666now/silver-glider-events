'use strict';

const express = require('express');
const pool = require('../config/db');
const requireAdmin = require('../middleware/requireAdmin');
const { requireDedicatedAdmin, requireSuperAdmin, isDedicatedSuperAdmin, actorIds } = require('../middleware/requireAdmin');
const { readSfRollout, writeSfRollout } = require('../lib/transit/sf-rollout');
const { getTransportationAnalytics } = require('../lib/transit/ride-metrics');

const router = express.Router();
const path = '/api/admin/transportation';

router.use(path, (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
}, requireAdmin, requireDedicatedAdmin);

function viewRollout(result) {
  return {
    enabled: result?.enabled === true,
    allowed: result?.allowed === true,
    requested: result?.requested === true,
    reason: typeof result?.reason === 'string' ? result.reason : null,
    updatedAt: result?.updatedAt || null
  };
}

router.get(`${path}/rollout`, async (req, res) => {
  try {
    const rollout = await readSfRollout({ db: pool });
    return res.json({ rollout: viewRollout(rollout), canManage: isDedicatedSuperAdmin(req) });
  } catch {
    return res.status(503).json({ error: 'transportation_rollout_unavailable', message: 'Citywide rollout status is unavailable.' });
  }
});

router.get(`${path}/analytics`, async (req, res) => {
  try {
    return res.json(await getTransportationAnalytics({ db: pool }));
  } catch {
    return res.status(503).json({ error: 'transportation_analytics_unavailable', message: 'Transportation analytics are unavailable.' });
  }
});

// requireAdmin already enforces same-origin for mutations. Only dedicated
// Super Admin actors may apply the setting; the rollout service enforces its
// safety gate and records the actor. This route can't change reminder flags.
router.patch(`${path}/rollout`, requireSuperAdmin, async (req, res) => {
  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'json_required', message: 'Use a JSON request.' });
  }
  if (!req.body || Object.keys(req.body).length !== 1 || typeof req.body.enabled !== 'boolean') {
    return res.status(400).json({ error: 'invalid_rollout_setting', message: 'Choose whether the citywide rollout should be on or off.' });
  }
  try {
    const rollout = await writeSfRollout({ db: pool, enabled: req.body.enabled, operatorId: actorIds(req).actorAdminOperatorId });
    return res.json({ rollout: viewRollout(rollout), canManage: true });
  } catch (error) {
    const status = error?.statusCode;
    if (status === 409 || status === 423) {
      return res.status(status).json({ error: 'transportation_rollout_blocked', message: 'Citywide rollout cannot be enabled right now. Refresh its status for details.' });
    }
    if (status === 401 || status === 403) {
      return res.status(status).json({ error: 'super_admin_required', message: 'Super Admin access is required.' });
    }
    return res.status(503).json({ error: 'transportation_rollout_unavailable', message: 'The rollout change could not be confirmed.' });
  }
});

module.exports = router;
