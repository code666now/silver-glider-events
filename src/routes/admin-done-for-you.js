const express = require('express');
const pool = require('../config/db');
const requireAdmin = require('../middleware/requireAdmin');
const { requireDedicatedAdmin } = require('../middleware/requireAdmin');
const { clientIp, createRateLimiter } = require('../lib/rate-limit');
const { sendAccountClaimInvitation } = require('../lib/mailer');
const {
  DoneForYouProvisioningError,
  listDoneForYouClients,
  lookupDoneForYouClient,
  provisionDoneForYouClient,
  readDoneForYouClient
} = require('../lib/admin-done-for-you');
const { sendDoneForYouClaimInvitation } = require('../lib/done-for-you-claim-invitation');
const {
  AdminEditorWorkspaceError,
  openAdminEditorWorkspace,
  setAdminEditorCookie
} = require('../lib/admin-editor-workspace');

const router = express.Router();
let deliverClaimInvitation = sendAccountClaimInvitation;

const claimLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  rules: [
    { name: 'operator', max: 20, key: context => context.operatorId },
    { name: 'ip', max: 30, key: context => context.ip }
  ]
});

router.use('/api/admin/done-for-you', requireAdmin, requireDedicatedAdmin);

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

function handleDoneForYouError(error, res, next) {
  if (!(error instanceof DoneForYouProvisioningError)) return next(error);
  // These identifiers are safe for a dedicated support operator and let the
  // collision UI link directly to the accounts that require manual review.
  // Deliberately do not spread arbitrary error details: contact values and
  // claim tokens must never be reflected by this endpoint.
  const numericId = value => {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };
  const ownerUserIds = Array.isArray(error.ownerUserIds)
    ? [...new Set(error.ownerUserIds.map(numericId).filter(Boolean))]
    : [];
  const emailOwnerUserId = numericId(error.emailOwnerUserId);
  const phoneOwnerUserId = numericId(error.phoneOwnerUserId);
  return res.status(error.status).json({
    error: error.code,
    message: error.message,
    ...(error.expectedUserId !== undefined ? { expectedUserId: error.expectedUserId } : {}),
    ...(error.actualUserId !== undefined ? { actualUserId: error.actualUserId } : {}),
    ...(ownerUserIds.length ? { ownerUserIds } : {}),
    ...(emailOwnerUserId ? { emailOwnerUserId } : {}),
    ...(phoneOwnerUserId ? { phoneOwnerUserId } : {})
  });
}

router.post('/api/admin/done-for-you/lookup', async (req, res, next) => {
  try {
    const preview = await lookupDoneForYouClient(pool, {
      email: req.body?.email,
      phone: req.body?.phone
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(preview);
  } catch (error) { handleDoneForYouError(error, res, next); }
});

router.get('/api/admin/done-for-you', async (req, res, next) => {
  try {
    const clients = await listDoneForYouClients(pool, { limit: req.query.limit });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ clients });
  } catch (error) { next(error); }
});

router.post('/api/admin/done-for-you', async (req, res, next) => {
  if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'expectedUserId')) {
    return res.status(409).json({
      error: 'done_for_you_lookup_required',
      message: 'Preview the exact account match before provisioning.'
    });
  }
  try {
    const client = await provisionDoneForYouClient(pool, {
      actorAdminOperatorId: req.adminOperator.id,
      expectedUserId: req.body.expectedUserId,
      hostName: req.body.hostName,
      contactName: req.body.contactName,
      email: req.body.email,
      phone: req.body.phone,
      ...requestContext(req)
    });
    res.status(client.noOp ? 200 : 201).json({ client });
  } catch (error) { handleDoneForYouError(error, res, next); }
});

router.post('/api/admin/done-for-you/:id/editor-workspaces', async (req, res, next) => {
  const doneForYouClientId = positiveId(req.params.id);
  if (!doneForYouClientId) {
    return res.status(404).json({ error: 'done_for_you_client_not_found' });
  }
  const hasEventId = Object.prototype.hasOwnProperty.call(req.body || {}, 'eventId');
  const eventId = hasEventId ? positiveId(req.body.eventId) : null;
  if (hasEventId && !eventId) {
    return res.status(400).json({
      error: 'invalid_event_id',
      message: 'Choose a valid draft event.'
    });
  }
  try {
    const opened = await openAdminEditorWorkspace(pool, {
      doneForYouClientId,
      actorAdminOperatorId: req.adminOperator.id,
      sessionIssuedAt: req.adminSession.issuedAt,
      eventId,
      ...requestContext(req)
    });
    setAdminEditorCookie(res, opened.token);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(201).json({
      workspace: opened.workspace,
      redirect: eventId == null
        ? '/admin-editor/events/new'
        : `/admin-editor/events/new?id=${eventId}&advanced=1`
    });
  } catch (error) {
    if (!(error instanceof AdminEditorWorkspaceError)) return next(error);
    res.status(error.status).json({ error: error.code, message: error.message });
  }
});

router.get('/api/admin/done-for-you/:id', async (req, res, next) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(404).json({ error: 'done_for_you_client_not_found' });
  try {
    const client = await readDoneForYouClient(pool, id);
    if (!client) return res.status(404).json({ error: 'done_for_you_client_not_found' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      client,
      owner: client.owner,
      host: client.host,
      contacts: client.identities,
      events: client.events,
      claimInvitation: client.claimInvitations[0] || null
    });
  } catch (error) { next(error); }
});

router.post('/api/admin/done-for-you/:id/claim-invitation', async (req, res, next) => {
  const markerId = positiveId(req.params.id);
  if (!markerId) return res.status(404).json({ error: 'done_for_you_client_not_found' });
  const rate = claimLimiter.consume({
    operatorId: String(req.adminOperator.id),
    ip: clientIp(req)
  });
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)));
    return res.status(429).json({ error: 'too_many_claim_invitations' });
  }

  try {
    const invitation = await sendDoneForYouClaimInvitation({
      pool,
      markerId,
      actorAdminOperatorId: req.adminOperator.id,
      requestedEmail: req.body?.email,
      deliver: deliverClaimInvitation,
      ...requestContext(req)
    });
    res.status(201).json({ invitation });
  } catch (error) { handleDoneForYouError(error, res, next); }
});

router.setClaimSenderForTests = sender => {
  deliverClaimInvitation = typeof sender === 'function' ? sender : sendAccountClaimInvitation;
};

router.resetRateLimitsForTests = () => claimLimiter.reset();

module.exports = router;
