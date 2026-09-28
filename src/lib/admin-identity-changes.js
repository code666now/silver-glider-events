const crypto = require('crypto');
const { tokenHash } = require('./guest-session');

const REQUEST_TTL_MINUTES = 30;
const MAX_VERIFICATION_ATTEMPTS = 5;

function newRecipientToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function recipientTokenHash(token) {
  return tokenHash(String(token || ''));
}

function maskEmail(value) {
  const [local = '', domain = ''] = String(value || '').split('@');
  return domain ? `${local.slice(0, 1)}${local.length > 1 ? '•••' : ''}@${domain}` : '';
}

function maskPhone(value) {
  const phone = String(value || '');
  return phone.length >= 4 ? `•••• ${phone.slice(-4)}` : '';
}

function effectiveStatus(row, now = new Date()) {
  if (row.status === 'pending' && new Date(row.expires_at) <= now) return 'expired';
  return row.status;
}

function publicIdentityChange(row) {
  const status = effectiveStatus(row);
  return {
    id: Number(row.id),
    userId: Number(row.target_user_id),
    type: row.identity_type,
    value: row.value,
    status,
    requestedBy: row.requested_by_email || row.requested_by_name || 'Administrator',
    reason: row.reason,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    sentAt: row.sent_at,
    verifiedAt: row.verified_at,
    cancelledAt: row.cancelled_at,
    expiredAt: row.expired_at,
    deliveryFailedAt: row.delivery_failed_at,
    conflictAt: row.conflict_at,
    canResend: ['pending', 'expired', 'delivery_failed'].includes(status),
    canCancel: ['pending', 'expired', 'delivery_failed', 'conflict'].includes(status),
    verificationPage: '/account/verify-change'
  };
}

function publicRecipientChange(row) {
  const status = effectiveStatus(row);
  return {
    type: row.identity_type,
    maskedValue: row.identity_type === 'email' ? maskEmail(row.value) : maskPhone(row.value),
    status,
    expiresAt: row.expires_at,
    requiresCode: row.identity_type === 'phone'
  };
}

async function expireIdentityChangeRequests(db, {
  targetUserId = null,
  identityType = null,
  normalizedValue = null
} = {}) {
  const params = [];
  const filters = ["status='pending'", 'expires_at<=NOW()'];
  if (targetUserId) {
    params.push(Number(targetUserId));
    filters.push(`target_user_id=$${params.length}`);
  }
  if (identityType) {
    params.push(String(identityType));
    filters.push(`identity_type=$${params.length}`);
  }
  if (normalizedValue) {
    params.push(String(normalizedValue));
    filters.push(`normalized_value=$${params.length}`);
  }
  const { rows } = await db.query(
    `UPDATE admin_account_identity_change_requests
        SET status='expired',expired_at=COALESCE(expired_at,NOW()),updated_at=NOW()
      WHERE ${filters.join(' AND ')}
      RETURNING id,target_user_id,identity_type`,
    params
  );
  return rows;
}

async function listIdentityChangeRequests(db, targetUserId, limit = 25) {
  await expireIdentityChangeRequests(db, { targetUserId });
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const { rows } = await db.query(
    `SELECT request.*,
            actor.name AS requested_by_name,
            operator.email AS requested_by_email
       FROM admin_account_identity_change_requests request
       LEFT JOIN users actor ON actor.id=request.requested_by_user_id
       LEFT JOIN admin_operators operator
         ON operator.id=request.requested_by_admin_operator_id
      WHERE request.target_user_id=$1
      ORDER BY request.created_at DESC,request.id DESC
      LIMIT $2`,
    [Number(targetUserId), safeLimit]
  );
  return rows.map(publicIdentityChange);
}

async function readRecipientRequest(db, token, { forUpdate = false } = {}) {
  const value = String(token || '');
  if (!value || value.length > 180) return null;
  const { rows } = await db.query(
    `SELECT request.*
       FROM admin_account_identity_change_requests request
      WHERE request.request_token_hash=$1
      LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [recipientTokenHash(value)]
  );
  return rows[0] || null;
}

module.exports = {
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
};
