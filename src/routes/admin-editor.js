const express = require('express');
const multer = require('multer');
const path = require('path');
const pool = require('../config/db');
const requireAdmin = require('../middleware/requireAdmin');
const { requireDedicatedAdmin } = require('../middleware/requireAdmin');
const requireAdminEditorWorkspace = require('../middleware/requireAdminEditorWorkspace');
const { clientIp } = require('../lib/rate-limit');
const { outboundDeliveryLockKey } = require('../lib/outbound-account-status');
const { commerceAdmissionEnabled } = require('../lib/commerce-client');
const unsplash = require('../lib/unsplash');
const cloudinary = require('../lib/cloudinary');
const { selectAccentColor } = require('../../public/js/artwork-color');
const {
  EventEditorError,
  createEventInTransaction,
  getEventForEditor,
  publishEventInTransaction,
  updateEventInTransaction
} = require('../lib/event-editor');
const {
  AdminEditorWorkspaceError,
  bindAdminEditorWorkspaceEventInTransaction,
  clearAdminEditorCookie,
  completeAdminEditorWorkspaceInTransaction,
  exitAdminEditorWorkspace,
  writeAdminEditorAudit
} = require('../lib/admin-editor-workspace');

const router = express.Router();
const VIEWS = path.join(__dirname, '..', 'views');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    callback(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype));
  }
});

let eventUploads = {
  configured: cloudinary.configured,
  cover: cloudinary.uploadCover,
  flyer: cloudinary.uploadFlyer,
  vibe: cloudinary.uploadVibePhoto
};

router.use(requireAdmin, requireDedicatedAdmin, requireAdminEditorWorkspace);

function requestContext(req) {
  return {
    requestIp: String(clientIp(req) || '').slice(0, 100) || null,
    userAgent: String(req.get('user-agent') || '').slice(0, 1000) || null
  };
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function placesApiKey() {
  return String(
    process.env.GOOGLE_PLACES_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_MAPS_BROWSER_KEY ||
    ''
  ).trim();
}

function editorRedirect(workspace) {
  return `/admin/done-for-you/${workspace.doneForYouClientId}`;
}

function sendEditorError(error, res, next) {
  if (error instanceof EventEditorError || error instanceof AdminEditorWorkspaceError) {
    return res.status(error.status).json({ error: error.code, message: error.message });
  }
  return next(error);
}

function requireUnboundWorkspace(req, res, next) {
  if (req.adminEditorWorkspace.eventId == null) return next();
  return res.status(409).json({
    error: 'admin_editor_workspace_already_bound',
    message: 'This editor workspace is already connected to an event.'
  });
}

function requireBoundWorkspace(req, res, next) {
  if (req.adminEditorWorkspace.eventId != null) return next();
  return res.status(409).json({
    error: 'admin_editor_workspace_not_bound',
    message: 'Create the event basics before opening the advanced editor.'
  });
}

function requireExactEvent(req, res, next) {
  const eventId = positiveId(req.params.id);
  if (eventId && eventId === Number(req.adminEditorWorkspace.eventId)) return next();
  return res.status(404).json({ error: 'event_not_found', message: 'Event not found.' });
}

function adminSessionIsCurrent(req, operator) {
  const issuedAt = Number(req.adminSession?.issuedAt);
  const cutoff = new Date(operator.sessions_valid_after).getTime();
  return Number.isSafeInteger(issuedAt) && issuedAt > 0 &&
    Number.isFinite(cutoff) && issuedAt >= cutoff;
}

// Mutation lock order is outbound account advisory -> operator -> marker ->
// canonical user -> organizer -> workspace -> event. Account deletion owns
// this same advisory before it writes an audit row whose operator FK can take
// a key-share lock. Taking the account boundary first avoids a delete/edit
// cycle while the operator row still serializes one operator's workspaces.
async function lockMutationScope(db, req, { bound }) {
  const workspace = req.adminEditorWorkspace;
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    outboundDeliveryLockKey(workspace.targetUserId)
  ]);

  const operator = (await db.query(
    `SELECT id,status,sessions_valid_after
       FROM admin_operators
      WHERE id=$1
      FOR UPDATE`,
    [req.adminOperator.id]
  )).rows[0];
  if (!operator || operator.status !== 'active' || !adminSessionIsCurrent(req, operator)) {
    throw new AdminEditorWorkspaceError(
      'admin_editor_admin_session_revoked',
      'This administrator session is no longer active.',
      401
    );
  }

  const marker = (await db.query(
    `SELECT id,target_user_id
       FROM admin_done_for_you_clients
      WHERE id=$1
      FOR UPDATE`,
    [workspace.doneForYouClientId]
  )).rows[0];
  const target = (await db.query(
    `SELECT id,account_status
       FROM users
      WHERE id=$1
      FOR UPDATE`,
    [workspace.targetUserId]
  )).rows[0];
  const organizer = (await db.query(
    `SELECT id,user_id,org_name,public_slug,logo_url,header_image_url,plan
       FROM organizers
      WHERE id=$1
      FOR UPDATE`,
    [workspace.organizerId]
  )).rows[0];
  const lockedWorkspace = (await db.query(
    `SELECT *
       FROM admin_event_editor_workspaces
      WHERE id=$1 AND actor_admin_operator_id=$2
      FOR UPDATE`,
    [workspace.id, req.adminOperator.id]
  )).rows[0];

  const exactScope = marker && target && organizer && lockedWorkspace &&
    Number(marker.target_user_id) === workspace.targetUserId &&
    Number(target.id) === workspace.targetUserId &&
    target.account_status === 'active' &&
    Number(organizer.user_id) === workspace.targetUserId &&
    Number(lockedWorkspace.done_for_you_client_id) === workspace.doneForYouClientId &&
    Number(lockedWorkspace.target_user_id) === workspace.targetUserId &&
    Number(lockedWorkspace.organizer_id) === workspace.organizerId &&
    Number(lockedWorkspace.actor_admin_operator_id) === Number(req.adminOperator.id) &&
    lockedWorkspace.status === 'active' &&
    new Date(lockedWorkspace.expires_at).getTime() > Date.now();
  if (!exactScope) {
    throw new AdminEditorWorkspaceError(
      'admin_editor_scope_unavailable',
      'This client or draft can no longer be edited.',
      403
    );
  }

  if (bound) {
    const eventId = Number(lockedWorkspace.event_id);
    if (!Number.isSafeInteger(eventId) || eventId <= 0 || eventId !== workspace.eventId) {
      throw new AdminEditorWorkspaceError(
        'admin_editor_workspace_not_bound',
        'Create the event basics before opening the advanced editor.',
        409
      );
    }
    const event = (await db.query(
      `SELECT id,organizer_id,status
         FROM events
        WHERE id=$1
        FOR UPDATE`,
      [eventId]
    )).rows[0];
    if (!event || Number(event.organizer_id) !== workspace.organizerId || event.status !== 'draft') {
      throw new AdminEditorWorkspaceError(
        'admin_editor_scope_unavailable',
        'This client or draft can no longer be edited.',
        403
      );
    }
  } else if (lockedWorkspace.event_id != null) {
    throw new AdminEditorWorkspaceError(
      'admin_editor_workspace_already_bound',
      'This editor workspace is already connected to an event.',
      409
    );
  }

  return { marker, target, organizer, workspace: lockedWorkspace };
}

async function readWorkspaceContext(req) {
  const workspace = req.adminEditorWorkspace;
  const result = await pool.query(
    `SELECT organizer.id,organizer.org_name,organizer.public_slug,
            organizer.logo_url,organizer.header_image_url,organizer.plan
       FROM admin_done_for_you_clients marker
       JOIN users target ON target.id=marker.target_user_id
       JOIN organizers organizer ON organizer.user_id=target.id
      WHERE marker.id=$1 AND marker.target_user_id=$2
        AND organizer.id=$3 AND target.account_status='active'`,
    [workspace.doneForYouClientId, workspace.targetUserId, workspace.organizerId]
  );
  if (!result.rows[0]) {
    throw new AdminEditorWorkspaceError(
      'admin_editor_scope_unavailable',
      'This client can no longer be edited.',
      403
    );
  }
  return result.rows[0];
}

function safeHost(row, workspace) {
  return {
    id: Number(row.id),
    targetUserId: workspace.targetUserId,
    name: row.org_name || '',
    org_name: row.org_name || '',
    public_slug: row.public_slug || null,
    logo_url: row.logo_url || null,
    header_image_url: row.header_image_url || null,
    plan: row.plan || 'free'
  };
}

async function exactBoundEventStillAvailable(req) {
  const workspace = req.adminEditorWorkspace;
  const result = await pool.query(
    `SELECT 1
       FROM admin_event_editor_workspaces editor
       JOIN admin_done_for_you_clients marker
         ON marker.id=editor.done_for_you_client_id
       JOIN users target ON target.id=editor.target_user_id
       JOIN organizers organizer ON organizer.id=editor.organizer_id
       JOIN events event ON event.id=editor.event_id
      WHERE editor.id=$1 AND editor.actor_admin_operator_id=$2
        AND editor.status='active' AND editor.expires_at>NOW()
        AND marker.target_user_id=editor.target_user_id
        AND target.account_status='active'
        AND organizer.user_id=editor.target_user_id
        AND event.organizer_id=editor.organizer_id
        AND event.status='draft'`,
    [workspace.id, req.adminOperator.id]
  );
  return result.rowCount === 1;
}

function handleUpload(req, res, next) {
  upload.single('image')(req, res, error => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'image_too_large', message: 'Image is too large (max 5 MB).' });
    }
    return res.status(400).json({
      error: 'invalid_image',
      message: 'That file could not be read as an image.'
    });
  });
}

function eventUpload(kind) {
  return async (req, res, next) => {
    if (!eventUploads.configured) {
      return res.status(503).json({ error: 'uploads_unavailable', message: 'Image uploads are not set up yet.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'image_required', message: 'Choose an image (max 5 MB).' });
    }
    try {
      if (!(await exactBoundEventStillAvailable(req))) {
        return res.status(403).json({
          error: 'admin_editor_scope_unavailable',
          message: 'This client or draft can no longer be edited.'
        });
      }
      const result = await eventUploads[kind](req.file.buffer);
      const response = { url: result.secure_url };
      if (kind !== 'vibe') {
        response.accentColor = selectAccentColor(result.colors, { fallback: null });
      }
      return res.json(response);
    } catch (error) {
      console.error(`[admin-editor:upload:${kind}]`, error.name, error.http_code || '', error.message);
      const message = /certificate|self.signed|ECONN|ETIMEDOUT|ENOTFOUND/i.test(error.message)
        ? 'Could not reach the image service. Please try again.'
        : (error.message || 'Upload failed');
      return res.status(502).json({ error: 'upload_failed', message });
    }
  };
}

// Both editor pages reuse the existing UI assets, but this router owns their
// independent authorization and exact workspace destination.
router.get('/events/new', (req, res) => {
  const workspace = req.adminEditorWorkspace;
  if (workspace.eventId == null) {
    if (req.query.id || req.query.advanced === '1') return res.redirect('/admin-editor/events/new');
    return res.sendFile(path.join(VIEWS, 'event-create.html'));
  }
  const requestedId = positiveId(req.query.id);
  if (requestedId !== workspace.eventId || req.query.advanced !== '1') {
    return res.redirect(`/admin-editor/events/new?id=${workspace.eventId}&advanced=1`);
  }
  return res.sendFile(path.join(VIEWS, 'event-form.html'));
});

router.get('/api/workspace', async (req, res, next) => {
  try {
    const host = await readWorkspaceContext(req);
    res.json({
      workspace: req.adminEditorWorkspace,
      host: safeHost(host, req.adminEditorWorkspace)
    });
  } catch (error) { sendEditorError(error, res, next); }
});

router.get('/api/auth/me', async (req, res, next) => {
  try {
    const host = await readWorkspaceContext(req);
    res.json({ organizer: safeHost(host, req.adminEditorWorkspace) });
  } catch (error) { sendEditorError(error, res, next); }
});

router.get('/api/places/config', (req, res) => {
  const apiKey = placesApiKey();
  res.json(apiKey ? { enabled: true, apiKey } : { enabled: false });
});

router.get('/api/photos/enabled', requireBoundWorkspace, (req, res) => {
  res.json({ enabled: unsplash.enabled });
});

router.get('/api/photos/search', requireBoundWorkspace, async (req, res, next) => {
  try {
    if (!unsplash.enabled) {
      return res.status(503).json({ error: 'photo_search_unavailable', message: 'Photo search is not set up.' });
    }
    const query = String(req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(24, Math.max(1, parseInt(req.query.per_page, 10) || 24));
    if (!query) return res.json({ results: [] });
    res.json(await unsplash.search(query, page, perPage));
  } catch (error) { next(error); }
});

router.post('/api/photos/track', requireBoundWorkspace, (req, res) => {
  unsplash.triggerDownload(req.body?.download_location);
  res.json({ ok: true });
});

// The customer waitlist is intentionally unavailable in the administrator
// realm. The editor only needs to know whether native ticketing is enabled.
router.get('/api/commerce/config', (req, res) => {
  res.json({
    enabled: commerceAdmissionEnabled(),
    interest: { interested: false, adminManaged: false }
  });
});

router.post('/api/uploads/cover', requireBoundWorkspace, handleUpload, eventUpload('cover'));
router.post('/api/uploads/flyer', requireBoundWorkspace, handleUpload, eventUpload('flyer'));
router.post('/api/uploads/vibe-photo', requireBoundWorkspace, handleUpload, eventUpload('vibe'));

router.post('/api/events', requireUnboundWorkspace, async (req, res, next) => {
  if (String(req.body?.presenter_name || '').trim()) {
    return res.status(400).json({
      error: 'admin_editor_presenter_immutable',
      message: 'Host identity is managed from the Done For You client record.'
    });
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockMutationScope(client, req, { bound: false });
      const body = { ...(req.body || {}), status: 'draft' };
      delete body.presenter_name;
      delete body.notify_attendees;
      const result = await createEventInTransaction(client, {
        organizerId: req.adminEditorWorkspace.organizerId,
        body
      });
      await bindAdminEditorWorkspaceEventInTransaction(client, {
        workspaceId: req.adminEditorWorkspace.id,
        actorAdminOperatorId: req.adminOperator.id,
        eventId: result.event.id,
        ...requestContext(req)
      });
      await client.query('COMMIT');
      return res.status(201).json(result);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505' && attempt < 2) continue;
      return sendEditorError(error, res, next);
    } finally {
      client.release();
    }
  }
  return undefined;
});

router.get('/api/events/:id', requireBoundWorkspace, requireExactEvent, async (req, res, next) => {
  const client = await pool.connect();
  try {
    res.json(await getEventForEditor(client, {
      organizerId: req.adminEditorWorkspace.organizerId,
      eventId: req.adminEditorWorkspace.eventId
    }));
  } catch (error) {
    sendEditorError(error, res, next);
  } finally {
    client.release();
  }
});

router.put('/api/events/:id', requireBoundWorkspace, requireExactEvent, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockMutationScope(client, req, { bound: true });
    const body = { ...(req.body || {}), notify_attendees: false };
    delete body.status;
    delete body.presenter_name;
    const result = await updateEventInTransaction(client, {
      organizerId: req.adminEditorWorkspace.organizerId,
      eventId: req.adminEditorWorkspace.eventId,
      body
    });
    const changedFields = [...new Set(result.changedFields || [])].sort();
    if (changedFields.length) {
      await writeAdminEditorAudit(client, {
        operatorId: req.adminOperator.id,
        targetUserId: req.adminEditorWorkspace.targetUserId,
        actionType: 'done_for_you_event_draft_updated',
        reason: 'Administrator updated a scoped Done For You event draft',
        beforeState: { eventId: req.adminEditorWorkspace.eventId, status: 'draft' },
        afterState: { eventId: req.adminEditorWorkspace.eventId, status: 'draft' },
        metadata: {
          workspaceId: req.adminEditorWorkspace.id,
          organizerId: req.adminEditorWorkspace.organizerId,
          changedFields
        },
        ...requestContext(req)
      });
    }
    await client.query('COMMIT');
    res.json({
      event: result.event,
      importantChanges: result.importantChanges,
      notification: null
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    sendEditorError(error, res, next);
  } finally {
    client.release();
  }
});

router.post('/api/events/:id/publish', requireBoundWorkspace, requireExactEvent, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockMutationScope(client, req, { bound: true });
    const result = await publishEventInTransaction(client, {
      organizerId: req.adminEditorWorkspace.organizerId,
      eventId: req.adminEditorWorkspace.eventId
    });
    await writeAdminEditorAudit(client, {
      operatorId: req.adminOperator.id,
      targetUserId: req.adminEditorWorkspace.targetUserId,
      actionType: 'done_for_you_event_published',
      reason: 'Administrator published a scoped Done For You event',
      beforeState: { eventId: req.adminEditorWorkspace.eventId, status: 'draft' },
      afterState: { eventId: req.adminEditorWorkspace.eventId, status: 'published' },
      metadata: {
        workspaceId: req.adminEditorWorkspace.id,
        organizerId: req.adminEditorWorkspace.organizerId
      },
      ...requestContext(req)
    });
    await completeAdminEditorWorkspaceInTransaction(client, {
      workspaceId: req.adminEditorWorkspace.id,
      actorAdminOperatorId: req.adminOperator.id,
      ...requestContext(req)
    });
    await client.query('COMMIT');
    clearAdminEditorCookie(res);
    res.json({
      event: result.event,
      alreadyPublished: result.alreadyPublished,
      redirect: editorRedirect(req.adminEditorWorkspace)
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    sendEditorError(error, res, next);
  } finally {
    client.release();
  }
});

router.post('/api/workspace/exit', async (req, res, next) => {
  try {
    const result = await exitAdminEditorWorkspace(pool, {
      workspaceId: req.adminEditorWorkspace.id,
      actorAdminOperatorId: req.adminOperator.id,
      ...requestContext(req)
    });
    clearAdminEditorCookie(res);
    res.json({ ok: true, redirect: result.redirect });
  } catch (error) {
    if (!(error instanceof AdminEditorWorkspaceError)) return next(error);
    clearAdminEditorCookie(res);
    res.status(error.status).json({ error: error.code, message: error.message });
  }
});

router.setEventUploadsForTests = overrides => {
  eventUploads = { ...eventUploads, ...overrides };
};

module.exports = router;
