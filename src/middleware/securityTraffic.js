const crypto = require('crypto');
const { clientIp } = require('../lib/rate-limit');

function shortHash(value) {
  const secret = String(process.env.SESSION_SECRET || 'silver-glider-traffic');
  return crypto.createHmac('sha256', secret).update(String(value || 'unknown')).digest('hex').slice(0, 16);
}

function classify(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return null;
  const path = String(req.path || '');
  if (path === '/auth/verify' || path.startsWith('/api/auth/') || path.startsWith('/api/admin/auth/')) {
    return { category: 'sign_in', action: path.includes('verify') ? 'verify' : path.includes('logout') ? 'logout' : 'start' };
  }
  if (/^\/api\/public\/events\/[^/]+\/(?:rsvp|returning-rsvp)$/.test(path)) {
    return { category: 'rsvp', action: path.endsWith('/returning-rsvp') ? 'returning' : 'submit' };
  }
  if (path.startsWith('/api/uploads/') || path.startsWith('/admin-editor/api/uploads/')) {
    return { category: 'upload', action: 'account' };
  }
  if (/^\/api\/public\/photo-collections\/[^/]+$/.test(path)) {
    return { category: 'upload', action: 'event_photos' };
  }
  if (path === '/api/flyer-intake') return { category: 'upload', action: 'flyer_intake' };
  return null;
}

function outcome(status) {
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status === 401 || status === 403) return 'rejected';
  if (status >= 400) return 'invalid';
  return 'accepted';
}

module.exports = function securityTraffic(req, res, next) {
  const event = classify(req);
  if (!event) return next();
  const startedAt = Date.now();
  const network = shortHash(clientIp(req));
  res.once('finish', () => {
    const accountId = req.sessionAccount?.user_id || req.sessionAccount?.id || req.organizer?.user_id || req.organizer?.id;
    const record = {
      event: 'security_traffic',
      category: event.category,
      action: event.action,
      outcome: outcome(res.statusCode),
      status: res.statusCode,
      network,
      account: accountId ? shortHash(`account:${accountId}`) : null,
      durationMs: Date.now() - startedAt
    };
    console.info('[security-traffic]', JSON.stringify(record));
  });
  next();
};

module.exports.classify = classify;
module.exports.outcome = outcome;
module.exports.shortHash = shortHash;
