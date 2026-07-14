const express = require('express');
const multer = require('multer');
const requireOrganizer = require('../middleware/requireOrganizer');
const pool = require('../config/db');
const { uploadCover, uploadHostLogo, configured } = require('../lib/cloudinary');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype));
  }
});

// Wrap multer so its errors (file too large, etc.) become clean JSON, not 500s
function handleUpload(req, res, next) {
  upload.single('image')(req, res, err => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Image is too large (max 5 MB)' });
      return res.status(400).json({ error: 'That file could not be read as an image' });
    }
    next();
  });
}

router.post('/api/uploads/cover', requireOrganizer, handleUpload, async (req, res) => {
  if (!configured) return res.status(503).json({ error: 'Image uploads are not set up yet' });
  if (!req.file) return res.status(400).json({ error: 'Choose an image (JPG, PNG, or WebP, max 5 MB)' });
  try {
    const result = await uploadCover(req.file.buffer);
    res.json({ url: result.secure_url });
  } catch (err) {
    console.error('[upload:cover]', err.name, err.http_code || '', err.message);
    // Surface a useful message instead of a generic 500
    const msg = /certificate|self.signed|ECONN|ETIMEDOUT|ENOTFOUND/i.test(err.message)
      ? 'Could not reach the image service. Please try again.'
      : (err.message || 'Upload failed');
    res.status(502).json({ error: msg });
  }
});

router.post('/api/uploads/host-logo', requireOrganizer, handleUpload, async (req, res) => {
  if (!configured) return res.status(503).json({ error: 'Image uploads are not set up yet' });
  if (!req.file) return res.status(400).json({ error: 'Choose a logo (JPG, PNG, WebP, or GIF, max 5 MB)' });
  try {
    const result = await uploadHostLogo(req.file.buffer);
    const { rows } = await pool.query(
      `UPDATE organizers SET logo_url=$2 WHERE id=$1
       RETURNING id, email, name, org_name, public_slug, logo_url, plan, is_admin, created_at`,
      [req.organizer.id, result.secure_url]
    );
    res.json({ url: result.secure_url, organizer: rows[0] });
  } catch (err) {
    console.error('[upload:host-logo]', err.name, err.http_code || '', err.message);
    const msg = /certificate|self.signed|ECONN|ETIMEDOUT|ENOTFOUND/i.test(err.message)
      ? 'Could not reach the image service. Please try again.'
      : (err.message || 'Upload failed');
    res.status(502).json({ error: msg });
  }
});

module.exports = router;
