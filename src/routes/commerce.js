const express = require('express');
const requireOrganizer = require('../middleware/requireOrganizer');
const { commerceAdmissionEnabled } = require('../lib/commerce-client');

const router = express.Router();

// The editor can reveal native ticket setup only after the Commerce service is
// explicitly configured. No credentials or service details reach the browser.
router.get('/api/commerce/config', requireOrganizer, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ enabled: commerceAdmissionEnabled() });
});

module.exports = router;
