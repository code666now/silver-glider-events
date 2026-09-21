const express = require('express');
const pool = require('../config/db');
const requireAdmin = require('../middleware/requireAdmin');
const { requireDedicatedAdmin } = require('../middleware/requireAdmin');
const requireAdminEditorWorkspace = require('../middleware/requireAdminEditorWorkspace');
const { clientIp } = require('../lib/rate-limit');
const {
  AdminEditorWorkspaceError,
  clearAdminEditorCookie,
  exitAdminEditorWorkspace
} = require('../lib/admin-editor-workspace');

const router = express.Router();

router.use(requireAdmin, requireDedicatedAdmin, requireAdminEditorWorkspace);

router.post('/api/workspace/exit', async (req, res, next) => {
  try {
    const result = await exitAdminEditorWorkspace(pool, {
      workspaceId: req.adminEditorWorkspace.id,
      actorAdminOperatorId: req.adminOperator.id,
      requestIp: String(clientIp(req) || '').slice(0, 100) || null,
      userAgent: String(req.get('user-agent') || '').slice(0, 1000) || null
    });
    clearAdminEditorCookie(res);
    res.json({ ok: true, redirect: result.redirect });
  } catch (error) {
    if (!(error instanceof AdminEditorWorkspaceError)) return next(error);
    clearAdminEditorCookie(res);
    res.status(error.status).json({ error: error.code, message: error.message });
  }
});

module.exports = router;
