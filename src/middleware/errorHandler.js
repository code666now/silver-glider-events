function errorHandler(err, req, res, next) {
  console.error('[error]', req.method, req.path, err.message);
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ error: status === 500 ? 'Something went wrong' : err.message });
  }
  res.status(status).send('Something went wrong');
}

module.exports = errorHandler;
