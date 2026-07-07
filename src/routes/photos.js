const express = require('express');
const requireOrganizer = require('../middleware/requireOrganizer');
const unsplash = require('../lib/unsplash');

const router = express.Router();

// GET /api/photos/search?q=rooftop
router.get('/api/photos/search', requireOrganizer, async (req, res, next) => {
  try {
    if (!unsplash.enabled) return res.status(503).json({ error: 'Photo search is not set up' });
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ results: [] });
    const results = await unsplash.search(q);
    res.json({ results });
  } catch (err) { next(err); }
});

// POST /api/photos/track  { download_location } — required by Unsplash on select
router.post('/api/photos/track', requireOrganizer, (req, res) => {
  unsplash.triggerDownload(req.body && req.body.download_location);
  res.json({ ok: true });
});

// Expose whether the feature is on, so the form can show/hide the search UI
router.get('/api/photos/enabled', requireOrganizer, (req, res) => {
  res.json({ enabled: unsplash.enabled });
});

module.exports = router;
