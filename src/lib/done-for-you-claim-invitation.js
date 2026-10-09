const { createSignInChallenge } = require('./sign-in-challenges');
const { tokenHash } = require('./guest-session');
const { sendAccountClaimInvitation } = require('./mailer');
const { outboundDeliveryLockKey } = require('./outbound-account-status');
const { IDENTITY_TYPES, normalizeIdentity } = require('./canonical-identity');
const {
  DoneForYouProvisioningError,
  readDoneForYouClient
} = require('./admin-done-for-you');

const CLAIM_TTL_MINUTES = 7 * 24 * 60;

async function writeClaimAudit(db, {
  actorAdminOperatorId,
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
    [
      actorAdminOperatorId,
      targetUserId,
      actionType,
      reason,
      JSON.stringify(beforeState),
      JSON.stringify(afterState),
      JSON.stringify(metadata),
      requestIp,
      userAgent
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

async function sendDoneForYouClaimInvitation({
  pool,
  markerId,
  actorAdminOperatorId,
  requestedEmail = '',
  requestIp = null,
  userAgent = null,
  deliver = sendAccountClaimInvitation,
  metadata = {}
}) {
  const connection = await pool.connect();
  let targetUserId = null;
  let normalizedEmail = null;
  let invitation = null;
  let challenge = null;
  let lockHeld = false;
  try {
    const marker = await readDoneForYouClient(connection, markerId);
    if (!marker) {
      throw new DoneForYouProvisioningError(
        'done_for_you_client_not_found',
        'Done For You client not found.',
        404
      );
    }
    const recipientEmail = String(requestedEmail || '').trim() ||
      marker.identities.find(identity => identity.type === 'email')?.value;
    try {
      normalizedEmail = normalizeIdentity(IDENTITY_TYPES.EMAIL, recipientEmail).normalizedValue;
    } catch (_) {
      throw new DoneForYouProvisioningError(
        'claim_email_not_available',
        'Add a valid client email before sending a claim invitation.',
        409
      );
    }
    targetUserId = marker.owner.userId;
    await connection.query(
      'SELECT pg_advisory_lock(hashtext($1))',
      [outboundDeliveryLockKey(targetUserId)]
    );
    lockHeld = true;

    await connection.query('BEGIN');
    const emailIdentity = (await connection.query(
      `SELECT id,verification_scope,verified_at
         FROM user_identities
        WHERE user_id=$1 AND identity_type='email' AND normalized_value=$2
          AND revoked_at IS NULL
        FOR UPDATE`,
      [targetUserId, normalizedEmail]
    )).rows[0];
    const locked = await readDoneForYouClient(connection, markerId, { forUpdate: true });
    if (!locked || locked.owner.status !== 'active') {
      throw new DoneForYouProvisioningError('account_not_active', 'This client account is not active.', 409);
    }
    if (locked.owner.claimed) {
      throw new DoneForYouProvisioningError('account_already_claimed', 'This client already controls the account.', 409);
    }
    if (!emailIdentity) {
      throw new DoneForYouProvisioningError(
        'claim_email_not_owned',
        'That email is not attached to this prepared client.',
        409
      );
    }

    const prior = await connection.query(
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
      await connection.query(
        'UPDATE admin_account_invitations SET revoked_at=NOW() WHERE id=ANY($1::bigint[])',
        [ids]
      );
      await connection.query(
        'UPDATE magic_link_tokens SET used_at=COALESCE(used_at,NOW()) WHERE id=ANY($1::int[])',
        [tokenIds]
      );
      await writeClaimAudit(connection, {
        actorAdminOperatorId,
        targetUserId,
        actionType: 'done_for_you_claim_invitations_revoked',
        reason: 'Replace client claim invitation',
        beforeState: { activeInvitationIds: ids },
        afterState: { activeInvitationIds: [] },
        metadata: { markerId, ...metadata },
        requestIp,
        userAgent
      });
    }

    challenge = await createSignInChallenge(connection, {
      email: normalizedEmail,
      intent: 'claim_account',
      returnPath: '/dashboard',
      ttlMinutes: CLAIM_TTL_MINUTES,
      withCode: false
    });
    const tokenId = challenge.id || (await connection.query(
      'SELECT id FROM magic_link_tokens WHERE token=$1',
      [tokenHash(challenge.token)]
    )).rows[0]?.id;
    invitation = (await connection.query(
      `INSERT INTO admin_account_invitations
         (email,name,prepare_host_page,magic_link_token_id,
          created_by_admin_operator_id,target_user_id,expires_at)
       VALUES ($1,$2,TRUE,$3,$4,$5,NOW() + INTERVAL '7 days')
       RETURNING id,email,name,target_user_id,created_at,expires_at`,
      [normalizedEmail, locked.owner.name || 'Client', tokenId, actorAdminOperatorId, targetUserId]
    )).rows[0];
    await writeClaimAudit(connection, {
      actorAdminOperatorId,
      targetUserId,
      actionType: 'done_for_you_claim_invitation_created',
      reason: 'Send prepared account claim invitation',
      beforeState: { invitationStatus: null },
      afterState: { invitationStatus: 'creating' },
      metadata: { markerId, invitationId: Number(invitation.id), ...metadata },
      requestIp,
      userAgent
    });
    await connection.query('COMMIT');

    const link = `${String(process.env.APP_URL || '').replace(/\/$/, '')}/auth/verify?token=${challenge.token}`;
    try {
      await deliver({ to: normalizedEmail, link, name: locked.owner.name || 'there' });
    } catch (error) {
      await connection.query('BEGIN');
      const failed = await connection.query(
        `UPDATE admin_account_invitations
            SET delivery_failed_at=NOW()
          WHERE id=$1 AND sent_at IS NULL AND claimed_at IS NULL AND revoked_at IS NULL
          RETURNING magic_link_token_id,delivery_failed_at`,
        [invitation.id]
      );
      if (failed.rows[0]) {
        await connection.query(
          'UPDATE magic_link_tokens SET used_at=COALESCE(used_at,NOW()) WHERE id=$1',
          [failed.rows[0].magic_link_token_id]
        );
        await writeClaimAudit(connection, {
          actorAdminOperatorId,
          targetUserId,
          actionType: 'done_for_you_claim_invitation_delivery_failed',
          reason: 'Prepared account claim delivery failed',
          beforeState: { invitationStatus: 'creating' },
          afterState: { invitationStatus: 'delivery_failed' },
          metadata: { markerId, invitationId: Number(invitation.id), ...metadata },
          requestIp,
          userAgent
        });
      }
      await logClaimDelivery(connection, normalizedEmail, targetUserId, 'failed', error);
      await connection.query('COMMIT');
      throw error;
    }

    await connection.query('BEGIN');
    const sent = await connection.query(
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
    await writeClaimAudit(connection, {
      actorAdminOperatorId,
      targetUserId,
      actionType: 'done_for_you_claim_invitation_sent',
      reason: 'Prepared account claim invitation sent',
      beforeState: { invitationStatus: 'creating' },
      afterState: { invitationStatus: 'sent', sentAt: sent.rows[0].sent_at },
      metadata: { markerId, invitationId: Number(invitation.id), ...metadata },
      requestIp,
      userAgent
    });
    await logClaimDelivery(connection, normalizedEmail, targetUserId, 'sent');
    await connection.query('COMMIT');
    return {
      id: Number(invitation.id),
      email: normalizedEmail,
      status: 'sent',
      sentAt: sent.rows[0].sent_at,
      expiresAt: invitation.expires_at,
      targetUserId
    };
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    let releaseError = null;
    if (lockHeld) {
      try {
        const unlocked = await connection.query(
          'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
          [outboundDeliveryLockKey(targetUserId)]
        );
        if (!unlocked.rows[0]?.unlocked) throw new Error('Done For You delivery lock was not held');
      } catch (error) {
        console.error('[done-for-you] failed to release outbound delivery lock', {
          targetUserId,
          error: error.message
        });
        releaseError = error;
      }
    }
    connection.release(releaseError || undefined);
  }
}

module.exports = {
  CLAIM_TTL_MINUTES,
  sendDoneForYouClaimInvitation
};
