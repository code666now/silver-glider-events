const {
  IDENTITY_TYPES,
  VERIFICATION_SCOPES,
  CanonicalIdentityError,
  CanonicalIdentityConflictError,
  attachIdentity,
  attachVerifiedPhoneIdentity,
  normalizeIdentity,
  revokeActivePhoneIdentity,
  withCanonicalIdentityTransaction
} = require('./canonical-identity');

function positiveInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new CanonicalIdentityError(`${fieldName} must be a positive integer`, {
      code: 'invalid_identity_input'
    });
  }
  return number;
}

function publicIdentity(row) {
  return {
    id: Number(row.id),
    type: row.identity_type,
    value: row.value,
    verifiedAt: row.verified_at,
    isPrimary: Boolean(row.is_primary)
  };
}

async function listAccountIdentities(db, userIdValue) {
  const userId = positiveInteger(userIdValue, 'userId');
  const { rows } = await db.query(
    `SELECT id,user_id,identity_type,value,normalized_value,verified_at,is_primary
       FROM user_identities
      WHERE user_id=$1 AND revoked_at IS NULL
        AND verification_scope='account' AND verified_at IS NOT NULL
        AND identity_type IN ('email','phone')
      ORDER BY identity_type, is_primary DESC, created_at, id`,
    [userId]
  );
  return rows.map(publicIdentity);
}

async function makePrimaryEmail(db, { userId: userIdValue, identityId: identityIdValue }) {
  const userId = positiveInteger(userIdValue, 'userId');
  const identityId = positiveInteger(identityIdValue, 'identityId');
  return withCanonicalIdentityTransaction(db, async client => {
    const identityResult = await client.query(
      `SELECT id,user_id,identity_type,value,normalized_value,verified_at,is_primary
         FROM user_identities
        WHERE user_id=$1 AND identity_type='email' AND revoked_at IS NULL
          AND verification_scope='account' AND verified_at IS NOT NULL
        ORDER BY id
        FOR UPDATE`,
      [userId]
    );
    const target = identityResult.rows.find(row => Number(row.id) === identityId);
    if (!target) {
      throw new CanonicalIdentityError('That verified email is no longer connected.', {
        code: 'identity_not_found', status: 404
      });
    }

    const organizerResult = await client.query(
      'SELECT id,email FROM organizers WHERE id=$1 AND user_id=$1 FOR UPDATE',
      [userId]
    );
    if (!organizerResult.rows[0]) {
      throw new CanonicalIdentityError('Account could not be found.', {
        code: 'organizer_not_found', status: 404
      });
    }

    await client.query(
      `UPDATE user_identities
          SET is_primary=FALSE,updated_at=NOW()
        WHERE user_id=$1 AND identity_type='email' AND revoked_at IS NULL AND is_primary`,
      [userId]
    );
    await client.query(
      `UPDATE user_identities
          SET is_primary=TRUE,updated_at=NOW()
        WHERE id=$1`,
      [identityId]
    );
    try {
      await client.query(
        'UPDATE organizers SET email=$2,updated_at=NOW() WHERE id=$1',
        [userId, target.normalized_value]
      );
    } catch (error) {
      if (error?.code === '23505') {
        throw new CanonicalIdentityConflictError(
          'That email is already connected to another account. Nothing was changed.',
          {
            code: 'email_owner_conflict',
            identityType: IDENTITY_TYPES.EMAIL,
            normalizedValue: target.normalized_value,
            requestedUserId: userId
          }
        );
      }
      throw error;
    }
    await client.query('UPDATE users SET updated_at=NOW() WHERE id=$1', [userId]);
    return publicIdentity({ ...target, is_primary: true });
  });
}

async function removeAccountIdentity(db, { userId: userIdValue, identityId: identityIdValue }) {
  const userId = positiveInteger(userIdValue, 'userId');
  const identityId = positiveInteger(identityIdValue, 'identityId');
  const { rows } = await db.query(
    `SELECT id,user_id,identity_type,value,normalized_value,verified_at,is_primary
       FROM user_identities
      WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL
        AND verification_scope='account' AND verified_at IS NOT NULL
        AND identity_type IN ('email','phone')`,
    [identityId, userId]
  );
  const identity = rows[0];
  if (!identity) {
    throw new CanonicalIdentityError('That sign-in method is no longer connected.', {
      code: 'identity_not_found', status: 404
    });
  }

  if (identity.identity_type === IDENTITY_TYPES.PHONE) {
    const revoked = await revokeActivePhoneIdentity(db, {
      userId,
      phone: identity.normalized_value
    });
    return { identity: publicIdentity(identity), removed: revoked.identityRevoked || revoked.credentialRevoked };
  }

  return withCanonicalIdentityTransaction(db, async client => {
    const emailResult = await client.query(
      `SELECT id,user_id,identity_type,value,normalized_value,verified_at,is_primary
         FROM user_identities
        WHERE user_id=$1 AND identity_type='email' AND revoked_at IS NULL
          AND verification_scope='account' AND verified_at IS NOT NULL
        ORDER BY id
        FOR UPDATE`,
      [userId]
    );
    const locked = emailResult.rows.find(row => Number(row.id) === identityId);
    if (!locked) {
      throw new CanonicalIdentityError('That verified email is no longer connected.', {
        code: 'identity_not_found', status: 404
      });
    }
    if (locked.is_primary) {
      throw new CanonicalIdentityError('Make another email primary before removing this one.', {
        code: 'primary_identity_required', status: 409
      });
    }
    if (emailResult.rows.length <= 1) {
      throw new CanonicalIdentityError('Your account must keep one verified email.', {
        code: 'last_email_required', status: 409
      });
    }
    const revokedAt = new Date();
    await client.query(
      `UPDATE user_identities
          SET revoked_at=$2,is_primary=FALSE,updated_at=NOW()
        WHERE id=$1 AND revoked_at IS NULL`,
      [identityId, revokedAt]
    );
    await client.query(
      `UPDATE user_identity_verifications
          SET revoked_at=COALESCE(revoked_at,$2)
        WHERE user_identity_id=$1 AND revoked_at IS NULL`,
      [identityId, revokedAt]
    );
    await client.query(
      `UPDATE magic_link_tokens
          SET used_at=COALESCE(used_at,$2)
        WHERE LOWER(BTRIM(email))=$1 AND used_at IS NULL`,
      [locked.normalized_value, revokedAt]
    );
    await client.query('UPDATE users SET updated_at=NOW() WHERE id=$1', [userId]);
    return { identity: publicIdentity(locked), removed: true };
  });
}

async function replaceVerifiedPhone(db, {
  userId: userIdValue,
  phone,
  verifiedAt,
  verificationSource = 'account_settings.twilio_verify'
}) {
  const userId = positiveInteger(userIdValue, 'userId');
  const normalizedPhone = normalizeIdentity(IDENTITY_TYPES.PHONE, phone).normalizedValue;
  return withCanonicalIdentityTransaction(db, async client => {
    const organizerResult = await client.query(
      'SELECT id,is_admin FROM organizers WHERE id=$1 AND user_id=$1',
      [userId]
    );
    const organizer = organizerResult.rows[0];
    if (!organizer) {
      throw new CanonicalIdentityError('Account could not be found.', {
        code: 'organizer_not_found', status: 404
      });
    }
    if (organizer.is_admin) {
      throw new CanonicalIdentityError('Administrators use email sign-in.', {
        code: 'email_sign_in_required', status: 403
      });
    }

    const existingResult = await client.query(
      `SELECT normalized_value
         FROM user_identities
        WHERE user_id=$1 AND identity_type='phone' AND revoked_at IS NULL
          AND verification_scope='account' AND verified_at IS NOT NULL
        ORDER BY is_primary DESC,id`,
      [userId]
    );
    for (const existing of existingResult.rows) {
      if (existing.normalized_value === normalizedPhone) continue;
      await revokeActivePhoneIdentity(client, {
        userId,
        phone: existing.normalized_value,
        revokedAt: new Date()
      });
    }

    return attachVerifiedPhoneIdentity(client, {
      userId,
      phone: normalizedPhone,
      verifiedAt,
      verificationSource
    });
  });
}

async function replaceVerifiedEmail(db, {
  userId: userIdValue,
  email,
  verifiedAt,
  verificationSource = 'admin_identity_change.email_link',
  sourceRecordId = null
}) {
  const userId = positiveInteger(userIdValue, 'userId');
  const normalizedEmail = normalizeIdentity(IDENTITY_TYPES.EMAIL, email).normalizedValue;
  return withCanonicalIdentityTransaction(db, async client => {
    // Canonical identity helpers lock the global value before the account.
    // Keep that order here so a verification cannot deadlock a normal sign-in.
    const candidateResult = await client.query(
      `SELECT id,user_id,normalized_value
         FROM user_identities
        WHERE identity_type='email' AND normalized_value=$1 AND revoked_at IS NULL
        LIMIT 1 FOR UPDATE`,
      [normalizedEmail]
    );
    const candidate = candidateResult.rows[0] || null;
    if (candidate && Number(candidate.user_id) !== userId) {
      throw new CanonicalIdentityConflictError(
        'That email is already connected to another account.',
        {
          code: 'email_owner_conflict',
          identityType: IDENTITY_TYPES.EMAIL,
          normalizedValue: normalizedEmail,
          requestedUserId: userId,
          existingUserId: Number(candidate.user_id)
        }
      );
    }

    const organizerResult = await client.query(
      `SELECT o.id,o.email,u.account_status
         FROM users u JOIN organizers o ON o.user_id=u.id
        WHERE u.id=$1 FOR UPDATE OF u,o`,
      [userId]
    );
    const organizer = organizerResult.rows[0];
    if (!organizer) {
      throw new CanonicalIdentityError('Account could not be found.', {
        code: 'organizer_not_found', status: 404
      });
    }
    if (organizer.account_status !== 'active') {
      throw new CanonicalIdentityError('This account is not active.', {
        code: 'account_inactive', status: 409
      });
    }

    const currentResult = await client.query(
      `SELECT id,normalized_value,is_primary
         FROM user_identities
        WHERE user_id=$1 AND identity_type='email' AND revoked_at IS NULL
        ORDER BY id FOR UPDATE`,
      [userId]
    );
    // Replacing the primary sign-in address must not remove secondary/recovery
    // addresses the customer deliberately connected earlier.
    const oldIdentities = currentResult.rows.filter(
      identity => identity.normalized_value !== normalizedEmail && identity.is_primary
    );
    const oldIds = oldIdentities.map(identity => Number(identity.id));
    const revokedAt = new Date();
    if (oldIds.length) {
      await client.query(
        `UPDATE user_identities
            SET revoked_at=$2,is_primary=FALSE,updated_at=NOW()
          WHERE id=ANY($1::bigint[]) AND revoked_at IS NULL`,
        [oldIds, revokedAt]
      );
      await client.query(
        `UPDATE user_identity_verifications
            SET revoked_at=COALESCE(revoked_at,$2)
          WHERE user_identity_id=ANY($1::bigint[]) AND revoked_at IS NULL`,
        [oldIds, revokedAt]
      );
      await client.query(
        `UPDATE magic_link_tokens
            SET used_at=COALESCE(used_at,$2)
          WHERE LOWER(BTRIM(email))=ANY($1::text[]) AND used_at IS NULL`,
        [oldIdentities.map(identity => identity.normalized_value), revokedAt]
      );
    }

    const attached = await attachIdentity(client, {
      userId,
      identityType: IDENTITY_TYPES.EMAIL,
      value: normalizedEmail,
      verifiedAt,
      verificationScope: VERIFICATION_SCOPES.ACCOUNT,
      verificationSource,
      sourceRecordId,
      isPrimary: true
    });
    try {
      await client.query(
        'UPDATE organizers SET email=$2,updated_at=NOW() WHERE user_id=$1',
        [userId, normalizedEmail]
      );
    } catch (error) {
      if (error?.code === '23505') {
        throw new CanonicalIdentityConflictError(
          'That email is already connected to another account.',
          {
            code: 'email_owner_conflict',
            identityType: IDENTITY_TYPES.EMAIL,
            normalizedValue: normalizedEmail,
            requestedUserId: userId
          }
        );
      }
      throw error;
    }
    await client.query('UPDATE users SET updated_at=NOW() WHERE id=$1', [userId]);
    return attached;
  });
}

async function recordOwnershipConflict(db, {
  identityType,
  normalizedValue,
  candidateUserId: candidateUserIdValue,
  conflictingUserId: conflictingUserIdValue = null,
  verificationSource,
  sourceRecordId: sourceRecordIdValue
}) {
  const candidateUserId = positiveInteger(candidateUserIdValue, 'candidateUserId');
  const sourceRecordId = positiveInteger(sourceRecordIdValue, 'sourceRecordId');
  const conflictingUserId = conflictingUserIdValue
    ? positiveInteger(conflictingUserIdValue, 'conflictingUserId')
    : null;
  const normalized = normalizeIdentity(identityType, normalizedValue);
  await db.query(
    `INSERT INTO user_identity_conflicts (
       identity_type,normalized_value,candidate_user_id,conflicting_user_id,
       verification_source,source_record_id,reason
     )
     VALUES ($1,$2,$3,$4,$5,$6,'already_claimed')
     ON CONFLICT (identity_type,normalized_value,candidate_user_id,verification_source,source_record_id)
     DO NOTHING`,
    [
      normalized.identityType,
      normalized.normalizedValue,
      candidateUserId,
      conflictingUserId,
      String(verificationSource || '').slice(0, 160),
      sourceRecordId
    ]
  );
}

module.exports = {
  listAccountIdentities,
  makePrimaryEmail,
  publicIdentity,
  recordOwnershipConflict,
  removeAccountIdentity,
  replaceVerifiedEmail,
  replaceVerifiedPhone
};
