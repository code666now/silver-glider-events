const express = require('express');
const pool = require('../config/db');
const requireOrganizer = require('../middleware/requireOrganizer');
const { clientIp, createRateLimiter } = require('../lib/rate-limit');
const { buildPostEventThankYouEmail } = require('../lib/mailer');
const {
  PostEventError,
  defaultThankYouDraft,
  draftDigest,
  emailRenderSnapshot,
  eligibleThankYouAudience,
  loadPostEventContext,
  loadThankYouBatch,
  loadTurnout,
  normalizeDraft,
  renderSnapshotDigest,
  requireEndedPublished,
  serializeThankYou,
  signPreviewToken,
  verifyPreviewToken
} = require('../lib/post-event');
const { queuePostEventThankYouBatch } = require('../jobs/post-event-thank-yous');

const router = express.Router();
router.use('/api/events', requireOrganizer);

const previewLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  rules: [
    { name: 'account', max: 30, key: context => context.organizerId },
    { name: 'network', max: 60, key: context => context.ip }
  ]
});
const sendLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  rules: [
    { name: 'account', max: 5, key: context => context.organizerId },
    { name: 'network', max: 15, key: context => context.ip }
  ]
});
const pruneTimer = setInterval(() => {
  previewLimiter.prune();
  sendLimiter.prune();
}, 15 * 60 * 1000);
pruneTimer.unref?.();

function eventId(req) {
  const value = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(value) || value < 1 || String(value) !== String(req.params.id)) {
    throw new PostEventError(404, 'event_not_found', 'Event not found');
  }
  return value;
}

function consumeRateLimit(limiter, req, res) {
  const result = limiter.consume({ organizerId: req.organizer.id, ip: clientIp(req) });
  if (result.allowed) return true;
  res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
  res.status(429).json({ error: 'Too many requests. Try again shortly.', code: 'rate_limited' });
  return false;
}

async function loadState(db, context) {
  const [draw, batch, audience] = await Promise.all([
    loadTurnout(db, context.event.id),
    loadThankYouBatch(db, context.event.id),
    eligibleThankYouAudience(db, {
      eventId: context.event.id,
      organizerId: context.event.organizer_id
    })
  ]);
  const draft = batch || defaultThankYouDraft(context.event, context.host);
  return {
    ended: context.ended,
    stats: context.stats,
    draw,
    thankYou: serializeThankYou({ batch, draft, audience, host: context.host })
  };
}

function handleError(error, res, next) {
  if (error instanceof PostEventError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  return next(error);
}

// GET /api/events/:id/post-event — private post-event state for the owner.
router.get('/api/events/:id/post-event', async (req, res, next) => {
  try {
    const context = await loadPostEventContext(pool, {
      eventId: eventId(req),
      organizerId: req.organizer.id
    });
    if (!context) throw new PostEventError(404, 'event_not_found', 'Event not found');
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await loadState(pool, context));
  } catch (error) { handleError(error, res, next); }
});

// PATCH /api/events/:id/post-event/turnout — private, explicitly unverified
// host estimate. The authenticated session supplies the attribution.
router.patch('/api/events/:id/post-event/turnout', async (req, res, next) => {
  const estimate = req.body?.estimatedTurnout;
  if (!Number.isInteger(estimate) || estimate < 0 || estimate > 100000) {
    return res.status(400).json({
      error: 'Estimated turnout must be a whole number between 0 and 100,000',
      code: 'invalid_turnout'
    });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const context = requireEndedPublished(await loadPostEventContext(client, {
      eventId: eventId(req),
      organizerId: req.organizer.id,
      lock: true
    }));
    const { rows } = await client.query(
      `INSERT INTO event_turnout_estimates
         (event_id,estimated_turnout,submitted_by_user_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (event_id) DO UPDATE
         SET estimated_turnout=EXCLUDED.estimated_turnout,
             submitted_by_user_id=EXCLUDED.submitted_by_user_id,
             updated_at=NOW()
       RETURNING estimated_turnout,updated_at`,
      [context.event.id, estimate, req.organizer.user_id || req.organizer.id]
    );
    await client.query('COMMIT');
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      draw: {
        estimatedTurnout: Number(rows[0].estimated_turnout),
        updatedAt: rows[0].updated_at
      }
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    handleError(error, res, next);
  } finally {
    client.release();
  }
});

// PUT /api/events/:id/post-event/thank-you — save the one event draft. Once
// approved, its content is immutable and a second send cannot be created.
router.put('/api/events/:id/post-event/thank-you', async (req, res, next) => {
  let draft;
  try { draft = normalizeDraft(req.body); } catch (error) { return handleError(error, res, next); }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const context = requireEndedPublished(await loadPostEventContext(client, {
      eventId: eventId(req),
      organizerId: req.organizer.id,
      lock: true
    }));
    if (draft.includeFollow && !context.host.public_slug) {
      throw new PostEventError(400, 'host_page_required', 'Set up your Host Page before including a follow invitation');
    }
    const { rows } = await client.query(
      `INSERT INTO post_event_thank_you_batches
         (event_id,organizer_id,subject,message,include_follow)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (event_id) DO UPDATE
         SET subject=EXCLUDED.subject,message=EXCLUDED.message,
             include_follow=EXCLUDED.include_follow,updated_at=NOW()
       WHERE post_event_thank_you_batches.status='draft'
       RETURNING *`,
      [context.event.id, req.organizer.id, draft.subject, draft.message, draft.includeFollow]
    );
    if (!rows.length) {
      throw new PostEventError(409, 'thank_you_already_approved', 'This event’s thank-you has already been approved');
    }
    const audience = await eligibleThankYouAudience(client, {
      eventId: context.event.id,
      organizerId: req.organizer.id
    });
    await client.query('COMMIT');
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      thankYou: serializeThankYou({ batch: rows[0], draft, audience, host: context.host })
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    handleError(error, res, next);
  } finally {
    client.release();
  }
});

// POST /api/events/:id/post-event/thank-you/preview — render the saved draft
// without delivery. The signed token binds its exact content and audience.
router.post('/api/events/:id/post-event/thank-you/preview', async (req, res, next) => {
  if (!consumeRateLimit(previewLimiter, req, res)) return;
  try {
    const draft = normalizeDraft(req.body);
    const context = requireEndedPublished(await loadPostEventContext(pool, {
      eventId: eventId(req),
      organizerId: req.organizer.id
    }));
    const batch = await loadThankYouBatch(pool, context.event.id);
    if (!batch || batch.status !== 'draft') {
      throw new PostEventError(409, 'draft_unavailable', 'Save an unsent draft before previewing');
    }
    if (draftDigest(draft) !== draftDigest({
      subject: batch.subject,
      message: batch.message,
      includeFollow: batch.include_follow
    })) {
      throw new PostEventError(409, 'draft_not_saved', 'Save your latest changes before previewing');
    }
    if (draft.includeFollow && !context.host.public_slug) {
      throw new PostEventError(400, 'host_page_required', 'Set up your Host Page before including a follow invitation');
    }
    const audience = await eligibleThankYouAudience(pool, {
      eventId: context.event.id,
      organizerId: req.organizer.id
    });
    const followEligible = audience.recipients.filter(recipient => recipient.consentScope === 'host');
    const allAlreadyFollowing = followEligible.length === 0 ||
      followEligible.every(recipient => recipient.alreadyFollowing);
    const renderSnapshot = emailRenderSnapshot(context.event, context.host);
    const renderHash = renderSnapshotDigest(renderSnapshot);
    const rendered = buildPostEventThankYouEmail({
      event: renderSnapshot.event,
      host: renderSnapshot.host,
      ...draft,
      alreadyFollowing: allAlreadyFollowing,
      consentScope: followEligible.length > 0 ? 'host' : 'event'
    });
    const previewToken = signPreviewToken({
      eventId: context.event.id,
      batchId: batch.id,
      draftHash: draftDigest(draft),
      audienceHash: audience.audienceHash,
      renderHash
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      html: rendered.html,
      eligibleCount: audience.eligibleCount,
      previewToken
    });
  } catch (error) { handleError(error, res, next); }
});

// POST /api/events/:id/post-event/thank-you/send — approve exactly the draft
// and audience that were previewed. Delivery happens through the retry worker.
router.post('/api/events/:id/post-event/thank-you/send', async (req, res, next) => {
  if (!consumeRateLimit(sendLimiter, req, res)) return;
  const token = String(req.body?.previewToken || '');
  if (!token || token.length > 4096) {
    return res.status(400).json({ error: 'Preview this email before sending', code: 'preview_required' });
  }
  const preview = verifyPreviewToken(token);
  if (!preview) {
    return res.status(409).json({ error: 'That preview expired. Preview again before sending.', code: 'stale_preview' });
  }

  const client = await pool.connect();
  let batchId = null;
  try {
    await client.query('BEGIN');
    const context = requireEndedPublished(await loadPostEventContext(client, {
      eventId: eventId(req),
      organizerId: req.organizer.id,
      lock: true
    }));
    const batch = await loadThankYouBatch(client, context.event.id, { lock: true });
    if (!batch || batch.status !== 'draft') {
      throw new PostEventError(409, 'thank_you_already_approved', 'This event’s thank-you has already been approved');
    }
    const audience = await eligibleThankYouAudience(client, {
      eventId: context.event.id,
      organizerId: req.organizer.id
    });
    const currentDraftHash = draftDigest({
      subject: batch.subject,
      message: batch.message,
      includeFollow: batch.include_follow
    });
    const renderSnapshot = emailRenderSnapshot(context.event, context.host);
    const renderHash = renderSnapshotDigest(renderSnapshot);
    if (preview.eventId !== context.event.id || preview.batchId !== String(batch.id) ||
        preview.draftHash !== currentDraftHash || preview.audienceHash !== audience.audienceHash ||
        preview.renderHash !== renderHash) {
      throw new PostEventError(409, 'stale_preview', 'The draft or audience changed. Preview again before sending.');
    }
    if (!audience.recipients.length) {
      throw new PostEventError(409, 'no_eligible_recipients', 'No confirmed guests currently have verified email permission for this thank-you');
    }

    for (const recipient of audience.recipients) {
      await client.query(
        `INSERT INTO message_log
           (rsvp_id,event_id,post_event_thank_you_batch_id,recipient,recipient_name,
            recipient_user_id,message_type,channel,status,post_event_already_following,
            post_event_consent_scope)
         VALUES ($1,$2,$3,$4,$5,$6,'post_event_thank_you','email','pending',$7,$8)
         ON CONFLICT DO NOTHING`,
        [recipient.rsvpId, context.event.id, batch.id, recipient.email,
         recipient.name, recipient.userId, recipient.alreadyFollowing, recipient.consentScope]
      );
    }
    const { rows } = await client.query(
      `UPDATE post_event_thank_you_batches
          SET status='pending',recipient_count=$2,skipped_count=$3,
              approved_by_user_id=$4,render_snapshot=$5::jsonb,render_snapshot_hash=$6,
              approved_at=NOW(),updated_at=NOW()
        WHERE id=$1 AND status='draft'
        RETURNING *`,
      [batch.id, audience.eligibleCount, audience.skippedCount,
       req.organizer.user_id || req.organizer.id,
       JSON.stringify(renderSnapshot), renderHash]
    );
    if (!rows.length) {
      throw new PostEventError(409, 'thank_you_already_approved', 'This event’s thank-you has already been approved');
    }
    batchId = batch.id;
    await client.query('COMMIT');
    const thankYou = serializeThankYou({ batch: rows[0], audience, host: context.host });
    queuePostEventThankYouBatch(batchId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(202).json({ thankYou });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    handleError(error, res, next);
  } finally {
    client.release();
  }
});

router._resetRateLimitsForTests = () => {
  previewLimiter.reset();
  sendLimiter.reset();
};

module.exports = router;
