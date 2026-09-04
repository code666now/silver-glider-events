const express = require('express');
const multer = require('multer');
const requireOrganizer = require('../middleware/requireOrganizer');
const requireAdmin = require('../middleware/requireAdmin');
const pool = require('../config/db');
const { uploadCover, uploadFlyer, uploadHostHeader, uploadHostLogo, uploadAccountAvatar, configured } = require('../lib/cloudinary');
const { selectAccentColor } = require('../../public/js/artwork-color');
const { linkVerifiedRsvps } = require('../lib/account-rsvps');

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
    res.json({ url: result.secure_url, accentColor: selectAccentColor(result.colors, { fallback: null }) });
  } catch (err) {
    console.error('[upload:cover]', err.name, err.http_code || '', err.message);
    // Surface a useful message instead of a generic 500
    const msg = /certificate|self.signed|ECONN|ETIMEDOUT|ENOTFOUND/i.test(err.message)
      ? 'Could not reach the image service. Please try again.'
      : (err.message || 'Upload failed');
    res.status(502).json({ error: msg });
  }
});

router.post('/api/uploads/flyer', requireOrganizer, handleUpload, async (req, res) => {
  if (!configured) return res.status(503).json({ error: 'Image uploads are not set up yet' });
  if (!req.file) return res.status(400).json({ error: 'Choose a flyer (JPG, PNG, WebP, or GIF, max 5 MB)' });
  try {
    const result = await uploadFlyer(req.file.buffer);
    res.json({ url: result.secure_url, accentColor: selectAccentColor(result.colors, { fallback: null }) });
  } catch (err) {
    console.error('[upload:flyer]', err.name, err.http_code || '', err.message);
    const msg = /certificate|self.signed|ECONN|ETIMEDOUT|ENOTFOUND/i.test(err.message)
      ? 'Could not reach the image service. Please try again.'
      : (err.message || 'Upload failed');
    res.status(502).json({ error: msg });
  }
});

router.post('/api/uploads/avatar', requireOrganizer, handleUpload, async (req, res) => {
  if (!configured) return res.status(503).json({ error: 'Image uploads are not set up yet' });
  if (!req.file) return res.status(400).json({ error: 'Choose a photo (JPG, PNG, WebP, or GIF, max 5 MB)' });
  try {
    const result = await uploadAccountAvatar(req.file.buffer);
    const { rows } = await pool.query(
      `UPDATE organizers SET avatar_url=$2, updated_at=NOW() WHERE id=$1
       RETURNING id, email, name, avatar_url, org_name, public_slug, logo_url, header_image_url,
                 bio, website_url, instagram_handle, instagram_url, contact_email,
                 plan, is_admin, created_at, updated_at`,
      [req.organizer.id, result.secure_url]
    );
    await linkVerifiedRsvps(pool, req.organizer.id, req.organizer.email);
    res.json({ url: result.secure_url, organizer: rows[0] });
  } catch (err) {
    console.error('[upload:avatar]', err.name, err.http_code || '', err.message);
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
      `UPDATE organizers SET logo_url=$2, updated_at=NOW() WHERE id=$1
       RETURNING id, email, name, avatar_url, org_name, public_slug, logo_url, header_image_url,
                 bio, website_url, instagram_handle, instagram_url, contact_email,
                 plan, is_admin, created_at, updated_at`,
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

router.post('/api/uploads/host-header', requireOrganizer, handleUpload, async (req, res) => {
  if (!configured) return res.status(503).json({ error: 'Image uploads are not set up yet' });
  if (!req.organizer.public_slug) return res.status(400).json({ error: 'Save a public host name before adding a header image' });
  if (!req.file) return res.status(400).json({ error: 'Choose a header image (JPG, PNG, WebP, or GIF, max 5 MB)' });
  try {
    const result = await uploadHostHeader(req.file.buffer);
    const { rows } = await pool.query(
      `UPDATE organizers SET header_image_url=$2, updated_at=NOW() WHERE id=$1
       RETURNING id, email, name, avatar_url, org_name, public_slug, logo_url, header_image_url,
                 bio, website_url, instagram_handle, instagram_url, contact_email,
                 plan, is_admin, created_at, updated_at`,
      [req.organizer.id, result.secure_url]
    );
    res.json({ url: result.secure_url, organizer: rows[0] });
  } catch (err) {
    console.error('[upload:host-header]', err.name, err.http_code || '', err.message);
    const msg = /certificate|self.signed|ECONN|ETIMEDOUT|ENOTFOUND/i.test(err.message)
      ? 'Could not reach the image service. Please try again.'
      : (err.message || 'Upload failed');
    res.status(502).json({ error: msg });
  }
});

function positiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function adminHostUpload(kind, uploadImage) {
  return async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Host account not found' });
    if (!configured) return res.status(503).json({ error: 'Image uploads are not set up yet' });
    if (!req.file) return res.status(400).json({ error: 'Choose an image (JPG, PNG, WebP, or GIF, max 5 MB)' });
    try {
      const result = await uploadImage(req.file.buffer);
      const column = kind === 'logo' ? 'logo_url' : 'header_image_url';
      const { rows } = await pool.query(
        `UPDATE organizers SET ${column}=$2, updated_at=NOW() WHERE id=$1
         RETURNING id, email, name, org_name, public_slug, logo_url, header_image_url,
                   bio, website_url, instagram_handle, instagram_url, contact_email,
                   plan, is_admin, created_at, updated_at`,
        [id, result.secure_url]
      );
      if (!rows.length) return res.status(404).json({ error: 'Host account not found' });
      res.json({ url: result.secure_url, organizer: rows[0] });
    } catch (err) {
      console.error(`[upload:admin-host-${kind}]`, err.name, err.http_code || '', err.message);
      const msg = /certificate|self.signed|ECONN|ETIMEDOUT|ENOTFOUND/i.test(err.message)
        ? 'Could not reach the image service. Please try again.'
        : (err.message || 'Upload failed');
      res.status(502).json({ error: msg });
    }
  };
}

router.post('/api/admin/uploads/hosts/:id/logo', requireAdmin, handleUpload, adminHostUpload('logo', uploadHostLogo));
router.post('/api/admin/uploads/hosts/:id/header', requireAdmin, handleUpload, adminHostUpload('header', uploadHostHeader));

module.exports = router;
