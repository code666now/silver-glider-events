const express = require('express');
const multer = require('multer');
const requireOrganizer = require('../middleware/requireOrganizer');
const requireAdmin = require('../middleware/requireAdmin');
const { actorIds, requireDedicatedAdmin } = require('../middleware/requireAdmin');
const requirePhotoAccess = require('../middleware/requirePhotoAccess');
const pool = require('../config/db');
const {
  uploadCover,
  uploadFlyer,
  uploadHostHeader,
  uploadHostLogo,
  uploadAccountAvatar,
  uploadVibePhoto,
  managedPublicIdFromUrl,
  configured
} = require('../lib/cloudinary');
const { selectAccentColor } = require('../../public/js/artwork-color');
const { linkVerifiedRsvps } = require('../lib/account-rsvps');
const { clientIp } = require('../lib/rate-limit');
const { outboundDeliveryLockKey } = require('../lib/outbound-account-status');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype));
  }
});

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
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

function handleAvatarUpload(req, res, next) {
  avatarUpload.single('image')(req, res, err => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Image is too large (max 20 MB)' });
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

router.post('/api/uploads/vibe-photo', requireOrganizer, handleUpload, async (req, res) => {
  if (!configured) return res.status(503).json({ error: 'Image uploads are not set up yet' });
  if (!req.file) return res.status(400).json({ error: 'Choose an artist photo (JPG, PNG, WebP, or GIF, max 5 MB)' });
  try {
    const result = await uploadVibePhoto(req.file.buffer);
    res.json({ url: result.secure_url });
  } catch (err) {
    console.error('[upload:vibe-photo]', err.name, err.http_code || '', err.message);
    const msg = /certificate|self.signed|ECONN|ETIMEDOUT|ENOTFOUND/i.test(err.message)
      ? 'Could not reach the image service. Please try again.'
      : (err.message || 'Upload failed');
    res.status(502).json({ error: msg });
  }
});

// Accepts a full account session or the photo-only grant from an RSVP
// confirmation's "Add your photo" link — this is the one write that grant opens.
router.post('/api/uploads/avatar', requirePhotoAccess, handleAvatarUpload, async (req, res) => {
  if (!configured) return res.status(503).json({ error: 'Image uploads are not set up yet' });
  if (!req.file) return res.status(400).json({ error: 'Choose a photo (JPG, PNG, WebP, or GIF, max 20 MB)' });
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

let adminHostUploads = {
  configured,
  logo: uploadHostLogo,
  header: uploadHostHeader
};

function adminMediaState(url) {
  return {
    hasMedia: Boolean(url),
    managedPublicId: managedPublicIdFromUrl(url)
  };
}

async function persistAdminHostMedia(db, req, { id, kind, url }) {
  const column = kind === 'logo' ? 'logo_url' : 'header_image_url';
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const target = (await client.query(
      'SELECT user_id FROM organizers WHERE id=$1',
      [id]
    )).rows[0];
    if (!target) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [outboundDeliveryLockKey(target.user_id)]
    );
    const current = (await client.query(
      `SELECT id,user_id,${column} AS current_url
         FROM organizers
        WHERE id=$1 AND user_id=$2
        FOR UPDATE`,
      [id, target.user_id]
    )).rows[0];
    const canonicalUser = (await client.query(
      'SELECT account_status FROM users WHERE id=$1 FOR UPDATE',
      [target.user_id]
    )).rows[0];
    if (!current || !canonicalUser || canonicalUser.account_status === 'deleted') {
      await client.query('ROLLBACK');
      return null;
    }
    const { rows } = await client.query(
      `UPDATE organizers SET ${column}=$2,updated_at=NOW() WHERE id=$1
       RETURNING id,email,name,org_name,public_slug,logo_url,header_image_url,
                 bio,website_url,instagram_handle,instagram_url,contact_email,
                 plan,is_admin,created_at,updated_at`,
      [id, url]
    );
    const actor = actorIds(req);
    const beforeState = adminMediaState(current.current_url);
    const afterState = adminMediaState(url);
    await client.query(
      `INSERT INTO admin_account_audit_log
         (actor_user_id,actor_admin_operator_id,target_user_id,action_type,reason,
          before_state,after_state,metadata,request_ip,user_agent)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10)`,
      [
        actor.actorUserId,
        actor.actorAdminOperatorId,
        current.user_id,
        kind === 'logo' ? 'host_logo_updated' : 'host_header_updated',
        `Admin Host Page ${kind} update`,
        JSON.stringify(beforeState),
        JSON.stringify(afterState),
        JSON.stringify({ organizerId: Number(id), mediaKind: kind }),
        String(clientIp(req) || '').slice(0, 100) || null,
        String(req.get('user-agent') || '').slice(0, 1000) || null
      ]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function adminHostUpload(kind) {
  return async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Host account not found' });
    if (!adminHostUploads.configured) return res.status(503).json({ error: 'Image uploads are not set up yet' });
    if (!req.file) return res.status(400).json({ error: 'Choose an image (JPG, PNG, WebP, or GIF, max 5 MB)' });
    try {
      // Reject an invalid target before sending bytes to the image provider.
      const target = await pool.query(
        `SELECT organizer.id
           FROM organizers organizer
           JOIN users canonical_user ON canonical_user.id=organizer.user_id
          WHERE organizer.id=$1 AND canonical_user.account_status<>'deleted'`,
        [id]
      );
      if (!target.rows.length) return res.status(404).json({ error: 'Host account not found' });
      const result = await adminHostUploads[kind](req.file.buffer);
      const organizer = await persistAdminHostMedia(pool, req, {
        id,
        kind,
        url: result.secure_url
      });
      if (!organizer) return res.status(404).json({ error: 'Host account not found' });
      res.json({ url: result.secure_url, organizer });
    } catch (err) {
      console.error(`[upload:admin-host-${kind}]`, err.name, err.http_code || '', err.message);
      const msg = /certificate|self.signed|ECONN|ETIMEDOUT|ENOTFOUND/i.test(err.message)
        ? 'Could not reach the image service. Please try again.'
        : (err.message || 'Upload failed');
      res.status(502).json({ error: msg });
    }
  };
}

router.post('/api/admin/uploads/hosts/:id/logo', requireAdmin, requireDedicatedAdmin, handleUpload, adminHostUpload('logo'));
router.post('/api/admin/uploads/hosts/:id/header', requireAdmin, requireDedicatedAdmin, handleUpload, adminHostUpload('header'));

router.setAdminHostUploadsForTests = overrides => {
  adminHostUploads = {
    configured,
    logo: uploadHostLogo,
    header: uploadHostHeader,
    ...(overrides || {})
  };
};
router.persistAdminHostMediaForTests = persistAdminHostMedia;

module.exports = router;
