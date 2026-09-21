const pool = require('../config/db');
const { clientIp } = require('../lib/rate-limit');
const {
  clearAdminEditorCookie,
  closeWorkspace,
  readAdminEditorCookie,
  readAdminEditorWorkspace,
  safeWorkspace
} = require('../lib/admin-editor-workspace');

const EDITOR_RECOVERY_PATH = '/admin/done-for-you?editor=expired';

function isAdminEditorDocumentRequest(req) {
  const method = String(req.method || '').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  const requestPath = String(req.originalUrl || req.url || '').split('?')[0];
  return (requestPath === '/admin-editor' || requestPath.startsWith('/admin-editor/')) &&
    !requestPath.startsWith('/admin-editor/api/');
}

function reject(req, res, status, error, message) {
  res.setHeader('Cache-Control', 'private, no-store');
  // A document navigation cannot run the browser-side recovery code. Return the
  // operator to Done For You instead of rendering a raw JSON error page. Editor
  // API calls deliberately keep their structured JSON status and error code.
  if (isAdminEditorDocumentRequest(req)) {
    return res.redirect(302, EDITOR_RECOVERY_PATH);
  }
  return res.status(status).json({ error, message });
}

function requestContext(req) {
  return {
    requestIp: String(clientIp(req) || '').slice(0, 100) || null,
    userAgent: String(req.get('user-agent') || '').slice(0, 1000) || null
  };
}

async function requireAdminEditorWorkspace(req, res, next) {
  const operatorId = Number(req.adminOperator?.id);
  const dedicated = req.adminActor?.type === 'admin_operator' &&
    Number.isSafeInteger(operatorId) && operatorId > 0;
  if (!dedicated) {
    clearAdminEditorCookie(res);
    return reject(req, res, 403, 'dedicated_admin_required',
      'Sign in through the dedicated admin login.');
  }

  const token = readAdminEditorCookie(req);
  if (!token) {
    return reject(req, res, 401, 'admin_editor_workspace_required',
      'Open this event from the Done For You client page.');
  }

  try {
    const row = await readAdminEditorWorkspace(pool, token);
    if (!row) {
      clearAdminEditorCookie(res);
      return reject(req, res, 401, 'admin_editor_workspace_required',
        'Open this event from the Done For You client page.');
    }
    if (Number(row.actor_admin_operator_id) !== operatorId) {
      // Never revoke a valid grant that belongs to a different operator. This
      // browser simply does not possess the matching independent admin session.
      clearAdminEditorCookie(res);
      return reject(req, res, 403, 'admin_editor_operator_mismatch',
        'This editor workspace belongs to a different administrator.');
    }
    if (row.status !== 'active') {
      clearAdminEditorCookie(res);
      return reject(req, res, 401, 'admin_editor_workspace_inactive',
        'This editor workspace is no longer active.');
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await closeWorkspace(pool, {
        workspaceId: row.id,
        actorAdminOperatorId: operatorId,
        status: 'expired',
        cause: 'ttl',
        ...requestContext(req)
      });
      clearAdminEditorCookie(res);
      return reject(req, res, 401, 'admin_editor_workspace_expired',
        'This editor workspace has expired.');
    }

    const exactTarget = row.target_user_id != null && row.organizer_id != null &&
      Number(row.current_target_user_id) === Number(row.target_user_id) &&
      Number(row.organizer_user_id) === Number(row.target_user_id);
    const exactDraft = row.event_id == null || (
      row.event_organizer_id != null &&
      Number(row.event_organizer_id) === Number(row.organizer_id) &&
      row.event_status === 'draft'
    );
    if (row.operator_status !== 'active' || row.target_account_status !== 'active' ||
        !exactTarget || !exactDraft) {
      await closeWorkspace(pool, {
        workspaceId: row.id,
        actorAdminOperatorId: operatorId,
        status: 'revoked',
        cause: 'scope_unavailable',
        ...requestContext(req)
      });
      clearAdminEditorCookie(res);
      return reject(req, res, 403, 'admin_editor_scope_unavailable',
        'This client or draft can no longer be edited.');
    }

    req.adminEditorWorkspace = safeWorkspace(row);
    res.setHeader('Cache-Control', 'private, no-store');
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = requireAdminEditorWorkspace;
