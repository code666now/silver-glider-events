const express = require('express');
const multer = require('multer');
const pool = require('../config/db');
const requireOrganizer = require('../middleware/requireOrganizer');
const { createRateLimiter, clientIp } = require('../lib/rate-limit');
const { ImageUploadError, normalizeRequestImages } = require('../lib/image-upload');
const cloudinary = require('../lib/cloudinary');
const {
  ContributorError, FOLLOW_VERSION, transaction, ownerEvent, ownerContributor,
  listContributors, inviteContributor, loadIntake, intakeDto, approveContributor,
  loadPublicProfile, publicProfileDto, followState, setContributorFollow,
  claimContext, claimContributor, tokenHash
} = require('../lib/contributors');

const router = express.Router();
const limiter = createRateLimiter({ windowMs: 60 * 60 * 1000, rules: [
  { name: 'network', max: 100, key: context => context.ip },
  { name: 'scope', max: 20, key: context => context.scope }
] });
const timer = setInterval(() => limiter.prune(), 15 * 60 * 1000);
timer.unref?.();

function positiveId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1 || String(id) !== String(value)) {
    throw new ContributorError(404, 'not_found', 'Not found');
  }
  return id;
}

function privateResponse(req, res, next) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
}

function mutation(req, res, next) {
  if (!requireOrganizer.sameOriginMutation(req)) return res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
  const outcome = limiter.consume({ ip: clientIp(req), scope: req.organizer?.id
    ? `account:${req.organizer.id}` : `intake:${tokenHash(req.params.token || '')}` });
  if (!outcome.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(outcome.retryAfterMs / 1000)));
    return res.status(429).json({ error: 'Too many requests. Try again shortly.', code: 'rate_limited' });
  }
  next();
}

const endpoint = fn => async (req, res, next) => {
  try { await fn(req, res); } catch (error) {
    if (error instanceof ContributorError || error instanceof ImageUploadError) {
      return res.status(error.status || 400).json({ error: error.message, code: error.code });
    }
    next(error);
  }
};

// Owner endpoints intentionally remain distinct from the public/intake grant.
router.get('/api/events/:eventId/contributors', privateResponse, requireOrganizer, endpoint(async (req, res) => {
  res.json(await listContributors(pool, positiveId(req.params.eventId), req.organizer.id));
}));

router.post('/api/events/:eventId/contributors', privateResponse, requireOrganizer, mutation, endpoint(async (req, res) => {
  try {
    res.status(201).json(await inviteContributor(pool, {
      eventId: positiveId(req.params.eventId), organizerId: req.organizer.id, body: req.body || {}
    }));
  } catch (error) {
    // A saved, frozen invitation can be retried with the exact same form. Do
    // not expose provider messages, addresses, payloads or bearer links.
    if (!(error instanceof ContributorError)) {
      return res.status(502).json({ error: 'The invitation could not be delivered. Try again with the same details.', code: 'invitation_delivery_failed' });
    }
    throw error;
  }
}));

router.patch('/api/events/:eventId/contributors/:id', privateResponse, requireOrganizer, mutation, endpoint(async (req, res) => {
  const eventId = positiveId(req.params.eventId);
  const id = positiveId(req.params.id);
  const body = req.body || {};
  if (typeof body.selected !== 'boolean' && body.revoked !== true) {
    throw new ContributorError(400, 'invalid_change', 'Choose whether to include this contributor');
  }
  const contributor = await transaction(pool, async client => {
    await ownerEvent(client, eventId, req.organizer.id, { lock: true, editable: true });
    const current = (await client.query(
      `SELECT c.*,p.slug FROM event_contributors c JOIN contributor_profiles p ON p.id=c.profile_id
        WHERE c.id=$1 AND c.event_id=$2 AND c.organizer_id=$3 AND c.status<>'revoked' FOR UPDATE OF c`,
      [id, eventId, req.organizer.id]
    )).rows[0];
    if (!current) throw new ContributorError(404, 'contributor_not_found', 'Contributor not found');
    if (body.version != null && Number(body.version) !== Number(current.version)) {
      throw new ContributorError(409, 'contributor_changed', 'This introduction changed. Refresh and try again');
    }
    const updated = (await client.query(
      `UPDATE event_contributors SET selected=CASE WHEN $2 THEN FALSE ELSE $3 END,
        status=CASE WHEN $2 THEN 'revoked' ELSE status END,
        revoked_at=CASE WHEN $2 THEN NOW() ELSE revoked_at END,version=version+1,updated_at=NOW()
        WHERE id=$1 RETURNING *`,
      [id, body.revoked === true, typeof body.selected === 'boolean' ? body.selected : current.selected]
    )).rows[0];
    return ownerContributor({ ...updated, slug: current.slug });
  });
  res.json({ contributor });
}));

router.get('/api/contributors/intake/:token', privateResponse, endpoint(async (req, res) => {
  res.json(intakeDto(await loadIntake(pool, req.params.token)));
}));

router.post('/api/contributors/intake/:token', privateResponse, mutation, endpoint(async (req, res) => {
  res.json(await approveContributor(pool, req.params.token, req.body || {}));
}));

// Contributors retain control of their introduction, even if a host already
// approved the email. The worker suppresses unsent frozen spotlights on revoke.
router.delete('/api/contributors/intake/:token', privateResponse, mutation, endpoint(async (req, res) => {
  await transaction(pool, async client => {
    const row = await loadIntake(client, req.params.token, { lock: true });
    await client.query(
      `UPDATE event_contributors SET status='revoked',selected=FALSE,revoked_at=NOW(),version=version+1,updated_at=NOW() WHERE id=$1`, [row.id]
    );
  });
  res.json({ revoked: true });
}));

const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 },
  fileFilter(req, file, cb) { cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)); }
});

function intakePhotoScope(req, res, next) {
  // Run authorization before Multer buffers a single byte. The separate wrapper
  // awaits the scope check and continues only if a response has not been sent.
  Promise.resolve().then(async () => {
    const row = await loadIntake(pool, req.params.token);
    if (row.status !== 'invited') throw new ContributorError(409, 'introduction_approved', 'This introduction has already been approved');
    if (!cloudinary.configured) throw new ContributorError(503, 'uploads_unavailable', 'Image uploads are not set up yet');
    req.contributorInvitation = row;
    next();
  }).catch(error => {
    if (error instanceof ContributorError) return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  });
}

function readPhoto(req, res, next) {
  photoUpload.single('image')(req, res, async error => {
    if (error) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Image is too large (max 5 MB)' : 'That image could not be read' });
    try {
      if (!req.file) throw new ContributorError(400, 'image_required', 'Choose a JPG, PNG, WebP, or GIF image');
      await normalizeRequestImages(req, { maxWidth: 1600, maxHeight: 1600, maxOutputBytes: 3 * 1024 * 1024 });
      next();
    } catch (validationError) {
      if (validationError instanceof ImageUploadError || validationError instanceof ContributorError) {
        return res.status(400).json({ error: validationError.message, code: validationError.code });
      }
      next(validationError);
    }
  });
}

router.post('/api/contributors/intake/:token/photo', privateResponse, mutation, intakePhotoScope, readPhoto, endpoint(async (req, res) => {
  let result;
  try { result = await cloudinary.uploadVibePhoto(req.file.buffer); } catch (_) {
    throw new ContributorError(502, 'image_upload_failed', 'The image service could not be reached. Try again');
  }
  if (!cloudinary.isManagedVibePhotoUrl(result.secure_url)) throw new ContributorError(502, 'image_upload_failed', 'The image could not be saved');
  await transaction(pool, async client => {
    const row = await loadIntake(client, req.params.token, { lock: true });
    if (row.status !== 'invited') throw new ContributorError(409, 'introduction_approved', 'This introduction has already been approved');
    await client.query('UPDATE event_contributors SET photo_url=$2,version=version+1,updated_at=NOW() WHERE id=$1', [row.id, result.secure_url]);
  });
  res.json({ url: result.secure_url, photoUrl: result.secure_url });
}));

router.delete('/api/contributors/intake/:token/photo', privateResponse, mutation, endpoint(async (req, res) => {
  await transaction(pool, async client => {
    const row = await loadIntake(client, req.params.token, { lock: true });
    if (row.status !== 'invited') throw new ContributorError(409, 'introduction_approved', 'This introduction has already been approved');
    await client.query('UPDATE event_contributors SET photo_url=NULL,version=version+1,updated_at=NOW() WHERE id=$1', [row.id]);
  });
  res.json({ url: null, photoUrl: null });
}));

router.get('/api/people/:slug', privateResponse, endpoint(async (req, res) => {
  const profile = await loadPublicProfile(pool, req.params.slug, req.query.intro ?? null);
  const viewer = req.sessionAccount?.user_id || req.sessionAccount?.id || null;
  res.json({ profile: publicProfileDto(profile), ...await followState(pool, profile, viewer),
    signedIn: Boolean(viewer), consentVersion: FOLLOW_VERSION });
}));

router.post('/api/people/:slug/follow', privateResponse, requireOrganizer, mutation, endpoint(async (req, res) => {
  res.json(await setContributorFollow(pool, { slug: req.params.slug, intro: req.query.intro ?? null,
    userId: req.organizer.user_id || req.organizer.id, body: req.body || {} }));
}));

router.delete('/api/people/:slug/follow', privateResponse, requireOrganizer, mutation, endpoint(async (req, res) => {
  res.json(await setContributorFollow(pool, { slug: req.params.slug, intro: req.query.intro ?? null,
    userId: req.organizer.user_id || req.organizer.id, remove: true }));
}));

router.get('/api/contributors/claim/:id', privateResponse, requireOrganizer, endpoint(async (req, res) => {
  const context = await claimContext(pool, positiveId(req.params.id), req.organizer.user_id || req.organizer.id);
  delete context.row;
  res.json(context);
}));

router.post('/api/contributors/claim/:id', privateResponse, requireOrganizer, mutation, endpoint(async (req, res) => {
  res.json(await claimContributor(pool, positiveId(req.params.id), req.organizer.user_id || req.organizer.id));
}));

module.exports = router;
module.exports.positiveId = positiveId;
module.exports.resetRateLimitsForTests = () => limiter.reset();
module.exports._resetRateLimitsForTests = module.exports.resetRateLimitsForTests;
