const express = require('express');
const multer = require('multer');
const pool = require('../config/db');
const requireAdmin = require('../middleware/requireAdmin');
const { requireDedicatedAdmin, requireSuperAdmin, sameOriginMutation } = require('../middleware/requireAdmin');
const { uploadFlyer, deleteManagedPublicId, configured } = require('../lib/cloudinary');
const { IDENTITY_TYPES, normalizeIdentity } = require('../lib/canonical-identity');
const { selectAccentColor } = require('../../public/js/artwork-color');
const { clientIp, createRateLimiter } = require('../lib/rate-limit');
const sms = require('../lib/sms');
const phoneVerification = require('../lib/phone-verification');
const EventBackgrounds = require('../../public/js/event-backgrounds');
const {
  TOKEN_TTL_SECONDS,
  createPreviewToken,
  previewCookieToken,
  readFlyerPreviewAccess,
  readPreviewByToken,
  setPreviewCookie,
  tokenHash
} = require('../lib/flyer-preview-access');
const {
  DoneForYouProvisioningError,
  lookupDoneForYouClient,
  provisionDoneForYouClient
} = require('../lib/admin-done-for-you');
const {
  AdminEditorWorkspaceError,
  openAdminEditorWorkspace,
  setAdminEditorCookie
} = require('../lib/admin-editor-workspace');

const router = express.Router();
const SMS_CONSENT_VERSION = 'dfy-transactional-v1';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 8 },
  fileFilter: (req, file, callback) => {
    callback(null, /^image\/(jpeg|png|webp|gif)$/.test(String(file.mimetype || '')));
  }
});

const intakeLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  rules: [{ name: 'ip', max: 6, key: context => context.ip }]
});

const previewLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  rules: [
    { name: 'ip', max: 80, key: context => context.ip },
    { name: 'token', max: 50, key: context => context.tokenHash }
  ]
});
const previewVerificationLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  rules: [
    { name: 'ip', max: 12, key: context => context.ip },
    { name: 'token', max: 8, key: context => context.tokenHash }
  ]
});

const limiterTimer = setInterval(() => intakeLimiter.prune(), 60 * 60 * 1000);
limiterTimer.unref();
const previewLimiterTimer = setInterval(() => {
  previewLimiter.prune();
  previewVerificationLimiter.prune();
}, 15 * 60 * 1000);
previewLimiterTimer.unref();

function handleFlyerUpload(req, res, next) {
  upload.single('flyer')(req, res, error => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'flyer_too_large', message: 'Choose an image smaller than 5 MB.' });
    }
    return res.status(400).json({ error: 'invalid_flyer', message: 'Choose a JPG, PNG, WebP, or GIF flyer.' });
  });
}

function cleanText(value, maxLength) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  return text.slice(0, maxLength);
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function requestContext(req) {
  return {
    requestIp: String(clientIp(req) || '').slice(0, 100) || null,
    userAgent: String(req.get('user-agent') || '').slice(0, 1000) || null
  };
}

function provisioningError(error, res, next) {
  if (!(error instanceof DoneForYouProvisioningError)) return next(error);
  const safeId = value => positiveId(value);
  const ownerUserIds = Array.isArray(error.ownerUserIds)
    ? [...new Set(error.ownerUserIds.map(safeId).filter(Boolean))]
    : [];
  return res.status(error.status).json({
    error: error.code,
    message: error.message,
    ...(error.expectedUserId !== undefined ? { expectedUserId: error.expectedUserId } : {}),
    ...(error.actualUserId !== undefined ? { actualUserId: error.actualUserId } : {}),
    ...(ownerUserIds.length ? { ownerUserIds } : {}),
    ...(safeId(error.emailOwnerUserId) ? { emailOwnerUserId: safeId(error.emailOwnerUserId) } : {}),
    ...(safeId(error.phoneOwnerUserId) ? { phoneOwnerUserId: safeId(error.phoneOwnerUserId) } : {})
  });
}

async function readFlyerRequest(db, id, { forUpdate = false } = {}) {
  const result = await db.query(
    `SELECT request.*,operator.email AS assigned_admin_email,
            event.slug AS event_slug,event.title AS event_title,event.status AS event_status,
            marker.target_user_id
       FROM admin_flyer_requests request
       LEFT JOIN admin_operators operator ON operator.id=request.assigned_admin_operator_id
       LEFT JOIN events event ON event.id=request.event_id
       LEFT JOIN admin_done_for_you_clients marker ON marker.id=request.done_for_you_client_id
      WHERE request.id=$1
      ${forUpdate ? 'FOR UPDATE OF request' : ''}`,
    [id]
  );
  return result.rows[0] || null;
}

function publicAdminRequest(request) {
  if (!request) return null;
  const {
    preview_token_hash: ignoredPreviewHash,
    ...safe
  } = request;
  return safe;
}

function previewRate(req, res, limiter = previewLimiter) {
  const token = previewCookieToken(req);
  const result = limiter.consume({
    ip: clientIp(req),
    tokenHash: token ? tokenHash(token) : 'missing'
  });
  if (result.allowed) return true;
  res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
  res.status(429).json({
    error: 'too_many_preview_requests',
    message: 'Too many requests. Wait a few minutes and try again.'
  });
  return false;
}

function previewError(res, status, error, message) {
  return res.status(status).json({ error, message });
}

function maskedPhone(phone) {
  const value = String(phone || '');
  return value.length > 4 ? `••• ••• ${value.slice(-4)}` : 'your phone';
}

async function writeFlyerAudit(db, req, request, actionType, beforeState, afterState) {
  await db.query(
    `INSERT INTO admin_account_audit_log
       (actor_user_id,actor_admin_operator_id,target_user_id,action_type,reason,
        before_state,after_state,metadata,request_ip,user_agent)
     VALUES (NULL,$1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)`,
    [
      req.adminOperator.id,
      request.target_user_id || null,
      actionType,
      'Administrator advanced a reviewed Done For You flyer request',
      JSON.stringify(beforeState || {}),
      JSON.stringify(afterState || {}),
      JSON.stringify({ flyerRequestId: Number(request.id) }),
      requestContext(req).requestIp,
      requestContext(req).userAgent
    ]
  );
}

function normalizeSubmission(body) {
  const submitterName = cleanText(body?.submitterName, 160);
  const hostName = cleanText(body?.hostName, 100);
  const artworkCredit = cleanText(body?.artworkCredit, 160) || null;
  if (!submitterName) {
    return { error: 'missing_name', message: 'Tell us what we should call you.' };
  }
  if (!hostName) {
    return { error: 'missing_host_name', message: 'Tell us who is putting on the show.' };
  }
  let email;
  let phone;
  try {
    email = normalizeIdentity(IDENTITY_TYPES.EMAIL, body?.email).normalizedValue;
  } catch (_) {
    return { error: 'invalid_email', message: 'Enter a valid email address.' };
  }
  try {
    phone = normalizeIdentity(IDENTITY_TYPES.PHONE, body?.phone).normalizedValue;
  } catch (_) {
    return { error: 'invalid_phone', message: 'Enter a valid mobile number, including country code.' };
  }
  if (String(body?.smsConsent || '') !== 'yes') {
    return {
      error: 'sms_consent_required',
      message: 'Agree to receive the preview and publication texts for this flyer.'
    };
  }
  return { submitterName, hostName, artworkCredit, email, phone };
}

async function readSettings(db = pool) {
  await db.query(
    `INSERT INTO admin_flyer_intake_settings (singleton,accepting_submissions)
     VALUES (TRUE,FALSE)
     ON CONFLICT (singleton) DO NOTHING`
  );
  const { rows } = await db.query(
    `SELECT accepting_submissions,updated_at
       FROM admin_flyer_intake_settings
      WHERE singleton=TRUE`
  );
  return rows[0] || { accepting_submissions: false, updated_at: null };
}

router.get('/api/flyer-intake', async (req, res, next) => {
  try {
    const settings = await readSettings();
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.json({ acceptingSubmissions: settings.accepting_submissions === true });
  } catch (error) { next(error); }
});

router.post('/api/flyer-intake', async (req, res, next) => {
  if (!sameOriginMutation(req)) return res.status(403).json({ error: 'forbidden' });
  const rate = intakeLimiter.consume({ ip: clientIp(req) });
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)));
    return res.status(429).json({
      error: 'too_many_flyer_submissions',
      message: 'A few flyers have already been sent from this connection. Try again later.'
    });
  }
  const settings = await readSettings().catch(next);
  if (!settings) return;
  if (!settings.accepting_submissions) {
    return res.status(409).json({
      error: 'flyer_intake_closed',
      message: 'Flyer submissions are paused right now.'
    });
  }
  return handleFlyerUpload(req, res, async uploadError => {
    if (uploadError) return next(uploadError);
    if (!req.file) {
      return res.status(400).json({
        error: 'invalid_flyer',
        message: 'Choose a JPG, PNG, WebP, or GIF flyer smaller than 5 MB.'
      });
    }
    const submission = normalizeSubmission(req.body);
    if (submission.error) return res.status(400).json(submission);
    if (!configured) {
      return res.status(503).json({ error: 'uploads_unavailable', message: 'Flyer uploads are temporarily unavailable.' });
    }

    let uploaded = null;
    try {
      // Re-check after upload parsing so a Super Admin pause wins before the
      // external upload and database write.
      const current = await readSettings();
      if (!current.accepting_submissions) {
        return res.status(409).json({
          error: 'flyer_intake_closed',
          message: 'Flyer submissions were just paused. Nothing was submitted.'
        });
      }
      uploaded = await uploadFlyer(req.file.buffer);
      const accentColor = selectAccentColor(uploaded.colors, { fallback: null });
      const { rows } = await pool.query(
        `INSERT INTO admin_flyer_requests
           (submitter_name,host_name,email,phone_e164,artwork_credit,
            flyer_url,flyer_public_id,flyer_accent_color,sms_consent_at,sms_consent_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9)
         RETURNING created_at`,
        [
          submission.submitterName,
          submission.hostName,
          submission.email,
          submission.phone,
          submission.artworkCredit,
          uploaded.secure_url,
          uploaded.public_id,
          accentColor,
          SMS_CONSENT_VERSION
        ]
      );
      res.status(201).json({ ok: true, receivedAt: rows[0].created_at });
    } catch (error) {
      if (uploaded?.public_id) {
        await deleteManagedPublicId(uploaded.public_id).catch(() => {});
      }
      console.error('[flyer-intake]', error.name, error.http_code || '', error.message);
      if (/certificate|self.signed|ECONN|ETIMEDOUT|ENOTFOUND/i.test(error.message)) {
        return res.status(502).json({
          error: 'flyer_upload_failed',
          message: 'We could not reach the image service. Please try again.'
        });
      }
      next(error);
    }
  });
});

// The raw high-entropy token is removed from the address bar immediately. The
// browser keeps it in an HttpOnly, same-site cookie so page scripts cannot read
// or leak it while the recipient reviews the real unpublished event.
router.get('/p/:token', async (req, res, next) => {
  try {
    const preview = await readPreviewByToken(pool, req.params.token);
    if (!preview) return res.status(404).send('Preview not found or expired.');
    const remainingSeconds = Math.max(1, Math.min(
      TOKEN_TTL_SECONDS,
      Math.floor((new Date(preview.preview_token_expires_at).getTime() - Date.now()) / 1000)
    ));
    setPreviewCookie(res, req.params.token, remainingSeconds);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return res.redirect(303, `/e/${encodeURIComponent(preview.event_slug)}?preview=1`);
  } catch (error) { next(error); }
});

router.get('/api/flyer-preview', async (req, res, next) => {
  if (!previewRate(req, res)) return;
  try {
    const preview = await readFlyerPreviewAccess(pool, req);
    if (!preview) return previewError(res, 404, 'preview_not_found', 'This preview has expired. Ask Silver Glider for a new link.');
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      preview: {
        hostName: preview.host_name,
        eventTitle: preview.event_title,
        status: preview.status,
        revision: Number(preview.preview_revision),
        backgroundTheme: preview.background_theme,
        phone: maskedPhone(preview.phone_e164),
        approved: preview.status === 'promoter_approved' || preview.status === 'published',
        published: preview.status === 'published'
      },
      looks: EventBackgrounds.options.map(option => ({
        key: option.key,
        label: EventBackgrounds.label(option.key, 'flyer'),
        group: option.group
      }))
    });
  } catch (error) { next(error); }
});

router.post('/api/flyer-preview/look', async (req, res, next) => {
  if (!sameOriginMutation(req)) return res.status(403).json({ error: 'forbidden' });
  if (!previewRate(req, res)) return;
  const backgroundTheme = String(req.body?.backgroundTheme || '').trim();
  if (!EventBackgrounds.keys.includes(backgroundTheme)) {
    return previewError(res, 400, 'invalid_look', 'Choose one of the available looks.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const preview = await readFlyerPreviewAccess(client, req, { forUpdate: true });
    if (!preview || !['preview_sent', 'changes_requested'].includes(preview.status) || preview.event_status !== 'draft') {
      await client.query('ROLLBACK');
      return previewError(res, 409, 'preview_not_editable', 'This preview can no longer be changed.');
    }
    const updated = (await client.query(
      `UPDATE events
          SET background_theme=$1,updated_at=NOW()
        WHERE id=$2 AND status='draft' AND presentation_mode='flyer'
        RETURNING background_theme`,
      [backgroundTheme, preview.event_id]
    )).rows[0];
    if (!updated) {
      await client.query('ROLLBACK');
      return previewError(res, 409, 'preview_not_editable', 'This flyer preview can no longer be changed.');
    }
    await client.query('UPDATE admin_flyer_requests SET updated_at=NOW() WHERE id=$1', [preview.id]);
    await client.query('COMMIT');
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, backgroundTheme: updated.background_theme });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

router.post('/api/flyer-preview/fix', async (req, res, next) => {
  if (!sameOriginMutation(req)) return res.status(403).json({ error: 'forbidden' });
  if (!previewRate(req, res)) return;
  const message = cleanText(req.body?.message, 1000);
  if (!message) return previewError(res, 400, 'missing_fix_request', 'Tell us what you would like changed.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const preview = await readFlyerPreviewAccess(client, req, { forUpdate: true });
    if (!preview || preview.status !== 'preview_sent' || preview.event_status !== 'draft') {
      await client.query('ROLLBACK');
      return previewError(res, 409, 'fix_request_unavailable', 'This preview is not waiting for changes.');
    }
    await client.query(
      `UPDATE admin_flyer_requests
          SET status='changes_requested',latest_fix_request=$2,
              changes_requested_at=NOW(),updated_at=NOW()
        WHERE id=$1`,
      [preview.id, message]
    );
    await client.query(
      `UPDATE admin_flyer_request_phone_challenges
          SET superseded_at=NOW()
        WHERE flyer_request_id=$1 AND verified_at IS NULL AND superseded_at IS NULL`,
      [preview.id]
    );
    await client.query('COMMIT');
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, status: 'changes_requested' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

router.post('/api/flyer-preview/approve/start', async (req, res, next) => {
  if (!sameOriginMutation(req)) return res.status(403).json({ error: 'forbidden' });
  if (!previewRate(req, res, previewVerificationLimiter)) return;
  try {
    const preview = await readFlyerPreviewAccess(pool, req);
    if (!preview || preview.status !== 'preview_sent' || preview.event_status !== 'draft') {
      return previewError(res, 409, 'approval_unavailable', 'This preview is not ready for approval.');
    }
    const verification = await phoneVerification.startVerification(preview.phone_e164);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await readFlyerPreviewAccess(client, req, { forUpdate: true });
      if (!locked || locked.status !== 'preview_sent' || locked.event_status !== 'draft' ||
          locked.phone_e164 !== verification.phone) {
        await client.query('ROLLBACK');
        return previewError(res, 409, 'approval_unavailable', 'This preview changed. Open the latest link and try again.');
      }
      await client.query(
        `UPDATE admin_flyer_request_phone_challenges
            SET superseded_at=NOW()
          WHERE flyer_request_id=$1 AND verified_at IS NULL AND superseded_at IS NULL`,
        [locked.id]
      );
      await client.query(
        `INSERT INTO admin_flyer_request_phone_challenges
           (flyer_request_id,preview_revision,provider_sid,phone_e164,expires_at)
         VALUES ($1,$2,$3,$4,NOW() + INTERVAL '10 minutes')`,
        [locked.id, locked.preview_revision, verification.verificationSid, verification.phone]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, phone: maskedPhone(preview.phone_e164), codeLength: 6 });
  } catch (error) {
    if (error instanceof phoneVerification.PhoneVerificationError) {
      return previewError(res, error.status, error.code, error.message);
    }
    next(error);
  }
});

router.post('/api/flyer-preview/approve/verify', async (req, res, next) => {
  if (!sameOriginMutation(req)) return res.status(403).json({ error: 'forbidden' });
  if (!previewRate(req, res, previewVerificationLimiter)) return;
  let preview;
  let challenge;
  try {
    preview = await readFlyerPreviewAccess(pool, req);
    if (!preview || preview.status !== 'preview_sent' || preview.event_status !== 'draft') {
      return previewError(res, 409, 'approval_unavailable', 'This preview is not ready for approval.');
    }
    challenge = (await pool.query(
      `SELECT * FROM admin_flyer_request_phone_challenges
        WHERE flyer_request_id=$1 AND verified_at IS NULL AND superseded_at IS NULL
          AND expires_at>NOW() AND verification_attempts<5
        ORDER BY created_at DESC LIMIT 1`,
      [preview.id]
    )).rows[0];
    if (!challenge) return previewError(res, 400, 'verification_expired', 'Request a new verification code.');

    const verification = await phoneVerification.checkVerification({
      verificationSid: challenge.provider_sid,
      code: req.body?.code
    });
    if (verification.phone !== preview.phone_e164) {
      return previewError(res, 400, 'verification_mismatch', 'Phone verification could not be completed.');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lockedPreview = await readFlyerPreviewAccess(client, req, { forUpdate: true });
      const lockedChallenge = (await client.query(
        `SELECT * FROM admin_flyer_request_phone_challenges
          WHERE id=$1 FOR UPDATE`,
        [challenge.id]
      )).rows[0];
      if (!lockedPreview || lockedPreview.status !== 'preview_sent' ||
          !lockedChallenge || lockedChallenge.verified_at || lockedChallenge.superseded_at ||
          lockedChallenge.provider_sid !== verification.verificationSid ||
          Number(lockedChallenge.preview_revision) !== Number(lockedPreview.preview_revision) ||
          lockedChallenge.phone_e164 !== verification.phone ||
          new Date(lockedChallenge.expires_at).getTime() <= Date.now()) {
        await client.query('ROLLBACK');
        return previewError(res, 409, 'verification_expired', 'This verification is no longer active.');
      }
      await client.query(
        'UPDATE admin_flyer_request_phone_challenges SET verified_at=NOW() WHERE id=$1',
        [lockedChallenge.id]
      );
      await client.query(
        `UPDATE admin_flyer_requests
            SET status='promoter_approved',phone_verified_at=NOW(),
                promoter_approved_at=NOW(),updated_at=NOW()
          WHERE id=$1`,
        [lockedPreview.id]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, status: 'promoter_approved' });
  } catch (error) {
    if (challenge && error instanceof phoneVerification.PhoneVerificationError && error.status === 400) {
      await pool.query(
        `UPDATE admin_flyer_request_phone_challenges
            SET verification_attempts=LEAST(5,verification_attempts+1)
          WHERE id=$1 AND verified_at IS NULL AND superseded_at IS NULL`,
        [challenge.id]
      ).catch(() => {});
    }
    if (error instanceof phoneVerification.PhoneVerificationError) {
      return previewError(res, error.status, error.code, error.message);
    }
    next(error);
  }
});

router.use('/api/admin/done-for-you/flyer-intake', requireAdmin, requireDedicatedAdmin);

router.get('/api/admin/done-for-you/flyer-intake', async (req, res, next) => {
  try {
    const [settings, requestResult, metricResult] = await Promise.all([
      readSettings(),
      pool.query(
        `SELECT request.id,request.submitter_name,request.host_name,request.email,
                request.phone_e164,request.artwork_credit,request.flyer_url,
                request.flyer_accent_color,request.status,request.done_for_you_client_id,
                request.event_id,request.created_at,request.started_at,
                request.ready_for_review_at,request.preview_sent_at,
                request.promoter_approved_at,request.claimed_at,request.published_at,
                operator.email AS assigned_admin_email
           FROM admin_flyer_requests request
           LEFT JOIN admin_operators operator ON operator.id=request.assigned_admin_operator_id
          ORDER BY request.created_at DESC
          LIMIT 100`
      ),
      pool.query(
        `SELECT COUNT(*)::int AS submission_count,
                COUNT(*) FILTER (WHERE status='published')::int AS published_count,
                COUNT(*) FILTER (WHERE claimed_at IS NOT NULL)::int AS claimed_count,
                COUNT(*) FILTER (WHERE preview_sent_at IS NOT NULL)::int AS previewed_count,
                EXTRACT(EPOCH FROM percentile_cont(0.5) WITHIN GROUP (
                  ORDER BY (ready_for_review_at-created_at)
                ))::int AS median_creation_seconds
           FROM admin_flyer_requests`
      )
    ]);
    const metrics = metricResult.rows[0] || {};
    const previewed = Number(metrics.previewed_count) || 0;
    const claimed = Number(metrics.claimed_count) || 0;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      settings: {
        acceptingSubmissions: settings.accepting_submissions === true,
        updatedAt: settings.updated_at
      },
      metrics: {
        submissionCount: Number(metrics.submission_count) || 0,
        publishedCount: Number(metrics.published_count) || 0,
        medianCreationSeconds: metrics.median_creation_seconds == null
          ? null
          : Number(metrics.median_creation_seconds),
        claimRate: previewed ? claimed / previewed : null
      },
      requests: requestResult.rows,
      capabilities: { manageIntake: req.adminOperator.role === 'super_admin' }
    });
  } catch (error) { next(error); }
});

router.patch(
  '/api/admin/done-for-you/flyer-intake/settings',
  requireSuperAdmin,
  async (req, res, next) => {
    if (typeof req.body?.acceptingSubmissions !== 'boolean') {
      return res.status(400).json({
        error: 'invalid_accepting_submissions',
        message: 'Choose whether flyer submissions are on or off.'
      });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT accepting_submissions FROM admin_flyer_intake_settings
          WHERE singleton=TRUE FOR UPDATE`
      );
      const before = current.rows[0]?.accepting_submissions === true;
      const updated = await client.query(
        `UPDATE admin_flyer_intake_settings
            SET accepting_submissions=$1,updated_by_admin_operator_id=$2,updated_at=NOW()
          WHERE singleton=TRUE
          RETURNING accepting_submissions,updated_at`,
        [req.body.acceptingSubmissions, req.adminOperator.id]
      );
      await client.query(
        `INSERT INTO admin_account_audit_log
           (actor_user_id,actor_admin_operator_id,target_user_id,action_type,reason,
            before_state,after_state,metadata,request_ip,user_agent)
         VALUES (NULL,$1,NULL,'flyer_intake_toggled','Super Admin flyer intake control',
                 $2::jsonb,$3::jsonb,'{}'::jsonb,$4,$5)`,
        [
          req.adminOperator.id,
          JSON.stringify({ acceptingSubmissions: before }),
          JSON.stringify({ acceptingSubmissions: updated.rows[0].accepting_submissions === true }),
          String(clientIp(req) || '').slice(0, 100) || null,
          String(req.get('user-agent') || '').slice(0, 1000) || null
        ]
      );
      await client.query('COMMIT');
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({
        settings: {
          acceptingSubmissions: updated.rows[0].accepting_submissions === true,
          updatedAt: updated.rows[0].updated_at
        }
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally { client.release(); }
  }
);

router.get('/api/admin/done-for-you/flyer-intake/:id', async (req, res, next) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(404).json({ error: 'flyer_request_not_found' });
  try {
    const request = await readFlyerRequest(pool, id);
    if (!request) return res.status(404).json({ error: 'flyer_request_not_found' });
    const lookup = request.done_for_you_client_id == null
      ? await lookupDoneForYouClient(pool, {
        email: request.email,
        phone: request.phone_e164
      })
      : {
        expectedUserId: request.target_user_id == null ? null : Number(request.target_user_id),
        matched: request.target_user_id != null,
        matchedBy: ['linked_done_for_you_client'],
        account: null
      };
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      request: publicAdminRequest(request),
      lookup,
      capabilities: {
        manageIntake: req.adminOperator.role === 'super_admin',
        sendPreview: req.adminOperator.role === 'super_admin',
        publish: req.adminOperator.role === 'super_admin'
      }
    });
  } catch (error) { provisioningError(error, res, next); }
});

router.post('/api/admin/done-for-you/flyer-intake/:id/prepare', async (req, res, next) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(404).json({ error: 'flyer_request_not_found' });
  if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'expectedUserId')) {
    return res.status(409).json({
      error: 'done_for_you_lookup_required',
      message: 'Review the exact account match before preparing this flyer.'
    });
  }
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    const request = await readFlyerRequest(connection, id, { forUpdate: true });
    if (!request) {
      await connection.query('ROLLBACK');
      return res.status(404).json({ error: 'flyer_request_not_found' });
    }
    if (!['submitted', 'building', 'changes_requested'].includes(request.status)) {
      await connection.query('ROLLBACK');
      return res.status(409).json({
        error: 'flyer_request_not_preparable',
        message: 'This flyer request has already moved beyond setup.'
      });
    }

    let preparedClient = null;
    if (request.done_for_you_client_id == null) {
      preparedClient = await provisionDoneForYouClient(pool, {
        actorAdminOperatorId: req.adminOperator.id,
        expectedUserId: req.body.expectedUserId,
        hostName: request.host_name,
        contactName: request.submitter_name,
        email: request.email,
        phone: request.phone_e164,
        ...requestContext(req)
      });
    } else {
      const marker = await connection.query(
        `SELECT marker.id,marker.target_user_id,organizer.id AS organizer_id
           FROM admin_done_for_you_clients marker
           JOIN users target ON target.id=marker.target_user_id AND target.account_status='active'
           JOIN organizers organizer ON organizer.user_id=target.id
          WHERE marker.id=$1`,
        [request.done_for_you_client_id]
      );
      if (!marker.rows[0]) {
        throw new DoneForYouProvisioningError(
          'done_for_you_client_not_available',
          'The client linked to this flyer is no longer available.',
          409
        );
      }
      preparedClient = {
        id: Number(marker.rows[0].id),
        userId: Number(marker.rows[0].target_user_id),
        organizerId: Number(marker.rows[0].organizer_id),
        noOp: true
      };
    }

    const updated = (await connection.query(
      `UPDATE admin_flyer_requests
          SET done_for_you_client_id=$2,
              assigned_admin_operator_id=COALESCE(assigned_admin_operator_id,$3),
              started_at=COALESCE(started_at,NOW()),
              status=CASE WHEN status='submitted' THEN 'building' ELSE status END,
              updated_at=NOW()
        WHERE id=$1
        RETURNING *`,
      [id, preparedClient.id, req.adminOperator.id]
    )).rows[0];
    updated.target_user_id = preparedClient.userId;
    await writeFlyerAudit(connection, req, updated, 'flyer_request_preparation_started', {
      status: request.status,
      doneForYouClientId: request.done_for_you_client_id
    }, {
      status: updated.status,
      doneForYouClientId: Number(updated.done_for_you_client_id)
    });
    await connection.query('COMMIT');
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ request: updated, client: preparedClient });
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => {});
    provisioningError(error, res, next);
  } finally { connection.release(); }
});

router.post('/api/admin/done-for-you/flyer-intake/:id/editor-workspace', async (req, res, next) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(404).json({ error: 'flyer_request_not_found' });
  try {
    const request = await readFlyerRequest(pool, id);
    if (!request || request.done_for_you_client_id == null ||
        !['building', 'changes_requested', 'ready_for_review'].includes(request.status)) {
      return res.status(409).json({
        error: 'flyer_request_not_ready_for_editor',
        message: 'Prepare this flyer request before opening the event editor.'
      });
    }
    if (request.event_id != null && request.event_status !== 'draft') {
      return res.status(409).json({
        error: 'flyer_request_event_not_editable',
        message: 'The event connected to this request is no longer an unpublished draft.'
      });
    }
    const opened = await openAdminEditorWorkspace(pool, {
      doneForYouClientId: Number(request.done_for_you_client_id),
      actorAdminOperatorId: req.adminOperator.id,
      sessionIssuedAt: req.adminSession.issuedAt,
      eventId: request.event_id == null ? null : Number(request.event_id),
      flyerRequestId: id,
      ...requestContext(req)
    });
    setAdminEditorCookie(res, opened.token);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(201).json({
      workspace: opened.workspace,
      redirect: request.event_id == null
        ? '/admin-editor/events/new'
        : `/admin-editor/events/new?id=${Number(request.event_id)}&advanced=1`
    });
  } catch (error) {
    if (!(error instanceof AdminEditorWorkspaceError)) return next(error);
    res.status(error.status).json({ error: error.code, message: error.message });
  }
});

router.post('/api/admin/done-for-you/flyer-intake/:id/ready', async (req, res, next) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(404).json({ error: 'flyer_request_not_found' });
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    const request = await readFlyerRequest(connection, id, { forUpdate: true });
    if (!request || request.event_id == null ||
        !['building', 'changes_requested'].includes(request.status)) {
      await connection.query('ROLLBACK');
      return res.status(409).json({
        error: 'flyer_request_not_ready',
        message: 'Finish the unpublished event draft before sending it for review.'
      });
    }
    if (request.event_status !== 'draft') {
      await connection.query('ROLLBACK');
      return res.status(409).json({
        error: 'flyer_request_event_not_editable',
        message: 'Only an unpublished draft can be sent for review.'
      });
    }
    const updated = (await connection.query(
      `UPDATE admin_flyer_requests
          SET status='ready_for_review',ready_for_review_at=NOW(),updated_at=NOW(),
              preview_revision=preview_revision + CASE WHEN status='changes_requested' THEN 1 ELSE 0 END
        WHERE id=$1
        RETURNING *`,
      [id]
    )).rows[0];
    await writeFlyerAudit(connection, req, request, 'flyer_request_ready_for_review', {
      status: request.status,
      previewRevision: Number(request.preview_revision)
    }, {
      status: updated.status,
      previewRevision: Number(updated.preview_revision)
    });
    await connection.query('COMMIT');
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ request: updated });
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { connection.release(); }
});

router.post(
  '/api/admin/done-for-you/flyer-intake/:id/send-preview',
  requireSuperAdmin,
  async (req, res, next) => {
    const id = positiveId(req.params.id);
    if (!id) return res.status(404).json({ error: 'flyer_request_not_found' });
    const rawToken = createPreviewToken();
    const appUrl = String(process.env.APP_URL || '').replace(/\/$/, '');
    if (!appUrl) return res.status(503).json({ error: 'app_url_not_configured', message: 'Preview links are not configured.' });
    const client = await pool.connect();
    let request;
    let messageId;
    try {
      await client.query('BEGIN');
      request = await readFlyerRequest(client, id, { forUpdate: true });
      if (!request || request.status !== 'ready_for_review' || request.event_status !== 'draft') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'flyer_preview_not_ready',
          message: 'The real unpublished event must be ready for Super Admin review first.'
        });
      }
      const prior = (await client.query(
        `SELECT * FROM admin_flyer_request_messages
          WHERE flyer_request_id=$1 AND message_kind='preview' AND revision=$2
          FOR UPDATE`,
        [id, request.preview_revision]
      )).rows[0];
      if (prior?.status === 'sent' ||
          (prior?.status === 'sending' && Date.now() - new Date(prior.created_at).getTime() < 10 * 60 * 1000)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'flyer_preview_already_sent',
          message: 'This preview revision has already been sent.'
        });
      }
      const ledger = (await client.query(
        `INSERT INTO admin_flyer_request_messages
           (flyer_request_id,message_kind,revision,recipient,status,initiated_by_admin_operator_id)
         VALUES ($1,'preview',$2,$3,'sending',$4)
         ON CONFLICT (flyer_request_id,message_kind,revision)
         DO UPDATE SET recipient=EXCLUDED.recipient,status='sending',provider_id=NULL,
                       error=NULL,initiated_by_admin_operator_id=EXCLUDED.initiated_by_admin_operator_id,
                       created_at=NOW(),sent_at=NULL
         RETURNING id`,
        [id, request.preview_revision, request.phone_e164, req.adminOperator.id]
      )).rows[0];
      messageId = Number(ledger.id);
      await client.query(
        `UPDATE admin_flyer_requests
            SET preview_token_hash=$2,
                preview_token_expires_at=NOW() + INTERVAL '7 days',updated_at=NOW()
          WHERE id=$1`,
        [id, tokenHash(rawToken)]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      return next(error);
    }
    client.release();

    const link = `${appUrl}/p/${rawToken}`;
    const body = `Your Silver Glider event page is ready! 🎸\nPreview and approve it here: ${link}`;
    try {
      const delivered = await sms.sendSms({ to: request.phone_e164, body });
      const saved = await pool.connect();
      try {
        await saved.query('BEGIN');
        const updated = (await saved.query(
          `UPDATE admin_flyer_requests
              SET status='preview_sent',preview_sent_at=NOW(),updated_at=NOW()
            WHERE id=$1 AND status='ready_for_review'
            RETURNING *`,
          [id]
        )).rows[0];
        if (!updated) throw new Error('Flyer request changed while the preview text was sending');
        await saved.query(
          `UPDATE admin_flyer_request_messages
              SET status='sent',provider_id=$2,sent_at=NOW()
            WHERE id=$1 AND status='sending'`,
          [messageId, delivered.sid]
        );
        updated.target_user_id = request.target_user_id;
        await writeFlyerAudit(saved, req, updated, 'flyer_preview_sent', {
          status: request.status,
          previewRevision: Number(request.preview_revision)
        }, {
          status: 'preview_sent',
          previewRevision: Number(request.preview_revision)
        });
        await saved.query('COMMIT');
        res.setHeader('Cache-Control', 'private, no-store');
        return res.json({ request: publicAdminRequest(updated), message: { status: 'sent' } });
      } catch (error) {
        await saved.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { saved.release(); }
    } catch (error) {
      await pool.query(
        `UPDATE admin_flyer_request_messages
            SET status='failed',error=$2
          WHERE id=$1 AND status='sending'`,
        [messageId, cleanText(error.message, 500) || 'SMS delivery failed']
      ).catch(() => {});
      return next(error);
    }
  }
);

module.exports = router;
module.exports.resetRateLimitsForTests = () => {
  intakeLimiter.reset();
  previewLimiter.reset();
  previewVerificationLimiter.reset();
};
module.exports._test = { normalizeSubmission, readSettings, SMS_CONSENT_VERSION };
