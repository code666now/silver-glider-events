const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = new Set(['super_admin', 'support']);
const STATUSES = new Set(['active', 'disabled']);
const ROSTER_LOCK = 'silver-glider-admin-operator-roster';
const {
  invalidateAdminOperatorAccessInTransaction,
  lockAdminEditorWorkspaceAccountsInTransaction
} = require('./admin-editor-workspace');

class AdminOperatorError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AdminOperatorError';
    this.code = code;
    this.status = status;
  }
}

function normalizeOperatorEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.length <= 320 && EMAIL_RE.test(email) ? email : '';
}

function operatorTargetKey(operatorId) {
  const id = Number(operatorId);
  return Number.isSafeInteger(id) && id > 0 ? `operator:${id}` : '';
}

function newOperatorTargetKey(email) {
  const normalized = normalizeOperatorEmail(email);
  return normalized ? `new:${normalized}` : '';
}

function canonicalOperatorTargetKey(value) {
  const target = String(value || '').trim().toLowerCase();
  if (target.startsWith('operator:')) {
    return operatorTargetKey(target.slice('operator:'.length));
  }
  if (target.startsWith('new:')) {
    return newOperatorTargetKey(target.slice('new:'.length));
  }
  return '';
}

function cleanReason(value) {
  const reason = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 500);
  return reason.length >= 8 ? reason : '';
}

function serializeOperator(row, actorId) {
  return {
    id: Number(row.id),
    email: row.email,
    role: row.role,
    status: row.status,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isSelf: Number(row.id) === Number(actorId)
  };
}

function serializeAudit(row) {
  return {
    id: Number(row.id),
    actorOperatorId: Number(row.actor_admin_operator_id),
    actorEmail: row.actor_email,
    targetOperatorId: Number(row.target_admin_operator_id),
    targetEmail: row.target_email,
    action: row.action_type,
    reason: row.reason,
    before: row.before_state,
    after: row.after_state,
    createdAt: row.created_at
  };
}

async function listAdminOperatorRoster(db, actorId) {
  const [operatorsResult, auditResult] = await Promise.all([
    db.query(
      `SELECT id,email,role,status,last_login_at,created_at,updated_at
         FROM admin_operators
        ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,
                 CASE role WHEN 'super_admin' THEN 0 ELSE 1 END,
                 email,id`
    ),
    db.query(
      `SELECT id,actor_admin_operator_id,target_admin_operator_id,
              actor_email,target_email,action_type,reason,
              before_state,after_state,created_at
         FROM admin_operator_audit_log
        ORDER BY created_at DESC,id DESC
        LIMIT 100`
    )
  ]);
  const operators = operatorsResult.rows.map(row => serializeOperator(row, actorId));
  return {
    operators,
    audit: auditResult.rows.map(serializeAudit),
    activeSuperAdminCount: operators.filter(operator => (
      operator.role === 'super_admin' && operator.status === 'active'
    )).length
  };
}

async function inTransaction(db, callback) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function lockRoster(client, actorId) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ROSTER_LOCK]);
  const { rows } = await client.query(
    `SELECT id,email,role,status
       FROM admin_operators
      WHERE id=$1 AND role='super_admin' AND status='active'
      FOR UPDATE`,
    [actorId]
  );
  if (!rows[0]) {
    throw new AdminOperatorError(
      'dedicated_super_admin_required',
      'A current dedicated Super Admin session is required.',
      403
    );
  }
  return rows[0];
}

async function writeAudit(client, {
  actor,
  target,
  action,
  reason,
  before = {},
  after = {},
  requestIp = null,
  userAgent = null
}) {
  await client.query(
    `INSERT INTO admin_operator_audit_log
       (actor_admin_operator_id,target_admin_operator_id,actor_email,target_email,
        action_type,reason,before_state,after_state,request_ip,user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)`,
    [
      actor.id,
      target.id,
      actor.email,
      target.email,
      action,
      reason,
      JSON.stringify(before),
      JSON.stringify(after),
      String(requestIp || '').slice(0, 100) || null,
      String(userAgent || '').slice(0, 1000) || null
    ]
  );
}

function operatorState(operator) {
  return {
    email: operator.email,
    role: operator.role,
    status: operator.status
  };
}

async function createAdminOperator(db, {
  actorId,
  email,
  role,
  reason,
  requestIp,
  userAgent,
  authorize
}) {
  const normalizedEmail = normalizeOperatorEmail(email);
  const normalizedRole = String(role || '').trim();
  const cleanAuditReason = cleanReason(reason);
  if (!normalizedEmail) {
    throw new AdminOperatorError('invalid_operator_email', 'Enter a valid operator email.');
  }
  if (!ROLES.has(normalizedRole)) {
    throw new AdminOperatorError('invalid_operator_role', 'Choose Super Admin or Support.');
  }
  if (!cleanAuditReason) {
    throw new AdminOperatorError('operator_reason_required', 'Add a reason for this admin-team change.');
  }
  const targetKey = newOperatorTargetKey(normalizedEmail);

  try {
    return await inTransaction(db, async client => {
      const actor = await lockRoster(client, actorId);
      const existing = await client.query(
        'SELECT id FROM admin_operators WHERE email=$1',
        [normalizedEmail]
      );
      if (existing.rows[0]) {
        throw new AdminOperatorError(
          'operator_already_exists',
          'An operator with that email already exists.',
          409
        );
      }
      if (!await authorize(client, targetKey)) {
        throw new AdminOperatorError(
          'admin_step_up_required',
          'Enter a fresh administrator passcode for this admin-team change.',
          403
        );
      }
      const { rows } = await client.query(
        `INSERT INTO admin_operators (email,role,status)
         VALUES ($1,$2,'active')
         RETURNING id,email,role,status,last_login_at,created_at,updated_at`,
        [normalizedEmail, normalizedRole]
      );
      const target = rows[0];
      await writeAudit(client, {
        actor,
        target,
        action: 'operator_created',
        reason: cleanAuditReason,
        after: operatorState(target),
        requestIp,
        userAgent
      });
      return serializeOperator(target, actorId);
    });
  } catch (error) {
    if (error.code === '23505') {
      throw new AdminOperatorError(
        'operator_already_exists',
        'An operator with that email already exists.',
        409
      );
    }
    throw error;
  }
}

async function updateAdminOperator(db, {
  actorId,
  targetId,
  role,
  status,
  hasRole,
  hasStatus,
  reason,
  requestIp,
  userAgent,
  authorize
}) {
  const id = Number(targetId);
  const normalizedRole = String(role || '').trim();
  const normalizedStatus = String(status || '').trim();
  const cleanAuditReason = cleanReason(reason);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AdminOperatorError('operator_not_found', 'Operator not found.', 404);
  }
  if (!hasRole && !hasStatus) {
    throw new AdminOperatorError('operator_change_required', 'Choose a role or status change.');
  }
  if (hasRole && !ROLES.has(normalizedRole)) {
    throw new AdminOperatorError('invalid_operator_role', 'Choose Super Admin or Support.');
  }
  if (hasStatus && !STATUSES.has(normalizedStatus)) {
    throw new AdminOperatorError('invalid_operator_status', 'Choose Active or Disabled.');
  }
  if (!cleanAuditReason) {
    throw new AdminOperatorError('operator_reason_required', 'Add a reason for this admin-team change.');
  }

  return inTransaction(db, async client => {
    await lockAdminEditorWorkspaceAccountsInTransaction(client, {
      actorAdminOperatorId: id
    });
    const actor = await lockRoster(client, actorId);
    const { rows } = await client.query(
      `SELECT id,email,role,status,last_login_at,created_at,updated_at
         FROM admin_operators WHERE id=$1 FOR UPDATE`,
      [id]
    );
    const target = rows[0];
    if (!target) {
      throw new AdminOperatorError('operator_not_found', 'Operator not found.', 404);
    }
    const nextRole = hasRole ? normalizedRole : target.role;
    const nextStatus = hasStatus ? normalizedStatus : target.status;
    if (nextRole === target.role && nextStatus === target.status) {
      throw new AdminOperatorError('operator_unchanged', 'That operator already has those settings.');
    }
    const wasActiveSuperAdmin = target.role === 'super_admin' && target.status === 'active';
    const willBeActiveSuperAdmin = nextRole === 'super_admin' && nextStatus === 'active';
    if (wasActiveSuperAdmin && !willBeActiveSuperAdmin) {
      const active = await client.query(
        `SELECT COUNT(*)::int AS count FROM admin_operators
          WHERE role='super_admin' AND status='active'`
      );
      if (Number(active.rows[0].count) <= 1) {
        throw new AdminOperatorError(
          'last_active_super_admin',
          'The final active Super Admin cannot be demoted or disabled.',
          409
        );
      }
    }
    if (Number(target.id) === Number(actorId)) {
      if (nextRole !== target.role) {
        throw new AdminOperatorError(
          'cannot_demote_self',
          'You cannot change your own Super Admin role.',
          409
        );
      }
      if (nextStatus !== 'active') {
        throw new AdminOperatorError(
          'cannot_disable_self',
          'You cannot disable your own operator account.',
          409
        );
      }
    }
    const targetKey = operatorTargetKey(id);
    if (!await authorize(client, targetKey)) {
      throw new AdminOperatorError(
        'admin_step_up_required',
        'Enter a fresh administrator passcode for this admin-team change.',
        403
      );
    }
    const before = operatorState(target);
    await invalidateAdminOperatorAccessInTransaction(client, {
      operatorId: id,
      cause: target.status !== 'disabled' && nextStatus === 'disabled'
        ? 'operator_disabled'
        : nextRole !== target.role
          ? 'operator_role_changed'
          : 'operator_reenabled',
      actorAdminOperatorId: actor.id,
      requestIp,
      userAgent
    });
    const updated = (await client.query(
      `UPDATE admin_operators
          SET role=$2,status=$3,updated_at=NOW()
        WHERE id=$1
        RETURNING id,email,role,status,last_login_at,created_at,updated_at`,
      [id, nextRole, nextStatus]
    )).rows[0];
    await writeAudit(client, {
      actor,
      target: updated,
      action: 'operator_updated',
      reason: cleanAuditReason,
      before,
      after: operatorState(updated),
      requestIp,
      userAgent
    });
    return serializeOperator(updated, actorId);
  });
}

async function revokeAdminOperatorSessions(db, {
  actorId,
  targetId,
  reason,
  requestIp,
  userAgent,
  authorize
}) {
  const id = Number(targetId);
  const cleanAuditReason = cleanReason(reason);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AdminOperatorError('operator_not_found', 'Operator not found.', 404);
  }
  if (!cleanAuditReason) {
    throw new AdminOperatorError('operator_reason_required', 'Add a reason for this admin-team change.');
  }

  return inTransaction(db, async client => {
    await lockAdminEditorWorkspaceAccountsInTransaction(client, {
      actorAdminOperatorId: id
    });
    const actor = await lockRoster(client, actorId);
    const { rows } = await client.query(
      `SELECT id,email,role,status,sessions_valid_after,last_login_at,created_at,updated_at
         FROM admin_operators WHERE id=$1 FOR UPDATE`,
      [id]
    );
    const target = rows[0];
    if (!target) {
      throw new AdminOperatorError('operator_not_found', 'Operator not found.', 404);
    }
    if (Number(target.id) === Number(actorId)) {
      throw new AdminOperatorError(
        'cannot_revoke_self',
        'Use Sign out to end your own operator session.',
        409
      );
    }
    const targetKey = operatorTargetKey(id);
    if (!await authorize(client, targetKey)) {
      throw new AdminOperatorError(
        'admin_step_up_required',
        'Enter a fresh administrator passcode for this admin-team change.',
        403
      );
    }
    const invalidated = await invalidateAdminOperatorAccessInTransaction(client, {
      operatorId: id,
      cause: 'operator_sessions_revoked',
      actorAdminOperatorId: actor.id,
      requestIp,
      userAgent
    });
    const updated = invalidated.operator;
    const invalidatedAt = invalidated.invalidatedAt;
    await writeAudit(client, {
      actor,
      target: updated,
      action: 'operator_sessions_revoked',
      reason: cleanAuditReason,
      before: { sessionsValidAfter: target.sessions_valid_after },
      after: { sessionsValidAfter: invalidatedAt },
      requestIp,
      userAgent
    });
    return serializeOperator(updated, actorId);
  });
}

module.exports = {
  AdminOperatorError,
  canonicalOperatorTargetKey,
  createAdminOperator,
  listAdminOperatorRoster,
  newOperatorTargetKey,
  normalizeOperatorEmail,
  operatorTargetKey,
  revokeAdminOperatorSessions,
  updateAdminOperator
};
