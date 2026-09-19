const { normalizeE164 } = require('./sms');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IDENTITY_TYPES = Object.freeze({
  EMAIL: 'email',
  PHONE: 'phone',
  GOOGLE: 'google'
});
const VERIFICATION_SCOPES = Object.freeze({
  UNVERIFIED: 'unverified',
  ACCOUNT: 'account',
  EVENT: 'event',
  PHOTO: 'photo'
});
const SCOPE_STRENGTH = Object.freeze({
  [VERIFICATION_SCOPES.UNVERIFIED]: 0,
  [VERIFICATION_SCOPES.EVENT]: 0,
  [VERIFICATION_SCOPES.PHOTO]: 0,
  [VERIFICATION_SCOPES.ACCOUNT]: 1
});

class CanonicalIdentityError extends Error {
  constructor(message, { code = 'canonical_identity_error', status = 400 } = {}) {
    super(message);
    this.name = 'CanonicalIdentityError';
    this.code = code;
    this.status = status;
  }
}

class CanonicalIdentityConflictError extends CanonicalIdentityError {
  constructor(message, {
    code = 'identity_conflict',
    identityType = null,
    normalizedValue = null,
    requestedUserId = null,
    existingUserId = null
  } = {}) {
    super(message, { code, status: 409 });
    this.name = 'CanonicalIdentityConflictError';
    this.identityType = identityType;
    this.normalizedValue = normalizedValue;
    this.requestedUserId = requestedUserId;
    this.existingUserId = existingUserId;
  }
}

function normalizeIdentityType(value) {
  const identityType = String(value || '').trim().toLowerCase();
  if (!Object.values(IDENTITY_TYPES).includes(identityType)) {
    throw new CanonicalIdentityError('Unsupported identity type', {
      code: 'invalid_identity_type'
    });
  }
  return identityType;
}

function normalizeEmail(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized.length > 320 || !EMAIL_PATTERN.test(normalized)) {
    throw new CanonicalIdentityError('Enter a valid email address', {
      code: 'invalid_email'
    });
  }
  return normalized;
}

function normalizeGoogleSubject(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 2048 || /\s/.test(normalized)) {
    throw new CanonicalIdentityError('Google identity subject is invalid', {
      code: 'invalid_google_subject'
    });
  }
  return normalized;
}

function normalizeIdentity(identityTypeValue, value) {
  const identityType = normalizeIdentityType(identityTypeValue);
  if (identityType === IDENTITY_TYPES.EMAIL) {
    return {
      identityType,
      value: String(value || '').trim(),
      normalizedValue: normalizeEmail(value)
    };
  }
  if (identityType === IDENTITY_TYPES.PHONE) {
    let normalizedValue;
    try {
      normalizedValue = normalizeE164(value);
    } catch (error) {
      throw new CanonicalIdentityError(error.message, { code: 'invalid_phone' });
    }
    return { identityType, value: normalizedValue, normalizedValue };
  }
  const normalizedValue = normalizeGoogleSubject(value);
  return { identityType, value: normalizedValue, normalizedValue };
}

function positiveInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new CanonicalIdentityError(`${fieldName} must be a positive integer`, {
      code: 'invalid_identity_input'
    });
  }
  return number;
}

function optionalPositiveInteger(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  return positiveInteger(value, fieldName);
}

function normalizeName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name) return null;
  if (name.length > 160) {
    throw new CanonicalIdentityError('User name is too long', {
      code: 'invalid_user_name'
    });
  }
  return name;
}

function normalizeSource(value) {
  const source = String(value || '').trim();
  if (!source || source.length > 160) {
    throw new CanonicalIdentityError('Identity verification source is required', {
      code: 'invalid_verification_source'
    });
  }
  return source;
}

function validTimestamp(value) {
  return value instanceof Date
    ? !Number.isNaN(value.getTime())
    : typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
}

function normalizeVerification({
  verificationScope = VERIFICATION_SCOPES.UNVERIFIED,
  verifiedAt = null,
  verificationSource,
  sourceRecordId = null,
  verificationContextType = null,
  verificationContextId = null
}) {
  const scope = String(verificationScope || '').trim().toLowerCase();
  if (!Object.values(VERIFICATION_SCOPES).includes(scope)) {
    throw new CanonicalIdentityError('Unsupported identity verification scope', {
      code: 'invalid_verification_scope'
    });
  }

  const source = normalizeSource(verificationSource);
  const recordId = optionalPositiveInteger(sourceRecordId, 'sourceRecordId');
  const contextual = scope === VERIFICATION_SCOPES.EVENT || scope === VERIFICATION_SCOPES.PHOTO;
  const contextType = verificationContextType === null || verificationContextType === undefined
    ? null
    : String(verificationContextType).trim();
  const contextId = optionalPositiveInteger(verificationContextId, 'verificationContextId');

  if (scope === VERIFICATION_SCOPES.UNVERIFIED) {
    if (verifiedAt !== null && verifiedAt !== undefined) {
      throw new CanonicalIdentityError('Unverified identities cannot have a verification time', {
        code: 'invalid_verification_proof'
      });
    }
  } else if (!validTimestamp(verifiedAt)) {
    throw new CanonicalIdentityError('Verified identities require a valid verification time', {
      code: 'invalid_verification_proof'
    });
  }

  if (contextual && (!contextType || contextType.length > 80 || contextId === null)) {
    throw new CanonicalIdentityError('Scoped identity proof requires its context', {
      code: 'invalid_verification_context'
    });
  }
  if (!contextual && (contextType !== null || contextId !== null)) {
    throw new CanonicalIdentityError('Account and unverified identities cannot have an event context', {
      code: 'invalid_verification_context'
    });
  }

  return {
    verificationScope: scope,
    verifiedAt: scope === VERIFICATION_SCOPES.UNVERIFIED ? null : verifiedAt,
    verificationSource: source,
    sourceRecordId: recordId,
    verificationContextType: contextType,
    verificationContextId: contextId
  };
}

function identityAggregateProof(proof) {
  if (proof.verificationScope === VERIFICATION_SCOPES.ACCOUNT) return proof;
  return {
    ...proof,
    verificationScope: VERIFICATION_SCOPES.UNVERIFIED,
    verifiedAt: null,
    verificationContextType: null,
    verificationContextId: null
  };
}

async function ensureCanonicalUser(db, {
  id,
  name = null,
  createdAt = null,
  updatedAt = null
}) {
  const userId = positiveInteger(id, 'id');
  const normalizedName = normalizeName(name);
  const { rows } = await db.query(
    `INSERT INTO users (id,name,created_at,updated_at)
     VALUES ($1,$2,COALESCE($3,NOW()),COALESCE($4,$3,NOW()))
     ON CONFLICT (id) DO UPDATE
       SET name=COALESCE(users.name,EXCLUDED.name),
           updated_at=CASE
             WHEN users.name IS NULL AND EXCLUDED.name IS NOT NULL THEN NOW()
             ELSE users.updated_at
           END
     RETURNING id,name,created_at,updated_at`,
    [userId, normalizedName, createdAt, updatedAt]
  );
  return rows[0];
}

async function withCanonicalIdentityTransaction(db, work) {
  if (!db || typeof db.query !== 'function') {
    throw new CanonicalIdentityError('A database connection is required', {
      code: 'identity_database_required',
      status: 500
    });
  }

  // pg PoolClients expose release(); a Pool exposes connect(). Reuse a caller's
  // client so identity work can participate in the route's wider transaction.
  if (typeof db.connect !== 'function' || typeof db.release === 'function') {
    return work(db);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function ensureOrganizerUserRecord(db, organizer) {
  const organizerId = positiveInteger(organizer.id, 'organizerId');
  if (organizer.user_id !== undefined && organizer.user_id !== null
    && Number(organizer.user_id) !== organizerId) {
    throw new CanonicalIdentityConflictError('Organizer is linked to a different canonical user.', {
      code: 'organizer_user_conflict',
      requestedUserId: organizerId,
      existingUserId: Number(organizer.user_id)
    });
  }

  const user = await ensureCanonicalUser(db, {
    id: organizerId,
    name: organizer.name,
    createdAt: organizer.created_at,
    updatedAt: organizer.last_login_at || organizer.created_at
  });
  const linked = await db.query(
    `UPDATE organizers
        SET user_id=$1
      WHERE id=$1 AND (user_id IS NULL OR user_id=$1)
      RETURNING id,user_id,email,name,created_at,last_login_at`,
    [organizerId]
  );
  if (!linked.rows[0]) {
    throw new CanonicalIdentityConflictError('Organizer is linked to a different canonical user.', {
      code: 'organizer_user_conflict',
      requestedUserId: organizerId
    });
  }
  return { user, organizer: linked.rows[0] };
}

async function findActiveIdentity(db, {
  identityType,
  value,
  forUpdate = false
}) {
  const normalized = normalizeIdentity(identityType, value);
  const { rows } = await db.query(
    `SELECT id,user_id,identity_type,value,normalized_value,verified_at,
            verification_scope,verification_source,source_record_id,is_primary,
            created_at,updated_at
       FROM user_identities
      WHERE identity_type=$1 AND normalized_value=$2 AND revoked_at IS NULL
      LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [normalized.identityType, normalized.normalizedValue]
  );
  return rows[0] || null;
}

async function recordIdentityVerification(db, identityId, proof) {
  if (proof.verificationScope === VERIFICATION_SCOPES.UNVERIFIED) return null;
  const { rows } = await db.query(
    `INSERT INTO user_identity_verifications (
       user_identity_id,verification_scope,verified_at,verification_source,
       source_record_id,verification_context_type,verification_context_id
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT DO NOTHING
     RETURNING id,user_identity_id,verification_scope,verified_at,
               verification_source,source_record_id,
               verification_context_type,verification_context_id,created_at`,
    [
      identityId,
      proof.verificationScope,
      proof.verifiedAt,
      proof.verificationSource,
      proof.sourceRecordId,
      proof.verificationContextType,
      proof.verificationContextId
    ]
  );
  return rows[0] || null;
}

async function resolveAccountIdentity(db, { identityType, value }) {
  const normalized = normalizeIdentity(identityType, value);
  const { rows } = await db.query(
    `SELECT id,user_id,identity_type,value,normalized_value,verified_at,
            verification_scope,verification_source,source_record_id,
            created_at,updated_at
       FROM user_identities
      WHERE identity_type=$1 AND normalized_value=$2 AND revoked_at IS NULL
        AND verification_scope='account' AND verified_at IS NOT NULL
      LIMIT 1`,
    [normalized.identityType, normalized.normalizedValue]
  );
  return rows[0] || null;
}

async function resolveScopedIdentity(db, {
  identityType,
  value,
  verificationScope,
  verificationContextType,
  verificationContextId
}) {
  const normalized = normalizeIdentity(identityType, value);
  const scope = String(verificationScope || '').trim().toLowerCase();
  if (![VERIFICATION_SCOPES.EVENT, VERIFICATION_SCOPES.PHOTO].includes(scope)) {
    throw new CanonicalIdentityError('Scoped resolution requires event or photo proof', {
      code: 'invalid_verification_scope'
    });
  }
  const contextType = String(verificationContextType || '').trim();
  const contextId = positiveInteger(verificationContextId, 'verificationContextId');
  if (!contextType || contextType.length > 80) {
    throw new CanonicalIdentityError('Scoped resolution requires a valid context type', {
      code: 'invalid_verification_context'
    });
  }

  const { rows } = await db.query(
    `SELECT identity.id,identity.user_id,identity.identity_type,identity.value,
            identity.normalized_value,identity.verified_at,
            identity.verification_scope,identity.verification_source,
            identity.source_record_id,identity.is_primary,
            proof.id AS proof_id,proof.verified_at AS proof_verified_at,
            proof.verification_source AS proof_source
       FROM user_identities identity
       JOIN user_identity_verifications proof
         ON proof.user_identity_id=identity.id
        AND proof.revoked_at IS NULL
      WHERE identity.identity_type=$1 AND identity.normalized_value=$2
        AND identity.revoked_at IS NULL
        AND proof.verification_scope=$3
        AND proof.verification_context_type=$4
        AND proof.verification_context_id=$5
      LIMIT 1`,
    [normalized.identityType, normalized.normalizedValue, scope, contextType, contextId]
  );
  return rows[0] || null;
}

function conflictFor(identity, requestedUserId, code = 'identity_conflict') {
  return new CanonicalIdentityConflictError(
    'That sign-in identity is already connected to another account.',
    {
      code,
      identityType: identity.identity_type,
      normalizedValue: identity.normalized_value,
      requestedUserId,
      existingUserId: Number(identity.user_id)
    }
  );
}

async function updateOwnedIdentity(db, identity, proof, isPrimary) {
  const currentStrength = SCOPE_STRENGTH[identity.verification_scope];
  const requestedStrength = SCOPE_STRENGTH[proof.verificationScope];
  const upgradeProof = requestedStrength > currentStrength;
  const makePrimary = Boolean(isPrimary) && !identity.is_primary;

  if (!upgradeProof && !makePrimary) return identity;

  const { rows } = await db.query(
    `UPDATE user_identities
        SET verified_at=CASE WHEN $2 THEN $3 ELSE verified_at END,
            verification_scope=CASE WHEN $2 THEN $4 ELSE verification_scope END,
            verification_source=CASE WHEN $2 THEN $5 ELSE verification_source END,
            source_record_id=CASE WHEN $2 THEN $6 ELSE source_record_id END,
            is_primary=is_primary OR $7,
            updated_at=NOW()
      WHERE id=$1 AND revoked_at IS NULL
      RETURNING id,user_id,identity_type,value,normalized_value,verified_at,
                verification_scope,verification_source,source_record_id,is_primary,
                created_at,updated_at`,
    [
      identity.id,
      upgradeProof,
      proof.verifiedAt,
      proof.verificationScope,
      proof.verificationSource,
      proof.sourceRecordId,
      Boolean(isPrimary)
    ]
  );
  return rows[0] || identity;
}

async function assertPrimaryIdentityAvailable(db, {
  userId,
  identityType,
  identityId = null,
  normalizedValue
}) {
  const primary = await db.query(
    `SELECT id,user_id,identity_type,normalized_value
       FROM user_identities
      WHERE user_id=$1 AND identity_type=$2
        AND revoked_at IS NULL AND is_primary
      LIMIT 1 FOR UPDATE`,
    [userId, identityType]
  );
  if (primary.rows[0] && Number(primary.rows[0].id) !== Number(identityId)) {
    throw new CanonicalIdentityConflictError(
      'This account already has a different primary identity of that type.',
      {
        code: 'primary_identity_conflict',
        identityType,
        normalizedValue,
        requestedUserId: userId,
        existingUserId: userId
      }
    );
  }
}

async function attachIdentityInTransaction(db, {
  userId: userIdValue,
  identityType,
  value,
  verifiedAt = null,
  verificationScope = VERIFICATION_SCOPES.UNVERIFIED,
  verificationSource,
  sourceRecordId = null,
  verificationContextType = null,
  verificationContextId = null,
  isPrimary = false
}) {
  const userId = positiveInteger(userIdValue, 'userId');
  const normalized = normalizeIdentity(identityType, value);
  const proof = normalizeVerification({
    verificationScope,
    verifiedAt,
    verificationSource,
    sourceRecordId,
    verificationContextType,
    verificationContextId
  });
  const aggregateProof = identityAggregateProof(proof);

  let existing = await findActiveIdentity(db, {
    identityType: normalized.identityType,
    value: normalized.normalizedValue,
    forUpdate: true
  });

  // Callers should pass a transaction client. Identity rows are always locked
  // before user rows across the high-level helpers; the user lock then
  // serializes primary-identity changes for one account.
  const lockedUser = await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
  if (!lockedUser.rows[0]) {
    throw new CanonicalIdentityError('Canonical user does not exist', {
      code: 'canonical_user_not_found',
      status: 404
    });
  }

  // The first lookup can legitimately find no row and then wait on the user
  // lock while another same-user transaction inserts it. Re-read after that
  // wait so a concurrent idempotent attach is returned instead of being
  // mistaken for a different-primary conflict.
  if (!existing) {
    existing = await findActiveIdentity(db, {
      identityType: normalized.identityType,
      value: normalized.normalizedValue,
      forUpdate: true
    });
  }

  if (existing && Number(existing.user_id) !== userId) {
    throw conflictFor(existing, userId);
  }
  if (existing) {
    if (isPrimary && !existing.is_primary) {
      await assertPrimaryIdentityAvailable(db, {
        userId,
        identityType: normalized.identityType,
        identityId: existing.id,
        normalizedValue: normalized.normalizedValue
      });
    }
    const identity = await updateOwnedIdentity(db, existing, aggregateProof, isPrimary);
    await recordIdentityVerification(db, identity.id, proof);
    return { identity, created: false };
  }

  if (isPrimary) {
    await assertPrimaryIdentityAvailable(db, {
      userId,
      identityType: normalized.identityType,
      normalizedValue: normalized.normalizedValue
    });
  }

  const inserted = await db.query(
    `INSERT INTO user_identities (
       user_id,identity_type,value,normalized_value,verified_at,
       verification_scope,verification_source,source_record_id,is_primary
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT DO NOTHING
     RETURNING id,user_id,identity_type,value,normalized_value,verified_at,
               verification_scope,verification_source,source_record_id,is_primary,
               created_at,updated_at`,
    [
      userId,
      normalized.identityType,
      normalized.value,
      normalized.normalizedValue,
      aggregateProof.verifiedAt,
      aggregateProof.verificationScope,
      aggregateProof.verificationSource,
      aggregateProof.sourceRecordId,
      Boolean(isPrimary)
    ]
  );
  if (inserted.rows[0]) {
    await recordIdentityVerification(db, inserted.rows[0].id, proof);
    return { identity: inserted.rows[0], created: true };
  }

  // ON CONFLICT handles a concurrent claimant without aborting the caller's
  // transaction. Re-read and return only if it was the same idempotent owner.
  const winner = await findActiveIdentity(db, {
    identityType: normalized.identityType,
    value: normalized.normalizedValue,
    forUpdate: true
  });
  if (winner && Number(winner.user_id) !== userId) {
    throw conflictFor(winner, userId);
  }
  if (winner) {
    if (isPrimary && !winner.is_primary) {
      await assertPrimaryIdentityAvailable(db, {
        userId,
        identityType: normalized.identityType,
        identityId: winner.id,
        normalizedValue: normalized.normalizedValue
      });
    }
    const identity = await updateOwnedIdentity(db, winner, aggregateProof, isPrimary);
    await recordIdentityVerification(db, identity.id, proof);
    return { identity, created: false };
  }

  throw new CanonicalIdentityConflictError(
    'The identity could not be attached because another active identity constraint won.',
    {
      code: 'identity_constraint_conflict',
      identityType: normalized.identityType,
      normalizedValue: normalized.normalizedValue,
      requestedUserId: userId,
      existingUserId: userId
    }
  );
}

async function attachIdentity(db, input) {
  return withCanonicalIdentityTransaction(
    db,
    client => attachIdentityInTransaction(client, input)
  );
}

async function ensureOrganizerIdentity(db, organizerIdValue) {
  const organizerId = positiveInteger(organizerIdValue, 'organizerId');
  return withCanonicalIdentityTransaction(db, async client => {
    // Read without locking first so resolveOrCreateOrganizerByEmail can keep the
    // global lock order: identity, organizer, then user.
    const organizerResult = await client.query(
      `SELECT id,user_id,email,name,created_at,last_login_at
         FROM organizers
        WHERE id=$1`,
      [organizerId]
    );
    const organizer = organizerResult.rows[0];
    if (!organizer) {
      throw new CanonicalIdentityError('Organizer does not exist', {
        code: 'organizer_not_found',
        status: 404
      });
    }

    const verified = organizer.last_login_at !== null && organizer.last_login_at !== undefined;
    const resolved = await resolveOrCreateOrganizerByEmail(client, {
      email: organizer.email,
      name: organizer.name,
      accountVerification: verified
        ? {
            verifiedAt: organizer.last_login_at,
            source: 'legacy_organizers.last_login_at',
            sourceRecordId: organizerId
          }
        : null
    });
    if (Number(resolved.organizer.id) !== organizerId) {
      throw new CanonicalIdentityConflictError(
        'The organizer email resolves to a different canonical user.',
        {
          code: 'email_owner_conflict',
          identityType: IDENTITY_TYPES.EMAIL,
          normalizedValue: normalizeEmail(organizer.email),
          requestedUserId: organizerId,
          existingUserId: Number(resolved.organizer.id)
        }
      );
    }
    return {
      user: resolved.user,
      identity: resolved.identity,
      identityCreated: resolved.createdIdentity
    };
  });
}

async function resolveOrCreateOrganizerByEmail(db, {
  email,
  name = null,
  accountVerification = null
}) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedName = normalizeName(name);
  const accountProof = accountVerification
    ? normalizeVerification({
        verificationScope: VERIFICATION_SCOPES.ACCOUNT,
        verifiedAt: accountVerification.verifiedAt,
        verificationSource: accountVerification.verificationSource || accountVerification.source,
        sourceRecordId: accountVerification.sourceRecordId
      })
    : null;

  return withCanonicalIdentityTransaction(db, async client => {
    const existingIdentity = await findActiveIdentity(client, {
      identityType: IDENTITY_TYPES.EMAIL,
      value: normalizedEmail,
      forUpdate: true
    });
    const organizerResult = await client.query(
      `SELECT id,user_id,email,name,created_at,last_login_at
         FROM organizers
        WHERE LOWER(BTRIM(email))=$1
        ORDER BY id
        FOR UPDATE`,
      [normalizedEmail]
    );
    if (organizerResult.rows.length > 1) {
      throw new CanonicalIdentityConflictError(
        'Multiple legacy organizer rows claim that normalized email.',
        {
          code: 'ambiguous_legacy_email',
          identityType: IDENTITY_TYPES.EMAIL,
          normalizedValue: normalizedEmail
        }
      );
    }

    let organizer = organizerResult.rows[0] || null;
    if (existingIdentity && organizer
      && Number(existingIdentity.user_id) !== Number(organizer.id)) {
      throw new CanonicalIdentityConflictError(
        'The canonical email and legacy organizer have different owners.',
        {
          code: 'email_owner_conflict',
          identityType: IDENTITY_TYPES.EMAIL,
          normalizedValue: normalizedEmail,
          requestedUserId: Number(organizer.id),
          existingUserId: Number(existingIdentity.user_id)
        }
      );
    }

    let createdOrganizer = false;
    if (!organizer) {
      const inserted = existingIdentity
        ? await client.query(
            `INSERT INTO organizers (id,user_id,email,name)
             VALUES ($1,$1,$2,$3)
             ON CONFLICT DO NOTHING
             RETURNING id,user_id,email,name,created_at,last_login_at`,
            [Number(existingIdentity.user_id), normalizedEmail, normalizedName]
          )
        : await client.query(
            `INSERT INTO organizers (email,name)
             VALUES ($1,$2)
             ON CONFLICT DO NOTHING
             RETURNING id,user_id,email,name,created_at,last_login_at`,
            [normalizedEmail, normalizedName]
          );
      organizer = inserted.rows[0] || null;
      createdOrganizer = Boolean(organizer);

      if (!organizer) {
        const raced = await client.query(
          `SELECT id,user_id,email,name,created_at,last_login_at
             FROM organizers
            WHERE LOWER(BTRIM(email))=$1
            ORDER BY id
            FOR UPDATE`,
          [normalizedEmail]
        );
        if (raced.rows.length !== 1) {
          throw new CanonicalIdentityConflictError(
            'The normalized email could not be assigned to one organizer.',
            {
              code: 'ambiguous_legacy_email',
              identityType: IDENTITY_TYPES.EMAIL,
              normalizedValue: normalizedEmail,
              existingUserId: existingIdentity ? Number(existingIdentity.user_id) : null
            }
          );
        }
        organizer = raced.rows[0];
      }
    }

    if (existingIdentity && Number(existingIdentity.user_id) !== Number(organizer.id)) {
      throw new CanonicalIdentityConflictError(
        'The canonical email and legacy organizer have different owners.',
        {
          code: 'email_owner_conflict',
          identityType: IDENTITY_TYPES.EMAIL,
          normalizedValue: normalizedEmail,
          requestedUserId: Number(organizer.id),
          existingUserId: Number(existingIdentity.user_id)
        }
      );
    }

    const ensured = await ensureOrganizerUserRecord(client, organizer);
    organizer = ensured.organizer;
    const attached = await attachIdentity(client, {
      userId: organizer.id,
      identityType: IDENTITY_TYPES.EMAIL,
      value: normalizedEmail,
      verifiedAt: accountProof ? accountProof.verifiedAt : null,
      verificationScope: accountProof
        ? VERIFICATION_SCOPES.ACCOUNT
        : VERIFICATION_SCOPES.UNVERIFIED,
      verificationSource: accountProof
        ? accountProof.verificationSource
        : 'organizers.email',
      sourceRecordId: accountProof
        ? accountProof.sourceRecordId
        : Number(organizer.id),
      isPrimary: true
    });

    if (accountProof) {
      const promotedOrganizer = await client.query(
        `UPDATE organizers
            SET last_login_at=CASE
              WHEN last_login_at IS NULL OR last_login_at < $2 THEN $2
              ELSE last_login_at
            END
          WHERE id=$1
          RETURNING id,user_id,email,name,created_at,last_login_at`,
        [organizer.id, accountProof.verifiedAt]
      );
      organizer = promotedOrganizer.rows[0] || organizer;
    }

    return {
      organizer,
      user: ensured.user,
      identity: attached.identity,
      createdOrganizer,
      createdIdentity: attached.created
    };
  });
}

async function readOrganizerForIdentity(db, userId) {
  const { rows } = await db.query(
    `SELECT id,user_id,email,name,created_at,last_login_at
       FROM organizers
      WHERE id=$1
      FOR UPDATE`,
    [userId]
  );
  if (!rows[0]) {
    throw new CanonicalIdentityError('Organizer does not exist for this canonical user', {
      code: 'organizer_not_found',
      status: 404
    });
  }
  return rows[0];
}

async function readActivePhoneCredentials(db, userId, phoneE164) {
  const { rows } = await db.query(
    `SELECT id,organizer_id,phone_e164,verified_at,last_used_at,created_at,updated_at
       FROM account_phone_credentials
      WHERE revoked_at IS NULL
        AND (phone_e164=$1 OR organizer_id=$2)
      ORDER BY id
      FOR UPDATE`,
    [phoneE164, userId]
  );
  return rows;
}

function assertCompatiblePhoneCredentials(rows, userId, phoneE164) {
  const phoneOwners = rows.filter(row => row.phone_e164 === phoneE164);
  const userCredentials = rows.filter(row => Number(row.organizer_id) === userId);
  if (phoneOwners.length > 1 || userCredentials.length > 1) {
    throw new CanonicalIdentityConflictError('Multiple active phone credentials were found.', {
      code: 'ambiguous_phone_credential',
      identityType: IDENTITY_TYPES.PHONE,
      normalizedValue: phoneE164,
      requestedUserId: userId
    });
  }
  if (phoneOwners[0] && Number(phoneOwners[0].organizer_id) !== userId) {
    throw new CanonicalIdentityConflictError(
      'That verified phone belongs to another account.',
      {
        code: 'phone_owner_conflict',
        identityType: IDENTITY_TYPES.PHONE,
        normalizedValue: phoneE164,
        requestedUserId: userId,
        existingUserId: Number(phoneOwners[0].organizer_id)
      }
    );
  }
  if (userCredentials[0] && userCredentials[0].phone_e164 !== phoneE164) {
    throw new CanonicalIdentityConflictError(
      'This account already has a different active verified phone.',
      {
        code: 'account_phone_conflict',
        identityType: IDENTITY_TYPES.PHONE,
        normalizedValue: phoneE164,
        requestedUserId: userId,
        existingUserId: userId
      }
    );
  }
  return phoneOwners[0] || userCredentials[0] || null;
}

async function attachVerifiedPhoneIdentity(db, {
  userId: userIdValue,
  phone,
  verifiedAt,
  verificationSource = 'account_phone_credentials'
}) {
  const userId = positiveInteger(userIdValue, 'userId');
  const normalizedPhone = normalizeIdentity(IDENTITY_TYPES.PHONE, phone).normalizedValue;
  const requestedProof = normalizeVerification({
    verificationScope: VERIFICATION_SCOPES.ACCOUNT,
    verifiedAt,
    verificationSource
  });

  return withCanonicalIdentityTransaction(db, async client => {
    // Phone flows lock the legacy credential before its canonical projection,
    // matching the existing enrollment transaction and avoiding lock inversion.
    let credentials = await readActivePhoneCredentials(client, userId, normalizedPhone);
    let credential = assertCompatiblePhoneCredentials(credentials, userId, normalizedPhone);
    const canonical = await findActiveIdentity(client, {
      identityType: IDENTITY_TYPES.PHONE,
      value: normalizedPhone,
      forUpdate: true
    });
    if (canonical && Number(canonical.user_id) !== userId) {
      throw conflictFor(canonical, userId, 'phone_owner_conflict');
    }
    let createdCredential = false;

    const organizer = await readOrganizerForIdentity(client, userId);
    await ensureOrganizerUserRecord(client, organizer);

    if (!credential) {
      const inserted = await client.query(
        `INSERT INTO account_phone_credentials
           (organizer_id,phone_e164,verified_at,last_used_at)
         VALUES ($1,$2,$3,$3)
         ON CONFLICT DO NOTHING
         RETURNING id,organizer_id,phone_e164,verified_at,last_used_at,created_at,updated_at`,
        [userId, normalizedPhone, requestedProof.verifiedAt]
      );
      credential = inserted.rows[0] || null;
      createdCredential = Boolean(credential);
      if (!credential) {
        credentials = await readActivePhoneCredentials(client, userId, normalizedPhone);
        credential = assertCompatiblePhoneCredentials(credentials, userId, normalizedPhone);
      }
      if (!credential) {
        throw new CanonicalIdentityConflictError('The verified phone could not be attached.', {
          code: 'phone_constraint_conflict',
          identityType: IDENTITY_TYPES.PHONE,
          normalizedValue: normalizedPhone,
          requestedUserId: userId
        });
      }
    }

    const attached = await attachIdentity(client, {
      userId,
      identityType: IDENTITY_TYPES.PHONE,
      value: normalizedPhone,
      verifiedAt: credential.verified_at,
      verificationScope: VERIFICATION_SCOPES.ACCOUNT,
      verificationSource: requestedProof.verificationSource,
      sourceRecordId: Number(credential.id),
      isPrimary: true
    });
    return {
      credential,
      identity: attached.identity,
      createdCredential,
      createdIdentity: attached.created
    };
  });
}

async function resolveVerifiedPhoneIdentity(db, { phone }) {
  const normalizedPhone = normalizeIdentity(IDENTITY_TYPES.PHONE, phone).normalizedValue;
  return withCanonicalIdentityTransaction(db, async client => {
    const legacyResult = await client.query(
      `SELECT id,organizer_id,phone_e164,verified_at,last_used_at,created_at,updated_at
         FROM account_phone_credentials
        WHERE phone_e164=$1 AND revoked_at IS NULL
        ORDER BY id
        FOR UPDATE`,
      [normalizedPhone]
    );
    if (legacyResult.rows.length > 1) {
      throw new CanonicalIdentityConflictError('Multiple active phone credentials were found.', {
        code: 'ambiguous_phone_credential',
        identityType: IDENTITY_TYPES.PHONE,
        normalizedValue: normalizedPhone
      });
    }
    const credential = legacyResult.rows[0] || null;
    const canonical = await findActiveIdentity(client, {
      identityType: IDENTITY_TYPES.PHONE,
      value: normalizedPhone,
      forUpdate: true
    });

    if (canonical && credential
      && Number(canonical.user_id) !== Number(credential.organizer_id)) {
      throw conflictFor(canonical, Number(credential.organizer_id), 'phone_owner_conflict');
    }
    if (canonical && canonical.verification_scope === VERIFICATION_SCOPES.ACCOUNT
      && canonical.verified_at) {
      return { identity: canonical, credential, repaired: false };
    }
    if (!credential || !credential.verified_at) return null;

    const userId = Number(credential.organizer_id);
    const organizer = await readOrganizerForIdentity(client, userId);
    await ensureOrganizerUserRecord(client, organizer);
    const attached = await attachIdentity(client, {
      userId,
      identityType: IDENTITY_TYPES.PHONE,
      value: normalizedPhone,
      verifiedAt: credential.verified_at,
      verificationScope: VERIFICATION_SCOPES.ACCOUNT,
      verificationSource: 'account_phone_credentials',
      sourceRecordId: Number(credential.id),
      isPrimary: true
    });
    return {
      identity: attached.identity,
      credential,
      repaired: true
    };
  });
}

async function revokeActivePhoneIdentity(db, {
  userId: userIdValue,
  phone,
  revokedAt = new Date()
}) {
  const userId = positiveInteger(userIdValue, 'userId');
  const normalizedPhone = normalizeIdentity(IDENTITY_TYPES.PHONE, phone).normalizedValue;
  if (!validTimestamp(revokedAt)) {
    throw new CanonicalIdentityError('Phone revocation requires a valid time', {
      code: 'invalid_revocation_time'
    });
  }

  return withCanonicalIdentityTransaction(db, async client => {
    const credentialResult = await client.query(
      `SELECT id,organizer_id,phone_e164
         FROM account_phone_credentials
        WHERE phone_e164=$1 AND revoked_at IS NULL
        ORDER BY id
        FOR UPDATE`,
      [normalizedPhone]
    );
    if (credentialResult.rows.length > 1) {
      throw new CanonicalIdentityConflictError('Multiple active phone credentials were found.', {
        code: 'ambiguous_phone_credential',
        identityType: IDENTITY_TYPES.PHONE,
        normalizedValue: normalizedPhone,
        requestedUserId: userId
      });
    }
    const credential = credentialResult.rows[0] || null;
    if (credential && Number(credential.organizer_id) !== userId) {
      throw new CanonicalIdentityConflictError(
        'That verified phone belongs to another account.',
        {
          code: 'phone_owner_conflict',
          identityType: IDENTITY_TYPES.PHONE,
          normalizedValue: normalizedPhone,
          requestedUserId: userId,
          existingUserId: Number(credential.organizer_id)
        }
      );
    }
    const identity = await findActiveIdentity(client, {
      identityType: IDENTITY_TYPES.PHONE,
      value: normalizedPhone,
      forUpdate: true
    });
    if (identity && Number(identity.user_id) !== userId) {
      throw conflictFor(identity, userId, 'phone_owner_conflict');
    }

    const identityResult = identity
      ? await client.query(
          `UPDATE user_identities
              SET revoked_at=$2,updated_at=NOW()
            WHERE id=$1 AND revoked_at IS NULL
            RETURNING id,user_id,identity_type,normalized_value,revoked_at`,
          [identity.id, revokedAt]
        )
      : { rows: [], rowCount: 0 };
    const legacyResult = await client.query(
      `UPDATE account_phone_credentials
          SET revoked_at=$3,updated_at=NOW()
        WHERE organizer_id=$1 AND phone_e164=$2 AND revoked_at IS NULL
        RETURNING id,organizer_id,phone_e164,revoked_at`,
      [userId, normalizedPhone, revokedAt]
    );
    const challengeResult = await client.query(
      `UPDATE phone_auth_challenges
          SET used_at=COALESCE(used_at,$3)
        WHERE used_at IS NULL
          AND (organizer_id=$1 OR phone_e164=$2)`,
      [userId, normalizedPhone, revokedAt]
    );
    return {
      identity: identityResult.rows[0] || null,
      credential: legacyResult.rows[0] || null,
      identityRevoked: Boolean(identityResult.rows[0]),
      credentialRevoked: Boolean(legacyResult.rows[0]),
      challengesInvalidated: challengeResult.rowCount || 0
    };
  });
}

module.exports = {
  IDENTITY_TYPES,
  VERIFICATION_SCOPES,
  CanonicalIdentityError,
  CanonicalIdentityConflictError,
  attachIdentity,
  attachVerifiedPhoneIdentity,
  ensureCanonicalUser,
  ensureOrganizerIdentity,
  findActiveIdentity,
  normalizeEmail,
  normalizeGoogleSubject,
  normalizeIdentity,
  normalizeVerification,
  resolveAccountIdentity,
  resolveOrCreateOrganizerByEmail,
  resolveScopedIdentity,
  resolveVerifiedPhoneIdentity,
  revokeActivePhoneIdentity,
  withCanonicalIdentityTransaction
};
