'use strict';

const express = require('express');
const multer = require('multer');
const cloudinary = require('../lib/cloudinary');
const requireAdmin = require('../middleware/requireAdmin');
const { requireDedicatedAdmin, requireSuperAdmin, actorIds } = require('../middleware/requireAdmin');
const { createRateLimiter } = require('../lib/rate-limit');
const { ImageUploadError } = require('../lib/image-upload');
const {
  createHomepagePhotographyStore, HomepagePhotographyError, parsedPhotoId, MAX_PHOTOS, MAX_UPLOAD_BYTES
} = require('../lib/homepage-photography');

const router = express.Router();
const base = '/api/admin/homepage-photography';
const photos = createHomepagePhotographyStore();
const operator = req => ({ operatorId: actorIds(req).actorAdminOperatorId, issuedAt: req.adminSession?.issuedAt });
const uploadLimiter = createRateLimiter({ windowMs: 5 * 60_000,
  rules: [{ name: 'homepage-photo-upload', max: 8, key: req => operator(req).operatorId }] });
setInterval(() => uploadLimiter.prune(), 60_000).unref();
let uploadsRunning = 0;

const uploadOne = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4, fieldSize: 1024, fieldNameSize: 24, parts: 6, headerPairs: 32 },
  fileFilter: (_req, file, done) => done(null, /^image\/(?:jpeg|png|webp)$/.test(file.mimetype))
}).single('image');

router.use(base, (_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
}, requireAdmin, requireDedicatedAdmin, requireSuperAdmin);

function failure(res, error) {
  if (error instanceof HomepagePhotographyError || error instanceof ImageUploadError) {
    return res.status(error.status).json({ error: error.code, message: error.message });
  }
  return res.status(503).json({ error: 'homepage_photography_unavailable', message: 'Couldn’t update the homepage gallery. Refresh and try again.' });
}

function uploadFile(req, res) {
  return new Promise((resolve, reject) => uploadOne(req, res, error => {
    if (error?.code === 'LIMIT_FILE_SIZE') return reject(new HomepagePhotographyError(413, 'image_too_large', 'Choose an image of 12 MB or less.'));
    if (error || !req.file?.buffer) return reject(new HomepagePhotographyError(400, 'invalid_image', 'Choose one JPG, PNG, or WebP image.'));
    return resolve(req.file.buffer);
  }));
}

async function boundedUpload(req, res, update) {
  if (!req.is('multipart/form-data')) return res.status(415).json({ error: 'multipart_required', message: 'Choose an image to upload.' });
  if (!cloudinary.configured) return res.status(503).json({ error: 'uploads_unavailable', message: 'Photo uploads are not set up yet.' });
  if (uploadsRunning >= 2) return res.status(429).json({ error: 'uploads_busy', message: 'Another photo is uploading. Wait a moment and try again.' });
  const limit = uploadLimiter.consume(req);
  if (!limit.allowed) return res.set('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000))).status(429)
    .json({ error: 'uploads_busy', message: 'Too many image uploads. Try again in a few minutes.' });
  uploadsRunning++;
  try { return await update(await uploadFile(req, res)); }
  catch (error) { return failure(res, error); }
  finally { uploadsRunning--; }
}

function requireJson(req, res, next) {
  if (!req.is('application/json')) return res.status(415).json({ error: 'json_required', message: 'Send a photo update as JSON.' });
  next();
}

function requirePhotoId(req, res, next) {
  req.homepagePhotoId = parsedPhotoId(req.params.id);
  if (!req.homepagePhotoId) return res.status(404).json({ error: 'photo_not_found', message: 'This photo is no longer available.' });
  next();
}

router.get(base, async (_req, res) => {
  try { return res.json({ photos: await photos.listAll(), uploadsEnabled: cloudinary.configured, maxPhotos: MAX_PHOTOS, maxUploadBytes: MAX_UPLOAD_BYTES }); }
  catch (error) { return failure(res, error); }
});

router.post(base, (req, res) => boundedUpload(req, res, async buffer => {
  const photo = await photos.create(buffer, req.body, operator(req));
  return res.status(201).json({ photo });
}));

router.put(`${base}/order`, requireJson, async (req, res) => {
  if (!req.body || Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body, 'ids')) {
    return res.status(400).json({ error: 'invalid_photo_order', message: 'Include each photo once in the new order.' });
  }
  try { return res.json({ photos: await photos.reorder(req.body.ids, operator(req)) }); }
  catch (error) { return failure(res, error); }
});

router.patch(`${base}/:id`, requirePhotoId, requireJson, async (req, res) => {
  try { return res.json({ photo: await photos.update(req.homepagePhotoId, req.body, operator(req)) }); }
  catch (error) { return failure(res, error); }
});

router.post(`${base}/:id/image`, requirePhotoId, (req, res) => boundedUpload(req, res, async buffer => {
  if (Object.keys(req.body || {}).length) return res.status(400).json({ error: 'invalid_photo_fields', message: 'Replace the image separately from editing its details.' });
  return res.json({ photo: await photos.replace(req.homepagePhotoId, buffer, operator(req)) });
}));

router.delete(`${base}/:id`, requirePhotoId, async (req, res) => {
  try {
    await photos.remove(req.homepagePhotoId, operator(req));
    return res.status(204).end();
  } catch (error) { return failure(res, error); }
});

module.exports = router;
