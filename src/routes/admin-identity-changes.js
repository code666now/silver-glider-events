const express = require('express');
const pool = require('../config/db');
const requireAdmin = require('../middleware/requireAdmin');
const { actorIds, sameOriginMutation } = require('../middleware/requireAdmin');
const { clientIp, createRateLimiter } = require('../lib/rate-limit');
const { normalizeIdentity, CanonicalIdentityConflictError } = require('../lib/canonical-identity');
const {
  recordOwnershipConflict,
  replaceVerifiedEmail,
  replaceVerifiedPhone
} = require('../lib/account-identities');
const phoneVerification = require('../lib/phone-verification');
const sms = require('../lib/sms');
const mailer = require('../lib/mailer');
const { outboundDeliveryLockKey } = require('../lib/outbound-account-status');
const {
  MAX_VERIFICATION_ATTEMPTS,
  REQUEST_TTL_MINUTES,
  effectiveStatus,
  expireIdentityChangeRequests,
  listIdentityChangeRequests,
  newRecipientToken,
  publicIdentityChange,
  publicRecipientChange,
  readRecipientRequest,
  recipientTokenHash
} = require('../lib/admin-identity-changes');

const router = express.Router();
const RECIPIENT_PAGE = '/account/verify-change';

const publicVerifyLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  rules: [
    { name: 'ip', max: 18, key: context => context.ip },
    { name: 'request', max: 6, key: context => context.requestKey }
  ]
});

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function cleanReason(value) {
  const reason = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 500);
  return reason.length >= 8 ? reason : '';
}

function recipientLink(token) {
  const baseUrl = String(process.env.APP_URL || 'https://silvergliderevents.com').replace(/\/$/, '');
  return `${baseUrl}${RECIPIENT_PAGE}?token=${encodeURIComponent(token)}`;
}

function auditContext(req) {
  return {
    requestIp: String(clientIp(req) || '').slice(0, 100) || null,
    userAgent: String(req.get('user-agent') || '').slice(0, 1000) || null
  };
}

async function writeAudit(client, req, {
  actorUserId = undefined,
  actorAdminOperatorId = undefined,
  targetUserId,
  actionType,
  reason,
  beforeState = {},
  afterState = {},
  metadata = {}
}) {
  const actor = actorIds(req);
  const context = auditContext(req);
  await client.query(
    `INSERT INTO admin_account_audit_log
       (actor_user_id,actor_admin_operator_id,target_user_id,action_type,reason,
        before_state,after_state,metadata,request_ip,user_agent)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10)`,
    [
      actorUserId === undefined ? actor.actorUserId : actorUserId,
      actorAdminOperatorId === undefined ? actor.actorAdminOperatorId : actorAdminOperatorId,
      targetUserId,
      actionType,
      reason,
      JSON.stringify(beforeState || {}),
      JSON.stringify(afterState || {}),
      JSON.stringify(metadata || {}),
      context.requestIp,
      context.userAgent
    ]
  );
}

function requireDedicatedOperator(req, res, next) {
  if (req.adminActor?.type === 'admin_operator' &&
      ['support', 'super_admin'].includes(req.adminOperator?.role)) return next();
  return res.status(403).json({
    error: 'dedicated_admin_required',
    message: 'Sign in through the dedicated administrator login.'
  });
}

async function acquireDeliveryLock(client, userId) {
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [outboundDeliveryLockKey(userId)]);
}

async function releaseDeliveryLock(client, userId) {
  const { rows } = await client.query(
    'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
    [outboundDeliveryLockKey(userId)]
  );
  if (!rows[0]?.unlocked) {
    const error = new Error('Outbound account delivery lock was not released.');
    error.code = 'outbound_delivery_unlock_failed';
    throw error;
  }
}

async function releaseDeliveryClient(client, { locked, userId }) {
  if (!locked) return client.release();
  try {
    await releaseDeliveryLock(client, userId);
    return client.release();
  } catch (error) {
    // A session-level advisory lock must never return to the pool when unlock
    // could not be confirmed. Destroying the connection lets PostgreSQL release
    // the lock with the session instead of poisoning a future pooled request.
    console.error('[admin-identity-change] discarding locked database session', error.message);
    return client.release(error);
  }
}

async function lockActiveTarget(client, userId) {
  const { rows } = await client.query(
    `SELECT u.id,u.name,u.account_status,o.id AS organizer_id,o.is_admin
       FROM users u JOIN organizers o ON o.user_id=u.id
      WHERE u.id=$1 AND u.account_status<>'deleted'
      FOR UPDATE OF u,o`,
    [userId]
  );
  const target = rows[0] || null;
  if (!target) {
    const error = new Error('Account not found');
    error.status = 404;
    error.code = 'account_not_found';
    throw error;
  }
  if (target.account_status !== 'active') {
    const error = new Error('Reactivate this account before changing its sign-in methods.');
    error.status = 409;
    error.code = 'account_inactive';
    throw error;
  }
  return target;
}

function assertTargetSupportsIdentity(target, identityType) {
  if (identityType === 'phone' && target.is_admin) {
    const error = new Error('Administrator customer accounts use email sign-in.');
    error.status = 409;
    error.code = 'email_sign_in_required';
    throw error;
  }
}

async function assertIdentityAvailable(client, normalized, userId) {
  const { rows } = await client.query(
    `SELECT id,user_id,verification_scope,verified_at,is_primary
       FROM user_identities
      WHERE identity_type=$1 AND normalized_value=$2 AND revoked_at IS NULL
      LIMIT 1 FOR UPDATE`,
    [normalized.identityType, normalized.normalizedValue]
  );
  const existing = rows[0] || null;
  if (existing && Number(existing.user_id) !== Number(userId)) {
    const error = new Error('That sign-in method is already connected to another account.');
    error.status = 409;
    error.code = 'identity_conflict';
    throw error;
  }
  if (existing && existing.verification_scope === 'account' && existing.verified_at &&
      existing.is_primary) {
    const error = new Error('That sign-in method is already connected to this account.');
    error.status = 409;
    error.code = 'identity_already_connected';
    throw error;
  }
  return existing;
}

async function readRequest(client, userId, requestId, { forUpdate = false } = {}) {
  const { rows } = await client.query(
    `SELECT request.*,
            actor.name AS requested_by_name,
            operator.email AS requested_by_email
       FROM admin_account_identity_change_requests request
       LEFT JOIN users actor ON actor.id=request.requested_by_user_id
       LEFT JOIN admin_operators operator
         ON operator.id=request.requested_by_admin_operator_id
      WHERE request.id=$1 AND request.target_user_id=$2
      LIMIT 1${forUpdate ? ' FOR UPDATE OF request' : ''}`,
    [requestId, userId]
  );
  return rows[0] || null;
}

async function markDeliveryFailed(req, requestId, error) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE admin_account_identity_change_requests
          SET status='delivery_failed',delivery_failed_at=NOW(),updated_at=NOW()
        WHERE id=$1 AND status='pending' AND sent_at IS NULL
        RETURNING *`,
      [requestId]
    );
    const row = updated.rows[0];
    if (row) {
      await writeAudit(client, req, {
        targetUserId: Number(row.target_user_id),
        actionType: 'identity_change_delivery_failed',
        reason: row.reason,
        afterState: { requestId: Number(row.id), type: row.identity_type, status: 'delivery_failed' },
        metadata: { deliveryError: String(error?.code || error?.message || 'delivery_failed').slice(0, 120) }
      });
    }
    await client.query('COMMIT');
  } catch (auditError) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin-identity-change] delivery failure state could not be recorded', auditError.message);
  } finally { client.release(); }
}

async function markDelivered(req, requestId, { providerSid = null, requestHash } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE admin_account_identity_change_requests request
          SET provider_sid=CASE WHEN identity_type='phone' THEN $2 ELSE NULL END,
              sent_at=NOW(),updated_at=NOW()
        FROM users target
        WHERE request.id=$1 AND request.status='pending' AND request.sent_at IS NULL
          AND request.request_token_hash=$3
          AND request.target_user_id=target.id AND target.account_status='active'
        RETURNING request.*`,
      [requestId, providerSid, requestHash]
    );
    const row = updated.rows[0];
    if (!row) throw Object.assign(new Error('Identity change is no longer deliverable.'), {
      code: 'identity_change_unavailable', status: 409
    });
    await writeAudit(client, req, {
      targetUserId: Number(row.target_user_id),
      actionType: 'identity_change_sent',
      reason: row.reason,
      afterState: { requestId: Number(row.id), type: row.identity_type, status: 'pending' }
    });
    await client.query('COMMIT');
    return row;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function deliverRequest(req, row, rawToken, targetName) {
  const link = recipientLink(rawToken);
  let providerSid = null;
  if (row.identity_type === 'email') {
    await mailer.sendAdminIdentityChangeVerification({
      to: row.normalized_value,
      link,
      accountName: targetName
    });
  } else {
    const verification = await phoneVerification.startVerification(row.normalized_value);
    providerSid = verification.verificationSid;
    await sms.sendSms({
      to: row.normalized_value,
      body: `Silver Glider support prepared a phone change for your account. Open ${link} and enter the verification code from Twilio. If you did not request this, ignore both messages.`
    });
  }
  return markDelivered(req, row.id, {
    providerSid,
    requestHash: recipientTokenHash(rawToken)
  });
}

async function createOrResendDelivery(req, res, {
  userId,
  requestId = null,
  reason,
  identityType = null,
  value = null
}) {
  const client = await pool.connect();
  let locked = false;
  let rawToken = null;
  let requestRow = null;
  let target = null;
  try {
    await acquireDeliveryLock(client, userId);
    locked = true;
    await client.query('BEGIN');
    rawToken = newRecipientToken();

    if (requestId) {
      await expireIdentityChangeRequests(client, { targetUserId: userId });
      const current = await readRequest(client, userId, requestId, { forUpdate: true });
      if (!current) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'identity_change_not_found', message: 'Change request not found.' });
      }
      const status = effectiveStatus(current);
      if (!['pending', 'expired', 'delivery_failed'].includes(status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'identity_change_terminal', message: 'This change request can no longer be resent.' });
      }
      await assertIdentityAvailable(client, {
        identityType: current.identity_type,
        normalizedValue: current.normalized_value
      }, userId);
      target = await lockActiveTarget(client, userId);
      assertTargetSupportsIdentity(target, current.identity_type);
      const updated = await client.query(
        `UPDATE admin_account_identity_change_requests
            SET status='pending',request_token_hash=$3,provider_sid=NULL,
                verification_attempts=0,reason=$4,sent_at=NULL,
                expires_at=NOW() + make_interval(mins => $5),verified_at=NULL,
                cancelled_at=NULL,expired_at=NULL,delivery_failed_at=NULL,
                conflict_at=NULL,requested_by_user_id=$6,
                requested_by_admin_operator_id=$7,updated_at=NOW()
          WHERE id=$1 AND target_user_id=$2
          RETURNING *`,
        [requestId, userId, recipientTokenHash(rawToken), reason, REQUEST_TTL_MINUTES,
         actorIds(req).actorUserId, actorIds(req).actorAdminOperatorId]
      );
      requestRow = updated.rows[0];
      await writeAudit(client, req, {
        targetUserId: userId,
        actionType: 'identity_change_resent',
        reason,
        beforeState: { requestId, type: current.identity_type, status },
        afterState: { requestId, type: current.identity_type, status: 'pending' }
      });
    } else {
      const normalized = normalizeIdentity(identityType, value);
      await expireIdentityChangeRequests(client, {
        targetUserId: userId,
        identityType: normalized.identityType
      });
      await expireIdentityChangeRequests(client, {
        identityType: normalized.identityType,
        normalizedValue: normalized.normalizedValue
      });
      await assertIdentityAvailable(client, normalized, userId);
      target = await lockActiveTarget(client, userId);
      assertTargetSupportsIdentity(target, normalized.identityType);

      const pending = await client.query(
        `SELECT * FROM admin_account_identity_change_requests
          WHERE target_user_id=$1 AND identity_type=$2 AND status='pending'
          LIMIT 1 FOR UPDATE`,
        [userId, normalized.identityType]
      );
      if (pending.rows[0] && pending.rows[0].normalized_value === normalized.normalizedValue) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'identity_change_pending',
          message: 'A verification is already pending for that sign-in method.'
        });
      }
      if (pending.rows[0]) {
        await client.query(
          `UPDATE admin_account_identity_change_requests
              SET status='cancelled',cancelled_at=NOW(),updated_at=NOW()
            WHERE id=$1`,
          [pending.rows[0].id]
        );
        await writeAudit(client, req, {
          targetUserId: userId,
          actionType: 'identity_change_superseded',
          reason,
          beforeState: { requestId: Number(pending.rows[0].id), type: normalized.identityType, status: 'pending' },
          afterState: { requestId: Number(pending.rows[0].id), type: normalized.identityType, status: 'cancelled' }
        });
      }

      const actor = actorIds(req);
      const inserted = await client.query(
        `INSERT INTO admin_account_identity_change_requests
           (target_user_id,identity_type,value,normalized_value,request_token_hash,
            requested_by_user_id,requested_by_admin_operator_id,reason,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW() + make_interval(mins => $9))
         RETURNING *`,
        [
          userId,
          normalized.identityType,
          normalized.value,
          normalized.normalizedValue,
          recipientTokenHash(rawToken),
          actor.actorUserId,
          actor.actorAdminOperatorId,
          reason,
          REQUEST_TTL_MINUTES
        ]
      );
      requestRow = inserted.rows[0];
      await writeAudit(client, req, {
        targetUserId: userId,
        actionType: 'identity_change_requested',
        reason,
        afterState: {
          requestId: Number(requestRow.id),
          type: requestRow.identity_type,
          status: 'pending'
        }
      });
    }
    await client.query('COMMIT');

    try {
      requestRow = await deliverRequest(req, requestRow, rawToken, target.name);
    } catch (error) {
      await markDeliveryFailed(req, requestRow.id, error);
      const failed = await readRequest(pool, userId, requestRow.id);
      return res.status(error.status && error.status < 500 ? error.status : 502).json({
        error: error.code || 'identity_change_delivery_failed',
        message: 'Verification could not be delivered. Nothing was changed.',
        identityChangeRequest: failed ? publicIdentityChange(failed) : null
      });
    }

    const delivered = await readRequest(pool, userId, requestRow.id);
    return res.status(requestId ? 200 : 201).json({
      ok: true,
      identityChangeRequest: publicIdentityChange(delivered)
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error?.code === '23505') {
      return res.status(409).json({
        error: 'identity_change_pending',
        message: 'A verification is already pending for that sign-in method.'
      });
    }
    if (error.status) {
      return res.status(error.status).json({ error: error.code || 'identity_change_error', message: error.message });
    }
    throw error;
  } finally {
    await releaseDeliveryClient(client, { locked, userId });
  }
}

// Keep the dedicated-operator boundary scoped to this feature. This router is
// mounted before the broader admin-accounts router, so guarding the shared
// `/api/admin/accounts` prefix here would accidentally intercept every legacy
// support endpoint.
router.use('/api/admin/accounts/:id/identity-changes', requireAdmin, requireDedicatedOperator);

router.get('/api/admin/accounts/:id/identity-changes', async (req, res, next) => {
  try {
    const userId = positiveId(req.params.id);
    if (!userId) return res.status(404).json({ error: 'account_not_found' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ identityChangeRequests: await listIdentityChangeRequests(pool, userId) });
  } catch (error) { next(error); }
});

router.post('/api/admin/accounts/:id/identity-changes', async (req, res, next) => {
  const userId = positiveId(req.params.id);
  const reason = cleanReason(req.body?.reason);
  if (!userId) return res.status(404).json({ error: 'account_not_found' });
  if (!reason) return res.status(400).json({ error: 'reason_required', message: 'Add a reason of at least 8 characters.' });
  try {
    return await createOrResendDelivery(req, res, {
      userId,
      reason,
      identityType: req.body?.type,
      value: req.body?.value
    });
  } catch (error) { next(error); }
});

router.post('/api/admin/accounts/:id/identity-changes/:changeId/resend', async (req, res, next) => {
  const userId = positiveId(req.params.id);
  const requestId = positiveId(req.params.changeId);
  const reason = cleanReason(req.body?.reason);
  if (!userId || !requestId) return res.status(404).json({ error: 'identity_change_not_found' });
  if (!reason) return res.status(400).json({ error: 'reason_required', message: 'Add a reason of at least 8 characters.' });
  try {
    return await createOrResendDelivery(req, res, { userId, requestId, reason });
  } catch (error) { next(error); }
});

router.post('/api/admin/accounts/:id/identity-changes/:changeId/cancel', async (req, res, next) => {
  const userId = positiveId(req.params.id);
  const requestId = positiveId(req.params.changeId);
  const reason = cleanReason(req.body?.reason);
  if (!userId || !requestId) return res.status(404).json({ error: 'identity_change_not_found' });
  if (!reason) return res.status(400).json({ error: 'reason_required', message: 'Add a reason of at least 8 characters.' });
  const client = await pool.connect();
  let locked = false;
  try {
    await acquireDeliveryLock(client, userId);
    locked = true;
    await client.query('BEGIN');
    await expireIdentityChangeRequests(client, { targetUserId: userId });
    const current = await readRequest(client, userId, requestId, { forUpdate: true });
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'identity_change_not_found' });
    }
    const status = effectiveStatus(current);
    if (!['pending', 'expired', 'delivery_failed', 'conflict'].includes(status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'identity_change_terminal', message: 'This change request can no longer be cancelled.' });
    }
    const updated = await client.query(
      `UPDATE admin_account_identity_change_requests
          SET status='cancelled',cancelled_at=NOW(),expired_at=NULL,
              delivery_failed_at=NULL,conflict_at=NULL,updated_at=NOW()
        WHERE id=$1 RETURNING *`,
      [requestId]
    );
    await writeAudit(client, req, {
      targetUserId: userId,
      actionType: 'identity_change_cancelled',
      reason,
      beforeState: { requestId, type: current.identity_type, status },
      afterState: { requestId, type: current.identity_type, status: 'cancelled' }
    });
    await client.query('COMMIT');
    res.json({ ok: true, identityChangeRequest: publicIdentityChange(updated.rows[0]) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    await releaseDeliveryClient(client, { locked, userId });
  }
});

router.get('/api/account/identity-change', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    const request = await readRecipientRequest(pool, req.query.token);
    if (!request || effectiveStatus(request) !== 'pending' || !request.sent_at) {
      return res.status(404).json({
        error: 'verification_unavailable',
        message: 'This verification is unavailable or expired.'
      });
    }
    res.json({ request: publicRecipientChange(request) });
  } catch (error) { next(error); }
});

async function recordFailedPhoneAttempt(requestId, { requestTokenHash, providerSid }) {
  const { rows } = await pool.query(
    `UPDATE admin_account_identity_change_requests
        SET verification_attempts=LEAST(verification_attempts+1,$2),updated_at=NOW()
      WHERE id=$1 AND status='pending' AND expires_at>NOW()
        AND request_token_hash=$3 AND provider_sid=$4
      RETURNING verification_attempts`,
    [requestId, MAX_VERIFICATION_ATTEMPTS, requestTokenHash, providerSid]
  );
  return rows[0] ? Number(rows[0].verification_attempts) : null;
}

async function completeRecipientRequest(req, request, verification) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [outboundDeliveryLockKey(Number(request.target_user_id))]
    );
    const locked = await readRecipientRequest(client, req.body?.token, { forUpdate: true });
    if (!locked || Number(locked.id) !== Number(request.id) || locked.status !== 'pending' ||
        !locked.sent_at || new Date(locked.expires_at) <= new Date()) {
      await client.query('ROLLBACK');
      return { status: 400, error: 'verification_unavailable' };
    }
    if (locked.identity_type === 'phone') {
      if (!verification?.approved || verification.verificationSid !== locked.provider_sid ||
          verification.phone !== locked.normalized_value) {
        await client.query('ROLLBACK');
        await recordFailedPhoneAttempt(locked.id, {
          requestTokenHash: locked.request_token_hash,
          providerSid: locked.provider_sid
        });
        return { status: 400, error: 'verification_invalid' };
      }
    }

    await client.query('SAVEPOINT identity_change_completion');
    try {
      if (locked.identity_type === 'email') {
        await replaceVerifiedEmail(client, {
          userId: Number(locked.target_user_id),
          email: locked.normalized_value,
          verifiedAt: new Date(),
          verificationSource: 'admin_identity_change.email_link',
          sourceRecordId: Number(locked.id)
        });
      } else {
        await replaceVerifiedPhone(client, {
          userId: Number(locked.target_user_id),
          phone: locked.normalized_value,
          verifiedAt: new Date(),
          verificationSource: 'admin_identity_change.twilio_verify'
        });
      }
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT identity_change_completion');
      if (!(error instanceof CanonicalIdentityConflictError) && error?.code !== '23505') throw error;
      await client.query(
        `UPDATE admin_account_identity_change_requests
            SET status='conflict',conflict_at=NOW(),updated_at=NOW()
          WHERE id=$1`,
        [locked.id]
      );
      await recordOwnershipConflict(client, {
        identityType: locked.identity_type,
        normalizedValue: locked.normalized_value,
        candidateUserId: locked.target_user_id,
        conflictingUserId: error.existingUserId || null,
        verificationSource: locked.identity_type === 'email'
          ? 'admin_identity_change.email_link'
          : 'admin_identity_change.twilio_verify',
        sourceRecordId: Number(locked.id)
      });
      await writeAudit(client, req, {
        actorUserId: locked.requested_by_user_id,
        actorAdminOperatorId: locked.requested_by_admin_operator_id,
        targetUserId: Number(locked.target_user_id),
        actionType: 'identity_change_conflict',
        reason: locked.reason,
        afterState: { requestId: Number(locked.id), type: locked.identity_type, status: 'conflict' },
        metadata: { performedBy: 'recipient' }
      });
      await client.query('COMMIT');
      return { status: 409, error: 'verification_conflict' };
    }

    await client.query(
      `UPDATE admin_account_identity_change_requests
          SET status='verified',verified_at=NOW(),updated_at=NOW()
        WHERE id=$1`,
      [locked.id]
    );
    await writeAudit(client, req, {
      actorUserId: locked.requested_by_user_id,
      actorAdminOperatorId: locked.requested_by_admin_operator_id,
      targetUserId: Number(locked.target_user_id),
      actionType: 'identity_change_recipient_verified',
      reason: locked.reason,
      afterState: { requestId: Number(locked.id), type: locked.identity_type, status: 'verified' },
      metadata: { performedBy: 'recipient' }
    });
    await client.query('COMMIT');
    return { status: 200, ok: true, type: locked.identity_type };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

router.post('/api/account/identity-change/verify', async (req, res, next) => {
  if (!sameOriginMutation(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    const token = String(req.body?.token || '');
    const request = await readRecipientRequest(pool, token);
    const requestKey = recipientTokenHash(token.slice(0, 180) || `invalid:${clientIp(req)}`);
    const rate = publicVerifyLimiter.consume({ ip: clientIp(req), requestKey });
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)));
      return res.status(429).json({ error: 'verification_rate_limited', message: 'Wait a few minutes and try again.' });
    }
    if (!request || request.status !== 'pending' || !request.sent_at ||
        new Date(request.expires_at) <= new Date() ||
        Number(request.verification_attempts) >= MAX_VERIFICATION_ATTEMPTS) {
      return res.status(400).json({ error: 'verification_unavailable', message: 'This verification is unavailable or expired.' });
    }

    let verification = null;
    if (request.identity_type === 'phone') {
      try {
        verification = await phoneVerification.checkVerification({
          verificationSid: request.provider_sid,
          code: req.body?.code
        });
      } catch (error) {
        if (error instanceof phoneVerification.PhoneVerificationError) {
          const invalidProof = ['invalid_phone_verification_code', 'invalid_phone_verification',
            'phone_verification_rejected'].includes(error.code);
          if (invalidProof) {
            await recordFailedPhoneAttempt(request.id, {
              requestTokenHash: request.request_token_hash,
              providerSid: request.provider_sid
            });
          }
          return res.status(error.status || 400).json(invalidProof
            ? { error: 'verification_invalid', message: 'That verification code is invalid or expired.' }
            : { error: error.code, message: error.message });
        }
        throw error;
      }
    }

    const result = await completeRecipientRequest(req, request, verification);
    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error,
        message: result.error === 'verification_conflict'
          ? 'This sign-in method cannot be connected. Contact support.'
          : 'This verification is unavailable or expired.'
      });
    }
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ ok: true, type: result.type });
  } catch (error) { next(error); }
});

router.listIdentityChangeRequests = listIdentityChangeRequests;
router.resetRateLimitsForTests = () => publicVerifyLimiter.reset();

module.exports = router;
