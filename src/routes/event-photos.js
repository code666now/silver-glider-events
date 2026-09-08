const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const pool = require('../config/db');
const requireOrganizer = require('../middleware/requireOrganizer');
const { uploadEventPhoto, deleteEventPhoto, configured } = require('../lib/cloudinary');
const { sendPhotoRequest } = require('../lib/mailer');
const { createRateLimiter, clientIp } = require('../lib/rate-limit');
const { esc, render404 } = require('../lib/public-html');

const router = express.Router();
const uploadTemplate = fs.readFileSync(path.join(__dirname, '..', 'views', 'event-photo-upload.html'), 'utf8');
const LEGACY_TOKEN_RE = /^[a-f0-9]{48}$/;
const SHORT_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_PHOTOS_PER_EVENT = 500;
const MAX_FEATURED_PHOTOS = 8;
const PHOTO_RATE_WINDOW_MS = 60 * 60 * 1000;
const photoRateLimiter = createRateLimiter({
  windowMs: PHOTO_RATE_WINDOW_MS,
  rules: [
    { name: 'ip-collection', max: 6, key: ({ ip, token }) => `${ip}:${token}` },
    { name: 'ip-global', max: 20, key: ({ ip }) => ip }
  ]
});
setInterval(() => photoRateLimiter.prune(), PHOTO_RATE_WINDOW_MS).unref();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.mimetype)) {
      return cb(Object.assign(new Error('Choose JPG, PNG, or WebP images'), { status: 400 }));
    }
    cb(null, true);
  }
});

function handlePhotoUpload(req, res, next) {
  upload.array('images', 5)(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Each photo must be 5 MB or smaller' });
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Choose up to five photos' });
    }
    return res.status(err.status || 400).json({ error: err.message || 'Those photos could not be read' });
  });
}

function validToken(value) {
  const token = String(value || '').trim();
  if (SHORT_TOKEN_RE.test(token)) return token;
  const legacyToken = token.toLowerCase();
  return LEGACY_TOKEN_RE.test(legacyToken) ? legacyToken : '';
}

function newShortToken() {
  return crypto.randomBytes(16).toString('base64url');
}

async function ensureShortToken(eventId, organizerId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { rows } = await pool.query(
        `UPDATE events
            SET photo_short_token=COALESCE(photo_short_token,$3), updated_at=NOW()
          WHERE id=$1 AND organizer_id=$2 AND collect_photos_enabled=TRUE
        RETURNING photo_short_token`,
        [eventId, organizerId, newShortToken()]
      );
      return rows[0]?.photo_short_token || null;
    } catch (err) {
      if (err.code !== '23505' || attempt === 2) throw err;
    }
  }
  return null;
}

function appBaseUrl() {
  return String(process.env.APP_URL || 'https://silvergliderevents.com').replace(/\/$/, '');
}

async function publicCollection(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT e.id, e.title, e.event_date, e.cover_image_url, e.flyer_image_url,
            e.presentation_mode, o.org_name, o.name AS organizer_name
       FROM events e JOIN organizers o ON o.id=e.organizer_id
      WHERE (e.photo_upload_token=$1 OR e.photo_short_token=$1)
        AND e.collect_photos_enabled=TRUE
        AND e.status='published'
        AND e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE e.timezone)::date`,
    [token]
  );
  return rows[0] || null;
}

router.get(['/photos/:token', '/p/:token'], async (req, res, next) => {
  try {
    const token = validToken(req.params.token);
    const event = await publicCollection(token);
    if (!event) return res.status(404).type('html').send(render404());
    const hostName = event.org_name || event.organizer_name || 'the host';
    const artwork = event.presentation_mode === 'flyer' && event.flyer_image_url
      ? event.flyer_image_url
      : event.cover_image_url;
    const artworkHtml = artwork
      ? `<img class="collection-artwork" src="${esc(artwork)}" alt="${esc(event.title)} artwork">`
      : '';
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Cache-Control', 'private, no-store');
    res.type('html').send(uploadTemplate
      .replace(/\{\{EVENT_TITLE\}\}/g, esc(event.title))
      .replace(/\{\{HOST_NAME\}\}/g, esc(hostName))
      .replace(/\{\{TOKEN\}\}/g, token)
      .replace(/\{\{ARTWORK\}\}/g, artworkHtml));
  } catch (err) { next(err); }
});

router.post('/api/public/photo-collections/:token', (req, res, next) => {
  const token = validToken(req.params.token);
  if (!token) return res.status(404).json({ error: 'Photo collection not found' });
  const rate = photoRateLimiter.consume({ ip: clientIp(req), token });
  if (rate.allowed) return next();
  res.setHeader('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)));
  return res.status(429).json({ error: 'Too many uploads. Please wait and try again.' });
}, handlePhotoUpload, async (req, res, next) => {
  let uploaded = [];
  try {
    const event = await publicCollection(validToken(req.params.token));
    if (!event) return res.status(404).json({ error: 'Photo collection not found' });
    if (!req.files?.length) return res.status(400).json({ error: 'Choose at least one photo' });
    if (!configured) return res.status(503).json({ error: 'Photo uploads are temporarily unavailable' });

    const { rows: counts } = await pool.query('SELECT COUNT(*)::int AS count FROM event_photos WHERE event_id=$1', [event.id]);
    if (counts[0].count + req.files.length > MAX_PHOTOS_PER_EVENT) {
      return res.status(409).json({ error: 'This photo collection is full' });
    }

    const contributorName = String(req.body.contributor_name || '').trim().replace(/\s+/g, ' ').slice(0, 100) || null;
    const publicFeatureConsent = req.body.public_feature_consent === 'true';
    uploaded = await Promise.all(req.files.map(file => uploadEventPhoto(file.buffer)));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize inserts for this event so concurrent uploads cannot exceed the cap.
      await client.query('SELECT id FROM events WHERE id=$1 FOR UPDATE', [event.id]);
      const { rows: lockedCounts } = await client.query(
        'SELECT COUNT(*)::int AS count FROM event_photos WHERE event_id=$1',
        [event.id]
      );
      if (lockedCounts[0].count + uploaded.length > MAX_PHOTOS_PER_EVENT) {
        throw Object.assign(new Error('This photo collection is full'), { status: 409 });
      }
      for (const image of uploaded) {
        await client.query(
          `INSERT INTO event_photos
             (event_id, cloudinary_id, image_url, contributor_name, public_feature_consent)
           VALUES ($1,$2,$3,$4,$5)`,
          [event.id, image.public_id, image.secure_url, contributorName, publicFeatureConsent]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.status(201).json({ uploaded: uploaded.length });
  } catch (err) {
    if (uploaded.length) await Promise.allSettled(uploaded.map(image => deleteEventPhoto(image.public_id)));
    next(err);
  }
});

router.get('/api/events/:id/photos', requireOrganizer, async (req, res, next) => {
  try {
    await ensureShortToken(req.params.id, req.organizer.id);
    const { rows: events } = await pool.query(
      `SELECT e.id, e.title, e.collect_photos_enabled, e.photo_upload_token, e.photo_short_token,
              e.photo_request_sent_at, e.photo_request_sent_count,
              e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE e.timezone)::date AS is_past,
              COALESCE((SELECT COUNT(*) FROM rsvps r
                         WHERE r.event_id=e.id AND r.status='confirmed' AND r.wants_reminders=TRUE),0)::int AS eligible_count
         FROM events e WHERE e.id=$1 AND e.organizer_id=$2`,
      [req.params.id, req.organizer.id]
    );
    if (!events.length) return res.status(404).json({ error: 'Event not found' });
    const event = events[0];
    if (!event.collect_photos_enabled || !event.is_past) {
      return res.status(404).json({ error: 'Photo collection not available' });
    }
    const { rows: photos } = await pool.query(
      `SELECT id, image_url, contributor_name, public_feature_consent, is_featured, featured_at, created_at
         FROM event_photos WHERE event_id=$1 ORDER BY created_at DESC, id DESC`,
      [event.id]
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      photos,
      collectionUrl: `${appBaseUrl()}/p/${event.photo_short_token || event.photo_upload_token}`,
      requestSentAt: event.photo_request_sent_at,
      requestSentCount: event.photo_request_sent_count,
      eligibleCount: event.eligible_count
    });
  } catch (err) { next(err); }
});

router.post('/api/events/:id/photo-request', requireOrganizer, async (req, res, next) => {
  try {
    await ensureShortToken(req.params.id, req.organizer.id);
    const { rows: claimed } = await pool.query(
      `UPDATE events e SET photo_request_sent_at=NOW(), photo_request_sent_count=0, updated_at=NOW()
        WHERE e.id=$1 AND e.organizer_id=$2 AND e.collect_photos_enabled=TRUE
          AND e.status='published' AND (e.photo_short_token IS NOT NULL OR e.photo_upload_token IS NOT NULL)
          AND e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE e.timezone)::date
          AND e.photo_request_sent_at IS NULL
      RETURNING e.*`,
      [req.params.id, req.organizer.id]
    );
    if (!claimed.length) {
      const { rows } = await pool.query('SELECT photo_request_sent_at FROM events WHERE id=$1 AND organizer_id=$2', [req.params.id, req.organizer.id]);
      if (!rows.length) return res.status(404).json({ error: 'Event not found' });
      if (rows[0].photo_request_sent_at) return res.status(409).json({ error: 'Photo request already sent' });
      return res.status(400).json({ error: 'Photo collection is not available for this event' });
    }

    const event = claimed[0];
    const { rows: recipients } = await pool.query(
      `SELECT id, email, first_name FROM rsvps
        WHERE event_id=$1 AND status='confirmed' AND wants_reminders=TRUE
        ORDER BY id`,
      [event.id]
    );
    const organizerLabel = req.organizer.org_name || req.organizer.name || 'the host';
    const uploadUrl = `${appBaseUrl()}/p/${event.photo_short_token || event.photo_upload_token}`;
    let sent = 0;
    for (const recipient of recipients) {
      let logId = null;
      try {
        const { rows } = await pool.query(
          `INSERT INTO message_log (rsvp_id, event_id, recipient, message_type, channel, status)
           VALUES ($1,$2,$3,'photo_request','email','pending')
           ON CONFLICT (rsvp_id, message_type, channel)
             WHERE rsvp_id IS NOT NULL AND notification_batch_id IS NULL DO NOTHING
           RETURNING id`,
          [recipient.id, event.id, recipient.email]
        );
        if (!rows.length) continue;
        logId = rows[0].id;
        const result = await sendPhotoRequest({
          to: recipient.email,
          event,
          organizerLabel,
          uploadUrl,
          replyTo: req.organizer.email
        });
        await pool.query(
          `UPDATE message_log SET status='sent', sent_at=NOW(), provider_id=$2, error=NULL WHERE id=$1`,
          [logId, result?.id || null]
        );
        sent += 1;
      } catch (err) {
        if (logId) {
          await pool.query(
            `UPDATE message_log SET status='failed', error=$2 WHERE id=$1`,
            [logId, String(err.message || 'Email delivery failed').slice(0, 2000)]
          ).catch(() => {});
        }
      }
    }
    await pool.query('UPDATE events SET photo_request_sent_count=$2 WHERE id=$1', [event.id, sent]);
    res.json({ sent, total: recipients.length });
  } catch (err) { next(err); }
});

router.get('/api/events/:eventId/photos/:photoId/download', requireOrganizer, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ep.image_url FROM event_photos ep JOIN events e ON e.id=ep.event_id
        WHERE ep.id=$1 AND ep.event_id=$2 AND e.organizer_id=$3`,
      [req.params.photoId, req.params.eventId, req.organizer.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Photo not found' });
    const attachmentUrl = rows[0].image_url.replace('/image/upload/', '/image/upload/fl_attachment/');
    res.redirect(attachmentUrl);
  } catch (err) { next(err); }
});

router.patch('/api/events/:eventId/photos/:photoId/feature', requireOrganizer, async (req, res, next) => {
  const featured = req.body?.featured;
  if (typeof featured !== 'boolean') return res.status(400).json({ error: 'Choose whether this photo is featured' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: events } = await client.query(
      `SELECT e.id FROM events e
        WHERE e.id=$1 AND e.organizer_id=$2 AND e.collect_photos_enabled=TRUE
          AND e.status='published'
          AND e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE e.timezone)::date
        FOR UPDATE`,
      [req.params.eventId, req.organizer.id]
    );
    if (!events.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Photo collection not found' });
    }

    const { rows: photos } = await client.query(
      `SELECT id, public_feature_consent, is_featured
         FROM event_photos WHERE id=$1 AND event_id=$2 FOR UPDATE`,
      [req.params.photoId, req.params.eventId]
    );
    if (!photos.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Photo not found' });
    }
    if (featured && !photos[0].public_feature_consent) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This guest shared the photo privately and did not permit public featuring' });
    }
    if (featured && !photos[0].is_featured) {
      const { rows: counts } = await client.query(
        'SELECT COUNT(*)::int AS count FROM event_photos WHERE event_id=$1 AND is_featured=TRUE',
        [req.params.eventId]
      );
      if (counts[0].count >= MAX_FEATURED_PHOTOS) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Feature up to ${MAX_FEATURED_PHOTOS} photos on an event page` });
      }
    }

    const { rows } = await client.query(
      `UPDATE event_photos
          SET is_featured=$3, featured_at=CASE WHEN $3 THEN COALESCE(featured_at,NOW()) ELSE NULL END
        WHERE id=$1 AND event_id=$2
      RETURNING id, public_feature_consent, is_featured, featured_at`,
      [req.params.photoId, req.params.eventId, featured]
    );
    await client.query('COMMIT');
    return res.json({ photo: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/api/events/:eventId/photos/:photoId', requireOrganizer, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM event_photos ep USING events e
        WHERE ep.id=$1 AND ep.event_id=$2 AND e.id=ep.event_id AND e.organizer_id=$3
      RETURNING ep.id, ep.cloudinary_id`,
      [req.params.photoId, req.params.eventId, req.organizer.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Photo not found' });
    await deleteEventPhoto(rows[0].cloudinary_id).catch(err => console.error('[event-photo-delete]', err.message));
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

module.exports = router;
