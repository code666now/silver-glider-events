function contributorErrorRoute(path) {
  const value = String(path || '');
  if (/^\/api\/contributors\/intake\/[^/]+\/photo\/?$/.test(value)) return '/api/contributors/intake/:token/photo';
  if (/^\/api\/contributors\/intake\/[^/]+\/?$/.test(value)) return '/api/contributors/intake/:token';
  if (/^\/contributors\/intake\/[^/]+\/?$/.test(value)) return '/contributors/intake/:token';
  if (/^\/api\/events\/[^/]+\/contributors\/[^/]+\/?$/.test(value)) return '/api/events/:eventId/contributors/:id';
  if (/^\/api\/events\/[^/]+\/contributors\/?$/.test(value)) return '/api/events/:eventId/contributors';
  if (/^\/api\/contributors\/claim\/[^/]+\/?$/.test(value)) return '/api/contributors/claim/:id';
  if (/^\/contributors\/claim\/[^/]+\/?$/.test(value)) return '/contributors/claim/:id';
  if (/^\/api\/people\/[^/]+\/follow\/?$/.test(value)) return '/api/people/:slug/follow';
  if (/^\/api\/people\/[^/]+\/?$/.test(value)) return '/api/people/:slug';
  if (/^\/people\/[^/]+\/?$/.test(value)) return '/people/:slug';
  return null;
}

function errorHandler(err, req, res, next) {
  const contributorRoute = contributorErrorRoute(req.path);
  console.error('[error]', req.method, contributorRoute || req.path,
    contributorRoute ? 'Contributor request failed' : err.message);
  if (res.headersSent) {
    if (!contributorRoute) return next(err);
    // Express's final handler may log a forwarded error. Do not give that
    // fallback a database/provider message that could contain a bearer or email.
    const safeError = new Error('Contributor request failed');
    safeError.status = err.status || 500;
    return next(safeError);
  }
  const status = err.status || 500;
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ error: contributorRoute || status === 500 ? 'Something went wrong' : err.message });
  }
  res.status(status).send('Something went wrong');
}

module.exports = errorHandler;
module.exports.contributorErrorRoute = contributorErrorRoute;
