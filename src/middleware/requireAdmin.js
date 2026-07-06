const requireOrganizer = require('./requireOrganizer');

function requireAdmin(req, res, next) {
  requireOrganizer(req, res, () => {
    if (!req.organizer.is_admin) {
      if (req.path.startsWith('/api/') || req.baseUrl.startsWith('/api/')) {
        return res.status(403).json({ error: 'Admin only' });
      }
      return res.redirect('/dashboard');
    }
    next();
  });
}

module.exports = requireAdmin;
