const crypto = require('crypto');
const { readCookie } = require('./private-events');

const COOKIE_NAME = 'sge_admin_editor';
const MAX_AGE_SECONDS = 2 * 60 * 60;

class AdminEditorWorkspaceError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'AdminEditorWorkspaceError';
    this.code = code;
    this.status = status;
  }
}

function tokenHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function readAdminEditorCookie(req) {
  return readCookie(req, COOKIE_NAME);
}

function cookieAttributes(maxAgeSeconds) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `Path=/admin-editor; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

function setAdminEditorCookie(res, token) {
  res.append('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieAttributes(MAX_AGE_SECONDS)}`);
}

function clearAdminEditorCookie(res) {
  res.append('Set-Cookie', `${COOKIE_NAME}=; ${cookieAttributes(0)}`);
}

function safeWorkspace(row) {
  return {
    id: Number(row.id),
    doneForYouClientId: Number(row.done_for_you_client_id),
    targetUserId: Number(row.target_user_id),
    organizerId: Number(row.organizer_id),
    eventId: row.event_id == null ? null : Number(row.event_id),
    status: row.status,
    expiresAt: row.expires_at
  };
}

async function writeAudit(db, {
  operatorId,
  targetUserId,
  actionType,
  reason,
  beforeState = {},
  afterState = {},
  metadata = {},
  requestIp = null,
  userAgent = null
}) {
  await db.query(
    `INSERT INTO admin_account_audit_log
       (actor_user_id,actor_admin_operator_id,target_user_id,action_type,reason,
        before_state,after_state,metadata,request_ip,user_agent)
     VALUES (NULL,$1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)`,
    [operatorId, targetUserId, actionType, reason, JSON.stringify(beforeState),
     JSON.stringify(afterState), JSON.stringify(metadata), requestIp, userAgent]
  );
}

async function writeLifecycleAudit(db, workspace, {
  status,
  cause,
  actorAdminOperatorId = workspace.actor_admin_operator_id,
  requestIp = null,
  userAgent = null
}) {
  const actionType = status === 'expired'
    ? 'done_for_you_event_workspace_expired'
    : status === 'completed'
      ? 'done_for_you_event_workspace_completed'
      : 'done_for_you_event_workspace_revoked';
  const reason = cause === 'replacement'
    ? 'Administrator replaced a scoped Done For You event workspace'
    : cause === 'admin_logout'
      ? 'Administrator signed out of a scoped Done For You event workspace'
      : cause === 'operator_disabled'
        ? 'Super Admin disabled the administrator assigned to a scoped Done For You event workspace'
        : cause === 'operator_sessions_revoked'
          ? 'Super Admin revoked access for the administrator assigned to a scoped Done For You event workspace'
          : cause === 'operator_role_changed'
            ? 'Super Admin changed access for the administrator assigned to a scoped Done For You event workspace'
      : cause === 'scope_unavailable'
        ? 'Done For You event workspace scope became unavailable'
        : status === 'expired'
          ? 'Done For You event workspace expired automatically'
          : status === 'completed'
            ? 'Administrator completed a scoped Done For You event workspace'
            : 'Done For You event workspace was revoked';
  await writeAudit(db, {
    operatorId: actorAdminOperatorId,
    targetUserId: workspace.target_user_id,
    actionType,
    reason,
    beforeState: {
      workspaceId: Number(workspace.id),
      status: 'active',
      eventId: workspace.event_id == null ? null : Number(workspace.event_id)
    },
    afterState: { workspaceId: Number(workspace.id), status },
    metadata: {
      doneForYouClientId: Number(workspace.done_for_you_client_id),
      organizerId: Number(workspace.organizer_id),
      workspaceOperatorId: Number(workspace.actor_admin_operator_id),
      cause
    },
    requestIp,
    userAgent
  });
}

async function openAdminEditorWorkspace(db, {
  doneForYouClientId,
  actorAdminOperatorId,
  sessionIssuedAt,
  eventId = null,
  requestIp = null,
  userAgent = null
}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Lock the operator first so two starts by one operator cannot race the
    // one-active-workspace constraint. This also rechecks active status in the
    // same transaction that creates the grant.
    const operator = (await client.query(
      `SELECT id,sessions_valid_after FROM admin_operators
        WHERE id=$1 AND status='active'
        FOR UPDATE`,
      [actorAdminOperatorId]
    )).rows[0];
    if (!operator) {
      throw new AdminEditorWorkspaceError(
        'admin_operator_not_active',
        'This administrator session is no longer active.',
        403
      );
    }
    const issuedAt = Number(sessionIssuedAt);
    const credentialCutoff = new Date(operator.sessions_valid_after).getTime();
    if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0 ||
        !Number.isFinite(credentialCutoff) || issuedAt < credentialCutoff) {
      throw new AdminEditorWorkspaceError(
        'admin_editor_admin_session_revoked',
        'This administrator session is no longer active.',
        401
      );
    }

    const expiredForOperator = (await client.query(
      `UPDATE admin_event_editor_workspaces
          SET status='expired',closed_at=NOW()
        WHERE actor_admin_operator_id=$1 AND status='active' AND expires_at<=NOW()
        RETURNING *`,
      [actorAdminOperatorId]
    )).rows;
    for (const expired of expiredForOperator) {
      await writeLifecycleAudit(client, expired, {
        status: 'expired', cause: 'ttl', requestIp, userAgent
      });
    }

    const marker = (await client.query(
      `SELECT id,target_user_id
         FROM admin_done_for_you_clients
        WHERE id=$1
        FOR UPDATE`,
      [doneForYouClientId]
    )).rows[0];
    if (!marker) {
      throw new AdminEditorWorkspaceError(
        'done_for_you_client_not_found',
        'Done For You client not found.',
        404
      );
    }

    const target = (await client.query(
      `SELECT id,account_status FROM users WHERE id=$1 FOR UPDATE`,
      [marker.target_user_id]
    )).rows[0];
    const organizer = (await client.query(
      `SELECT id,user_id FROM organizers WHERE user_id=$1 FOR UPDATE`,
      [marker.target_user_id]
    )).rows[0];
    if (!target || target.account_status !== 'active' || !organizer ||
        Number(organizer.user_id) !== Number(marker.target_user_id)) {
      throw new AdminEditorWorkspaceError(
        'done_for_you_target_not_active',
        'This client account cannot be edited right now.',
        409
      );
    }

    if (eventId != null) {
      const event = (await client.query(
        `SELECT id,organizer_id,status FROM events WHERE id=$1 FOR UPDATE`,
        [eventId]
      )).rows[0];
      if (!event || Number(event.organizer_id) !== Number(organizer.id) || event.status !== 'draft') {
        throw new AdminEditorWorkspaceError(
          'admin_editor_draft_not_available',
          'Choose an unpublished draft that belongs to this Host Page.',
          409
        );
      }
      const expiredForEvent = (await client.query(
        `UPDATE admin_event_editor_workspaces
            SET status='expired',closed_at=NOW()
          WHERE event_id=$1 AND status='active' AND expires_at<=NOW()
          RETURNING *`,
        [eventId]
      )).rows;
      for (const expired of expiredForEvent) {
        await writeLifecycleAudit(client, expired, {
          status: 'expired', cause: 'ttl', requestIp, userAgent
        });
      }
      const inUse = (await client.query(
        `SELECT id,actor_admin_operator_id FROM admin_event_editor_workspaces
          WHERE event_id=$1 AND status='active'
          LIMIT 1`,
        [eventId]
      )).rows[0];
      if (inUse && Number(inUse.actor_admin_operator_id) !== Number(actorAdminOperatorId)) {
        throw new AdminEditorWorkspaceError(
          'admin_editor_draft_in_use',
          'Another administrator is already editing this draft.',
          409
        );
      }
    }

    const replaced = (await client.query(
      `UPDATE admin_event_editor_workspaces
          SET status='revoked',closed_at=NOW()
        WHERE actor_admin_operator_id=$1 AND status='active'
        RETURNING *`,
      [actorAdminOperatorId]
    )).rows;
    for (const prior of replaced) {
      await writeLifecycleAudit(client, prior, {
        status: 'revoked', cause: 'replacement', requestIp, userAgent
      });
    }

    const token = newToken();
    const workspace = (await client.query(
      `INSERT INTO admin_event_editor_workspaces
         (token_hash,done_for_you_client_id,actor_admin_operator_id,target_user_id,
          organizer_id,event_id,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW() + make_interval(secs => $7))
       RETURNING id,done_for_you_client_id,target_user_id,organizer_id,event_id,status,expires_at`,
      [tokenHash(token), doneForYouClientId, actorAdminOperatorId, marker.target_user_id,
       organizer.id, eventId, MAX_AGE_SECONDS]
    )).rows[0];

    await writeAudit(client, {
      operatorId: actorAdminOperatorId,
      targetUserId: marker.target_user_id,
      actionType: 'done_for_you_event_workspace_opened',
      reason: 'Administrator opened a scoped Done For You event workspace',
      afterState: {
        workspaceId: Number(workspace.id),
        status: 'active',
        eventId: eventId == null ? null : Number(eventId)
      },
      metadata: {
        doneForYouClientId: Number(doneForYouClientId),
        organizerId: Number(organizer.id),
        replacedWorkspaceIds: replaced.map(row => Number(row.id))
      },
      requestIp,
      userAgent
    });
    await client.query('COMMIT');
    return { token, workspace: safeWorkspace(workspace) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function readAdminEditorWorkspace(db, rawToken) {
  if (!rawToken || String(rawToken).length > 200) return null;
  const { rows } = await db.query(
    `SELECT workspace.*,
            marker.target_user_id AS current_target_user_id,
            target.account_status AS target_account_status,
            organizer.user_id AS organizer_user_id,
            operator.status AS operator_status,
            event.organizer_id AS event_organizer_id,
            event.status AS event_status
       FROM admin_event_editor_workspaces workspace
       LEFT JOIN admin_done_for_you_clients marker
         ON marker.id=workspace.done_for_you_client_id
       LEFT JOIN users target ON target.id=workspace.target_user_id
       LEFT JOIN organizers organizer
         ON organizer.id=workspace.organizer_id
       LEFT JOIN admin_operators operator
         ON operator.id=workspace.actor_admin_operator_id
       LEFT JOIN events event ON event.id=workspace.event_id
      WHERE workspace.token_hash=$1
      LIMIT 1`,
    [tokenHash(rawToken)]
  );
  return rows[0] || null;
}

async function closeWorkspace(db, {
  workspaceId,
  actorAdminOperatorId,
  status,
  cause,
  requestIp = null,
  userAgent = null
}) {
  if (!['completed', 'expired', 'revoked'].includes(status)) {
    throw new Error('Invalid workspace close status');
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Every workspace lifecycle transaction uses the same operator ->
    // workspace lock order as open and logout.
    await client.query(
      'SELECT id FROM admin_operators WHERE id=$1 FOR UPDATE',
      [actorAdminOperatorId]
    );
    const workspace = (await client.query(
      `SELECT * FROM admin_event_editor_workspaces
        WHERE id=$1 AND actor_admin_operator_id=$2
        FOR UPDATE`,
      [workspaceId, actorAdminOperatorId]
    )).rows[0];
    if (!workspace || workspace.status !== 'active') {
      await client.query('COMMIT');
      return false;
    }
    await client.query(
      `UPDATE admin_event_editor_workspaces
          SET status=$2,closed_at=NOW()
        WHERE id=$1`,
      [workspace.id, status]
    );
    await writeLifecycleAudit(client, workspace, {
      status, cause, requestIp, userAgent
    });
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function exitAdminEditorWorkspace(db, {
  workspaceId,
  actorAdminOperatorId,
  requestIp = null,
  userAgent = null
}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const operator = (await client.query(
      `SELECT id FROM admin_operators
        WHERE id=$1 AND status='active'
        FOR UPDATE`,
      [actorAdminOperatorId]
    )).rows[0];
    if (!operator) {
      throw new AdminEditorWorkspaceError(
        'admin_operator_not_active',
        'This administrator session is no longer active.',
        403
      );
    }
    const workspace = (await client.query(
      `SELECT workspace.*
         FROM admin_event_editor_workspaces workspace
        WHERE workspace.id=$1 AND workspace.actor_admin_operator_id=$2
        FOR UPDATE OF workspace`,
      [workspaceId, actorAdminOperatorId]
    )).rows[0];
    if (!workspace || workspace.status !== 'active') {
      throw new AdminEditorWorkspaceError(
        'admin_editor_workspace_inactive',
        'This editor workspace is no longer active.',
        409
      );
    }
    if (new Date(workspace.expires_at).getTime() <= Date.now()) {
      await client.query(
        `UPDATE admin_event_editor_workspaces
            SET status='expired',closed_at=NOW()
          WHERE id=$1`,
        [workspace.id]
      );
      await writeLifecycleAudit(client, workspace, {
        status: 'expired', cause: 'ttl', requestIp, userAgent
      });
      await client.query('COMMIT');
      throw new AdminEditorWorkspaceError(
        'admin_editor_workspace_expired',
        'This editor workspace has expired.',
        401
      );
    }
    await client.query(
      `UPDATE admin_event_editor_workspaces
          SET status='exited',closed_at=NOW()
        WHERE id=$1`,
      [workspace.id]
    );
    await writeAudit(client, {
      operatorId: actorAdminOperatorId,
      targetUserId: workspace.target_user_id,
      actionType: 'done_for_you_event_workspace_exited',
      reason: 'Administrator exited a scoped Done For You event workspace',
      beforeState: {
        workspaceId: Number(workspace.id),
        status: 'active',
        eventId: workspace.event_id == null ? null : Number(workspace.event_id)
      },
      afterState: { workspaceId: Number(workspace.id), status: 'exited' },
      metadata: { doneForYouClientId: Number(workspace.done_for_you_client_id) },
      requestIp,
      userAgent
    });
    await client.query('COMMIT');
    return {
      redirect: `/admin/done-for-you/${Number(workspace.done_for_you_client_id)}`
    };
  } catch (error) {
    // An expired workspace is deliberately committed before returning 401.
    if (error.code !== 'admin_editor_workspace_expired') {
      await client.query('ROLLBACK').catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

async function revokeAdminEditorWorkspacesForOperator(db, {
  actorAdminOperatorId,
  sessionIssuedAt,
  requestIp = null,
  userAgent = null
}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const invalidated = await invalidateAdminOperatorAccessInTransaction(client, {
      operatorId: actorAdminOperatorId,
      sessionIssuedAt,
      requireActive: true,
      cause: 'admin_logout',
      actorAdminOperatorId,
      requestIp,
      userAgent
    });
    await client.query('COMMIT');
    return invalidated.workspaceCount;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// The caller owns the transaction. Every credential lifecycle path takes the
// operator lock before its workspace rows, advances the credential epoch, and
// consumes pending challenges/proofs in that same transaction.
async function invalidateAdminOperatorAccessInTransaction(client, {
  operatorId,
  sessionIssuedAt = null,
  requireActive = false,
  cause,
  actorAdminOperatorId = operatorId,
  requestIp = null,
  userAgent = null
}) {
  const operator = (await client.query(
    `SELECT id,email,role,status,sessions_valid_after,last_login_at,created_at,updated_at
       FROM admin_operators
      WHERE id=$1
      FOR UPDATE`,
    [operatorId]
  )).rows[0];
  if (!operator || (requireActive && operator.status !== 'active')) {
    return { operator: null, invalidatedAt: null, workspaceCount: 0 };
  }
  if (sessionIssuedAt != null) {
    const issuedAt = Number(sessionIssuedAt);
    const cutoff = new Date(operator.sessions_valid_after).getTime();
    if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0 ||
        !Number.isFinite(cutoff) || issuedAt < cutoff) {
      return { operator: null, invalidatedAt: null, workspaceCount: 0 };
    }
  }

  const active = (await client.query(
    `SELECT workspace.*
       FROM admin_event_editor_workspaces workspace
      WHERE workspace.actor_admin_operator_id=$1 AND workspace.status='active'
      ORDER BY workspace.id
      FOR UPDATE OF workspace`,
    [operatorId]
  )).rows;
  if (active.length) {
    await client.query(
      `UPDATE admin_event_editor_workspaces
          SET status='revoked',closed_at=NOW()
        WHERE actor_admin_operator_id=$1 AND status='active'`,
      [operatorId]
    );
    for (const workspace of active) {
      await writeLifecycleAudit(client, workspace, {
        status: 'revoked',
        cause,
        actorAdminOperatorId,
        requestIp,
        userAgent
      });
    }
  }
  const updated = (await client.query(
    `UPDATE admin_operators
        SET sessions_valid_after=GREATEST(sessions_valid_after,clock_timestamp()),
            updated_at=clock_timestamp()
      WHERE id=$1
      RETURNING id,email,role,status,sessions_valid_after,last_login_at,created_at,updated_at`,
    [operatorId]
  )).rows[0];
  const invalidatedAt = updated.sessions_valid_after;
  await client.query(
    `UPDATE admin_auth_challenges SET used_at=$2
      WHERE operator_id=$1 AND used_at IS NULL`,
    [operatorId, invalidatedAt]
  );
  await client.query(
    `UPDATE admin_action_proofs SET consumed_at=$2
      WHERE operator_id=$1 AND consumed_at IS NULL`,
    [operatorId, invalidatedAt]
  );
  return { operator: updated, invalidatedAt, workspaceCount: active.length };
}

module.exports = {
  AdminEditorWorkspaceError,
  COOKIE_NAME,
  MAX_AGE_SECONDS,
  clearAdminEditorCookie,
  closeWorkspace,
  exitAdminEditorWorkspace,
  invalidateAdminOperatorAccessInTransaction,
  openAdminEditorWorkspace,
  readAdminEditorCookie,
  readAdminEditorWorkspace,
  revokeAdminEditorWorkspacesForOperator,
  safeWorkspace,
  setAdminEditorCookie,
  tokenHash
};
