const express = require('express');
const pool = require('../config/db');
const requireAdmin = require('../middleware/requireAdmin');
const { isDedicatedSuperAdmin } = require('../middleware/requireAdmin');
const { clientIp } = require('../lib/rate-limit');
const {
  AdminOperatorError,
  createAdminOperator,
  listAdminOperatorRoster,
  revokeAdminOperatorSessions,
  updateAdminOperator
} = require('../lib/admin-operators');
const {
  clearAdminActionProofCookie,
  consumeAdminActionProof
} = require('./admin-auth');

const router = express.Router();

function requireDedicatedSuperAdmin(req, res, next) {
  if (isDedicatedSuperAdmin(req)) return next();
  return res.status(403).json({
    error: 'dedicated_super_admin_required',
    message: 'Sign in through the dedicated admin login as a Super Admin.'
  });
}

function requestContext(req) {
  return {
    requestIp: clientIp(req),
    userAgent: req.get('user-agent') || null
  };
}

function proofAuthorizer(req) {
  return (client, targetKey) => consumeAdminActionProof(client, req, {
    operatorId: req.adminOperator.id,
    action: 'operator_manage',
    targetKey
  });
}

function handleOperatorError(error, res, next) {
  if (!(error instanceof AdminOperatorError)) return next(error);
  return res.status(error.status).json({ error: error.code, message: error.message });
}

router.use('/api/admin/operators', requireAdmin, requireDedicatedSuperAdmin);

router.get('/api/admin/operators', async (req, res, next) => {
  try {
    const roster = await listAdminOperatorRoster(pool, req.adminOperator.id);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(roster);
  } catch (error) { next(error); }
});

router.post('/api/admin/operators', async (req, res, next) => {
  try {
    const operator = await createAdminOperator(pool, {
      actorId: req.adminOperator.id,
      email: req.body?.email,
      role: req.body?.role,
      reason: req.body?.reason,
      ...requestContext(req),
      authorize: proofAuthorizer(req)
    });
    clearAdminActionProofCookie(res);
    res.status(201).json({ operator });
  } catch (error) { handleOperatorError(error, res, next); }
});

router.patch('/api/admin/operators/:id', async (req, res, next) => {
  try {
    const operator = await updateAdminOperator(pool, {
      actorId: req.adminOperator.id,
      targetId: req.params.id,
      role: req.body?.role,
      status: req.body?.status,
      hasRole: Object.prototype.hasOwnProperty.call(req.body || {}, 'role'),
      hasStatus: Object.prototype.hasOwnProperty.call(req.body || {}, 'status'),
      reason: req.body?.reason,
      ...requestContext(req),
      authorize: proofAuthorizer(req)
    });
    clearAdminActionProofCookie(res);
    res.json({ operator });
  } catch (error) { handleOperatorError(error, res, next); }
});

router.post('/api/admin/operators/:id/revoke-sessions', async (req, res, next) => {
  try {
    const operator = await revokeAdminOperatorSessions(pool, {
      actorId: req.adminOperator.id,
      targetId: req.params.id,
      reason: req.body?.reason,
      ...requestContext(req),
      authorize: proofAuthorizer(req)
    });
    clearAdminActionProofCookie(res);
    res.json({ operator });
  } catch (error) { handleOperatorError(error, res, next); }
});

module.exports = router;
