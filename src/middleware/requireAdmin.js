const pool = require('../config/db');
const requireOrganizer = require('./requireOrganizer');
const { clearSessionCookie, setSessionCookie, MAX_AGE_SECONDS: ORGANIZER_MAX_AGE } = require('../lib/session');
const {
  clearAdminSessionCookie,
  loadAdminOperator,
  setAdminSessionCookie,
  MAX_AGE_SECONDS: ADMIN_MAX_AGE
} = require('../lib/admin-session');

function isApi(req) {
  return req.path.startsWith('/api/') || req.baseUrl.startsWith('/api/');
}

function reject(req, res, status = 401) {
  if (isApi(req)) {
    return res.status(status).json({
      error: status === 403 ? 'admin_forbidden' : 'admin_auth_required',
      message: status === 403 ? 'Administrator access is required.' : 'Sign in as an administrator.'
    });
  }
  const next = req.originalUrl && req.originalUrl.startsWith('/admin')
    ? `?next=${encodeURIComponent(req.originalUrl)}`
    : '';
  return res.redirect(`/admin/login${next}`);
}

function legacyFallbackEnabled() {
  return String(process.env.LEGACY_ADMIN_AUTH_ENABLED || 'false').toLowerCase() === 'true';
}

function sameOriginMutation(req) {
  const site = req.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.get('origin');
  if (!origin || origin === 'null') return true;

  let parsedOrigin;
  try { parsedOrigin = new URL(origin).origin; } catch (_) { return false; }
  const allowed = new Set();
  const host = req.get('host');
  if (host) allowed.add(`${req.protocol}://${host}`);
  try { allowed.add(new URL(process.env.APP_URL).origin); } catch (_) {}
  return allowed.has(parsedOrigin);
}

function continueAuthenticated(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || sameOriginMutation(req)) {
    return next();
  }
  return res.status(403).json({ error: 'forbidden' });
}

function actorIds(req) {
  return {
    actorUserId: req.adminActor?.type === 'legacy_user' ? Number(req.adminActor.userId) : null,
    actorAdminOperatorId: req.adminActor?.type === 'admin_operator'
      ? Number(req.adminActor.operatorId)
      : null
  };
}

function isDedicatedSuperAdmin(req) {
  return req.adminActor?.type === 'admin_operator' && req.adminOperator?.role === 'super_admin';
}

function requireSuperAdmin(req, res, next) {
  if (req.adminActor?.role === 'super_admin') return next();
  if (isApi(req)) {
    return res.status(403).json({
      error: 'super_admin_required',
      message: 'Super Admin access is required.'
    });
  }
  return res.redirect('/admin/accounts');
}

async function requireAdmin(req, res, next) {
  try {
    const dedicated = await loadAdminOperator(pool, req);
    if (dedicated.operator) {
      const remaining = dedicated.session.expiresAt - Math.floor(Date.now() / 1000);
      if (remaining < ADMIN_MAX_AGE / 2) {
        setAdminSessionCookie(res, dedicated.operator.id, dedicated.session.issuedAt);
      }
      req.adminOperator = dedicated.operator;
      req.adminActor = {
        type: 'admin_operator',
        operatorId: Number(dedicated.operator.id),
        email: dedicated.operator.email,
        role: dedicated.operator.role
      };
      return continueAuthenticated(req, res, next);
    }
    req.adminOperator = null;
    if (dedicated.stale) clearAdminSessionCookie(res);

    if (!legacyFallbackEnabled()) return reject(req, res);
    const legacy = await requireOrganizer.resolveSession(req);
    if (!legacy.account) {
      if (legacy.stale) clearSessionCookie(res);
      return reject(req, res);
    }
    if (!legacy.account.is_admin) return reject(req, res, 403);
    const remaining = legacy.session.exp - Math.floor(Date.now() / 1000);
    if (remaining < ORGANIZER_MAX_AGE / 2) setSessionCookie(res, legacy.account.id);
    req.organizer = legacy.account;
    req.adminActor = {
      type: 'legacy_user',
      userId: Number(legacy.account.user_id || legacy.account.id),
      email: legacy.account.email,
      role: 'super_admin'
    };
    return continueAuthenticated(req, res, next);
  } catch (error) {
    next(error);
  }
}

module.exports = requireAdmin;
module.exports.actorIds = actorIds;
module.exports.isDedicatedSuperAdmin = isDedicatedSuperAdmin;
module.exports.legacyFallbackEnabled = legacyFallbackEnabled;
module.exports.requireSuperAdmin = requireSuperAdmin;
module.exports.sameOriginMutation = sameOriginMutation;
