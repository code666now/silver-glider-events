const express = require('express');
const pool = require('../config/db');
const requireAdmin = require('../middleware/requireAdmin');
const { requireDedicatedAdmin } = require('../middleware/requireAdmin');
const { createSignInChallenge } = require('../lib/sign-in-challenges');
const { tokenHash } = require('../lib/guest-session');
const { clientIp, createRateLimiter } = require('../lib/rate-limit');
const { sendAccountClaimInvitation } = require('../lib/mailer');
const { outboundDeliveryLockKey } = require('../lib/outbound-account-status');
const { IDENTITY_TYPES, normalizeIdentity } = require('../lib/canonical-identity');
const {
  DoneForYouProvisioningError,
  listDoneForYouClients,
  lookupDoneForYouClient,
  provisionDoneForYouClient,
  readDoneForYouClient
} = require('../lib/admin-done-for-you');
const {
  AdminEditorWorkspaceError,
  openAdminEditorWorkspace,
  setAdminEditorCookie
} = require('../lib/admin-editor-workspace');

const router = express.Router();
const CLAIM_TTL_MINUTES = 7 * 24 * 60;
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

async function writeClaimAudit(db, req, {
  targetUserId,
  actionType,
  reason,
  beforeState = {},
  afterState = {},
  metadata = {}
}) {
  const context = requestContext(req);
  await db.query(
    `INSERT INTO admin_account_audit_log
       (actor_user_id,actor_admin_operator_id,target_user_id,action_type,reason,
        before_state,after_state,metadata,request_ip,user_agent)
     VALUES (NULL,$1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)`,
    [
      req.adminOperator.id,
      targetUserId,
      actionType,
      reason,
      JSON.stringify(beforeState),
      JSON.stringify(afterState),
      JSON.stringify(metadata),
      context.requestIp,
      context.userAgent
    ]
  );
}

async function logClaimDelivery(db, email, targetUserId, status, error = null) {
  await db.query(
    `INSERT INTO message_log
       (recipient,recipient_user_id,message_type,channel,status,sent_at,error)
     VALUES ($1,$2,'magic_link','email',$3,
             CASE WHEN $3='sent' THEN NOW() ELSE NULL END,$4)`,
    [
      email,
      targetUserId,
      status,
      error ? String(error.message || 'Delivery failed').slice(0, 500) : null
    ]
  );
}

async function unlockOutbound(client, userId) {
  const result = await client.query(
    'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
    [outboundDeliveryLockKey(userId)]
  );
  if (!result.rows[0]?.unlocked) throw new Error('Done For You delivery lock was not held');
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

  const requestedEmail = String(req.body?.email || '').trim();
  let normalizedEmail = null;

  const client = await pool.connect();
  let targetUserId = null;
  let invitation = null;
  let challenge = null;
  let lockHeld = false;
  try {
    const marker = await readDoneForYouClient(client, markerId);
    if (!marker) return res.status(404).json({ error: 'done_for_you_client_not_found' });
    const recipientEmail = requestedEmail || marker.identities.find(identity => identity.type === 'email')?.value;
    try {
      normalizedEmail = normalizeIdentity(IDENTITY_TYPES.EMAIL, recipientEmail).normalizedValue;
    } catch (error) {
      throw new DoneForYouProvisioningError(
        'claim_email_not_available',
        'Add a valid client email before sending a claim invitation.',
        409
      );
    }
    targetUserId = marker.owner.userId;
    await client.query(
      'SELECT pg_advisory_lock(hashtext($1))',
      [outboundDeliveryLockKey(targetUserId)]
    );
    lockHeld = true;

    await client.query('BEGIN');
    const emailIdentity = (await client.query(
      `SELECT id,verification_scope,verified_at
         FROM user_identities
        WHERE user_id=$1 AND identity_type='email' AND normalized_value=$2
          AND revoked_at IS NULL
        FOR UPDATE`,
      [targetUserId, normalizedEmail]
    )).rows[0];
    const locked = await readDoneForYouClient(client, markerId, { forUpdate: true });
    if (!locked || locked.owner.status !== 'active') {
      throw new DoneForYouProvisioningError(
        'account_not_active',
        'This client account is not active.',
        409
      );
    }
    if (locked.owner.claimed) {
      throw new DoneForYouProvisioningError(
        'account_already_claimed',
        'This client already controls the account.',
        409
      );
    }
    if (!emailIdentity) {
      throw new DoneForYouProvisioningError(
        'claim_email_not_owned',
        'That email is not attached to this prepared client.',
        409
      );
    }

    const prior = await client.query(
      `SELECT id,magic_link_token_id,email,sent_at,expires_at
         FROM admin_account_invitations
        WHERE target_user_id=$1 AND claimed_at IS NULL
          AND revoked_at IS NULL AND delivery_failed_at IS NULL
        ORDER BY id FOR UPDATE`,
      [targetUserId]
    );
    if (prior.rows.length) {
      const ids = prior.rows.map(row => Number(row.id));
      const tokenIds = prior.rows.map(row => Number(row.magic_link_token_id));
      await client.query(
        'UPDATE admin_account_invitations SET revoked_at=NOW() WHERE id=ANY($1::bigint[])',
        [ids]
      );
      await client.query(
        'UPDATE magic_link_tokens SET used_at=COALESCE(used_at,NOW()) WHERE id=ANY($1::int[])',
        [tokenIds]
      );
      await writeClaimAudit(client, req, {
        targetUserId,
        actionType: 'done_for_you_claim_invitations_revoked',
        reason: 'Replace client claim invitation',
        beforeState: { activeInvitationIds: ids },
        afterState: { activeInvitationIds: [] },
        metadata: { markerId }
      });
    }

    challenge = await createSignInChallenge(client, {
      email: normalizedEmail,
      intent: 'claim_account',
      returnPath: '/dashboard',
      ttlMinutes: CLAIM_TTL_MINUTES,
      withCode: false
    });
    const tokenId = challenge.id || (await client.query(
      'SELECT id FROM magic_link_tokens WHERE token=$1',
      [tokenHash(challenge.token)]
    )).rows[0]?.id;
    invitation = (await client.query(
      `INSERT INTO admin_account_invitations
         (email,name,prepare_host_page,magic_link_token_id,
          created_by_admin_operator_id,target_user_id,expires_at)
       VALUES ($1,$2,TRUE,$3,$4,$5,NOW() + INTERVAL '7 days')
       RETURNING id,email,name,target_user_id,created_at,expires_at`,
      [normalizedEmail, locked.owner.name || 'Client', tokenId, req.adminOperator.id, targetUserId]
    )).rows[0];
    await writeClaimAudit(client, req, {
      targetUserId,
      actionType: 'done_for_you_claim_invitation_created',
      reason: 'Send prepared account claim invitation',
      beforeState: { invitationStatus: null },
      afterState: { invitationStatus: 'creating' },
      metadata: {
        markerId,
        invitationId: Number(invitation.id)
      }
    });
    await client.query('COMMIT');

    const link = `${String(process.env.APP_URL || '').replace(/\/$/, '')}/auth/verify?token=${challenge.token}`;
    try {
      await deliverClaimInvitation({
        to: normalizedEmail,
        link,
        name: locked.owner.name || 'there'
      });
    } catch (error) {
      await client.query('BEGIN');
      const failed = await client.query(
        `UPDATE admin_account_invitations
            SET delivery_failed_at=NOW()
          WHERE id=$1 AND sent_at IS NULL AND claimed_at IS NULL AND revoked_at IS NULL
          RETURNING magic_link_token_id,delivery_failed_at`,
        [invitation.id]
      );
      if (failed.rows[0]) {
        await client.query(
          'UPDATE magic_link_tokens SET used_at=COALESCE(used_at,NOW()) WHERE id=$1',
          [failed.rows[0].magic_link_token_id]
        );
        await writeClaimAudit(client, req, {
          targetUserId,
          actionType: 'done_for_you_claim_invitation_delivery_failed',
          reason: 'Prepared account claim delivery failed',
          beforeState: { invitationStatus: 'creating' },
          afterState: { invitationStatus: 'delivery_failed' },
          metadata: { markerId, invitationId: Number(invitation.id) }
        });
      }
      await logClaimDelivery(client, normalizedEmail, targetUserId, 'failed', error);
      await client.query('COMMIT');
      throw error;
    }

    await client.query('BEGIN');
    const sent = await client.query(
      `UPDATE admin_account_invitations invitation
          SET sent_at=NOW()
         FROM users canonical_user
        WHERE invitation.id=$1
          AND canonical_user.id=invitation.target_user_id
          AND canonical_user.account_status='active'
          AND invitation.claimed_at IS NULL AND invitation.revoked_at IS NULL
          AND invitation.delivery_failed_at IS NULL AND invitation.expires_at>NOW()
        RETURNING invitation.sent_at`,
      [invitation.id]
    );
    if (!sent.rows[0]) throw new Error('Claim invitation is no longer deliverable');
    await writeClaimAudit(client, req, {
      targetUserId,
      actionType: 'done_for_you_claim_invitation_sent',
      reason: 'Prepared account claim invitation sent',
      beforeState: { invitationStatus: 'creating' },
      afterState: { invitationStatus: 'sent', sentAt: sent.rows[0].sent_at },
      metadata: { markerId, invitationId: Number(invitation.id) }
    });
    await logClaimDelivery(client, normalizedEmail, targetUserId, 'sent');
    await client.query('COMMIT');

    res.status(201).json({
      invitation: {
        id: Number(invitation.id),
        email: normalizedEmail,
        status: 'sent',
        sentAt: sent.rows[0].sent_at,
        expiresAt: invitation.expires_at
      }
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (res.headersSent) return;
    return handleDoneForYouError(error, res, next);
  } finally {
    let releaseError = null;
    if (lockHeld) {
      try {
        await unlockOutbound(client, targetUserId);
      } catch (error) {
        console.error('[done-for-you] failed to release outbound delivery lock', {
          targetUserId,
          error: error.message
        });
        releaseError = error;
      }
    }
    client.release(releaseError || undefined);
  }
});

router.setClaimSenderForTests = sender => {
  deliverClaimInvitation = typeof sender === 'function' ? sender : sendAccountClaimInvitation;
};

router.resetRateLimitsForTests = () => claimLimiter.reset();

module.exports = router;
