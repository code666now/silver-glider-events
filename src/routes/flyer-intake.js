const express = require('express');
const multer = require('multer');
const pool = require('../config/db');
const requireAdmin = require('../middleware/requireAdmin');
const { requireDedicatedAdmin, requireSuperAdmin, sameOriginMutation } = require('../middleware/requireAdmin');
const { uploadFlyer, deleteManagedPublicId, configured } = require('../lib/cloudinary');
const { IDENTITY_TYPES, normalizeIdentity } = require('../lib/canonical-identity');
const { selectAccentColor } = require('../../public/js/artwork-color');
const { clientIp, createRateLimiter } = require('../lib/rate-limit');

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

const limiterTimer = setInterval(() => intakeLimiter.prune(), 60 * 60 * 1000);
limiterTimer.unref();

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

module.exports = router;
module.exports._test = { normalizeSubmission, readSettings, SMS_CONSENT_VERSION };
