const { slugify } = require('./slug');
const {
  IDENTITY_TYPES,
  VERIFICATION_SCOPES,
  attachIdentity,
  CanonicalIdentityConflictError,
  normalizeIdentity
} = require('./canonical-identity');

const PROVISION_SOURCE = 'admin_done_for_you';
const HOST_NAME_MAX = 100;
const CONTACT_NAME_MAX = 160;

class DoneForYouProvisioningError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = 'DoneForYouProvisioningError';
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

function cleanText(value, max) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function positiveId(value, fieldName) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new DoneForYouProvisioningError(
      'invalid_done_for_you_input',
      `${fieldName} must be a positive integer.`
    );
  }
  return id;
}

function expectedUserIdValue(value) {
  if (value === null) return null;
  return positiveId(value, 'expectedUserId');
}

function normalizeLookupContacts({ email, phone = null }) {
  try {
    const normalizedEmail = normalizeIdentity(IDENTITY_TYPES.EMAIL, email);
    const normalizedPhone = String(phone || '').trim()
      ? normalizeIdentity(IDENTITY_TYPES.PHONE, phone)
      : null;
    return { email: normalizedEmail, phone: normalizedPhone };
  } catch (error) {
    throw new DoneForYouProvisioningError(
      'invalid_done_for_you_contact',
      error.message || 'Enter a valid email and optional mobile number.',
      400
    );
  }
}

function normalizeProvisioningInput({ hostName, contactName, email, phone = null }) {
  const normalizedHostName = cleanText(hostName, HOST_NAME_MAX);
  const normalizedContactName = cleanText(contactName, CONTACT_NAME_MAX);
  if (normalizedHostName.length < 2) {
    throw new DoneForYouProvisioningError(
      'invalid_host_name',
      'Enter the client\'s Host Page name.'
    );
  }
  if (normalizedContactName.length < 2) {
    throw new DoneForYouProvisioningError(
      'invalid_contact_name',
      'Enter the client\'s contact name.'
    );
  }

  const contacts = normalizeLookupContacts({ email, phone });
  return {
    hostName: normalizedHostName,
    contactName: normalizedContactName,
    ...contacts
  };
}

function maskEmail(value) {
  const [local = '', domain = ''] = String(value || '').split('@');
  if (!domain) return '';
  return `${local.slice(0, 1)}${local.length > 1 ? '•••' : ''}@${domain}`;
}

function maskPhone(value) {
  const phone = String(value || '');
  return phone ? `••••${phone.slice(-4)}` : null;
}

function claimedStateFromRow(row) {
  if (!row) return { claimed: false, claimedAt: null };
  const times = [row.last_login_at, row.verified_identity_at]
    .filter(Boolean)
    .map(value => new Date(value))
    .filter(value => !Number.isNaN(value.getTime()));
  if (!times.length) return { claimed: false, claimedAt: null };
  const claimedAt = new Date(Math.max(...times.map(value => value.getTime())));
  return { claimed: true, claimedAt: claimedAt.toISOString() };
}

async function readDoneForYouClaimState(db, userIdValue) {
  const userId = positiveId(userIdValue, 'userId');
  const { rows } = await db.query(
    `SELECT organizer.last_login_at,
            MAX(identity.verified_at) FILTER (
              WHERE identity.revoked_at IS NULL
                AND identity.verification_scope='account'
                AND identity.verified_at IS NOT NULL
            ) AS verified_identity_at
       FROM users canonical_user
       LEFT JOIN organizers organizer ON organizer.user_id=canonical_user.id
       LEFT JOIN user_identities identity ON identity.user_id=canonical_user.id
      WHERE canonical_user.id=$1
      GROUP BY organizer.last_login_at`,
    [userId]
  );
  return claimedStateFromRow(rows[0]);
}

async function withTransaction(db, work) {
  if (!db || typeof db.query !== 'function') {
    throw new DoneForYouProvisioningError(
      'done_for_you_database_required',
      'A database connection is required.',
      500
    );
  }
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
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function lockProvisioningKeys(client, contacts) {
  const keys = [
    `done-for-you:identity:email:${contacts.email.normalizedValue}`,
    contacts.phone
      ? `done-for-you:identity:phone:${contacts.phone.normalizedValue}`
      : null
  ].filter(Boolean).sort();
  for (const key of keys) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
  }
}

function oneOwner(rows, { code, message, identityType }) {
  const owners = [...new Set((rows || []).map(row => Number(row.user_id)).filter(Boolean))];
  if (owners.length > 1) {
    throw new DoneForYouProvisioningError(code, message, 409, { identityType, ownerUserIds: owners });
  }
  return owners[0] || null;
}

function resolvedOwner(emailIdentity, phoneIdentity) {
  const emailOwner = emailIdentity ? Number(emailIdentity.user_id) : null;
  const phoneOwner = phoneIdentity ? Number(phoneIdentity.user_id) : null;
  if (emailOwner && phoneOwner && emailOwner !== phoneOwner) {
    throw new DoneForYouProvisioningError(
      'split_identity_owners',
      'The email and mobile number belong to different Silver Glider accounts.',
      409,
      { emailOwnerUserId: emailOwner, phoneOwnerUserId: phoneOwner }
    );
  }
  return emailOwner || phoneOwner || null;
}

function projectionConflict(identityType, ownerUserIds) {
  throw new DoneForYouProvisioningError(
    'identity_projection_conflict',
    `The ${identityType} has conflicting account owners and needs manual identity review.`,
    409,
    { identityType, ownerUserIds: [...new Set(ownerUserIds.filter(Boolean).map(Number))] }
  );
}

async function readExactContactOwnership(client, contacts, { forUpdate = false } = {}) {
  // Phone ownership uses the same credential -> canonical identity lock order
  // as verification/enrollment. Reversing these two locks can deadlock when a
  // recipient verifies the number while support provisions the account.
  const legacyPhone = contacts.phone
    ? await client.query(
      `SELECT credential.id,organizer.user_id,credential.phone_e164,
              credential.verified_at
         FROM account_phone_credentials credential
         JOIN organizers organizer ON organizer.id=credential.organizer_id
        WHERE credential.phone_e164=$1 AND credential.revoked_at IS NULL
        ORDER BY credential.id${forUpdate ? ' FOR UPDATE OF credential' : ''}`,
      [contacts.phone.normalizedValue]
    )
    : { rows: [] };
  oneOwner(legacyPhone.rows, {
    code: 'ambiguous_legacy_phone',
    message: 'That verified mobile number has more than one active legacy credential.',
    identityType: 'phone'
  });

  const canonical = await client.query(
    `SELECT id,user_id,identity_type,normalized_value,verification_scope,verified_at,
            verification_source,is_primary
       FROM user_identities
      WHERE revoked_at IS NULL
        AND ((identity_type='email' AND normalized_value=$1)
          OR ($2::text IS NOT NULL AND identity_type='phone' AND normalized_value=$2))
      ORDER BY identity_type,normalized_value,id${forUpdate ? ' FOR UPDATE' : ''}`,
    [contacts.email.normalizedValue, contacts.phone?.normalizedValue || null]
  );
  const canonicalEmail = canonical.rows.filter(row => row.identity_type === 'email');
  const canonicalPhone = canonical.rows.filter(row => row.identity_type === 'phone');
  oneOwner(canonicalEmail, {
    code: 'ambiguous_canonical_email',
    message: 'That email is connected to more than one active canonical identity.',
    identityType: 'email'
  });
  oneOwner(canonicalPhone, {
    code: 'ambiguous_canonical_phone',
    message: 'That mobile number is connected to more than one active canonical identity.',
    identityType: 'phone'
  });

  const legacyEmail = await client.query(
    `SELECT organizer.id,organizer.user_id,organizer.email,organizer.last_login_at,
            canonical_user.account_status
       FROM organizers organizer
       JOIN users canonical_user ON canonical_user.id=organizer.user_id
      WHERE LOWER(BTRIM(organizer.email))=$1
      ORDER BY organizer.id${forUpdate ? ' FOR UPDATE OF organizer' : ''}`,
    [contacts.email.normalizedValue]
  );
  oneOwner(legacyEmail.rows, {
    code: 'ambiguous_legacy_email',
    message: 'That email is connected to more than one legacy Host Page.',
    identityType: 'email'
  });

  const canonicalEmailOwner = oneOwner(canonicalEmail, {
    code: 'ambiguous_canonical_email', message: 'Email ownership is ambiguous.', identityType: 'email'
  });
  const legacyEmailOwner = oneOwner(legacyEmail.rows, {
    code: 'ambiguous_legacy_email', message: 'Email ownership is ambiguous.', identityType: 'email'
  });
  if (canonicalEmailOwner && legacyEmailOwner && canonicalEmailOwner !== legacyEmailOwner) {
    projectionConflict('email', [canonicalEmailOwner, legacyEmailOwner]);
  }
  const emailOwner = canonicalEmailOwner || legacyEmailOwner || null;

  const verifiedCanonicalPhone = canonicalPhone.filter(
    row => row.verification_scope === VERIFICATION_SCOPES.ACCOUNT && row.verified_at
  );
  const unverifiedCanonicalPhone = canonicalPhone.filter(
    row => row.verification_scope !== VERIFICATION_SCOPES.ACCOUNT || !row.verified_at
  );
  const canonicalVerifiedPhoneOwner = oneOwner(verifiedCanonicalPhone, {
    code: 'ambiguous_verified_phone', message: 'Verified phone ownership is ambiguous.', identityType: 'phone'
  });
  const legacyPhoneOwner = oneOwner(legacyPhone.rows, {
    code: 'ambiguous_legacy_phone', message: 'Verified phone ownership is ambiguous.', identityType: 'phone'
  });
  if (canonicalVerifiedPhoneOwner && legacyPhoneOwner && canonicalVerifiedPhoneOwner !== legacyPhoneOwner) {
    projectionConflict('phone', [canonicalVerifiedPhoneOwner, legacyPhoneOwner]);
  }
  const verifiedPhoneOwner = canonicalVerifiedPhoneOwner || legacyPhoneOwner || null;
  const unverifiedPhoneOwner = oneOwner(unverifiedCanonicalPhone, {
    code: 'ambiguous_unverified_phone', message: 'Unverified phone ownership is ambiguous.', identityType: 'phone'
  });
  if (unverifiedPhoneOwner && verifiedPhoneOwner && unverifiedPhoneOwner !== verifiedPhoneOwner) {
    projectionConflict('phone', [unverifiedPhoneOwner, verifiedPhoneOwner]);
  }
  const targetUserId = resolvedOwner(
    emailOwner ? { user_id: emailOwner } : null,
    verifiedPhoneOwner ? { user_id: verifiedPhoneOwner } : null
  );
  if (unverifiedPhoneOwner && (!targetUserId || unverifiedPhoneOwner !== targetUserId)) {
    throw new DoneForYouProvisioningError(
      'unverified_phone_requires_manual_review',
      'That mobile number has unverified account history and cannot select or merge an owner.',
      409,
      { identityType: 'phone', ownerUserIds: [unverifiedPhoneOwner] }
    );
  }
  return {
    targetUserId,
    matchedBy: [
      canonicalEmailOwner ? 'canonical_email' : null,
      legacyEmailOwner ? 'legacy_email' : null,
      canonicalVerifiedPhoneOwner ? 'canonical_verified_phone' : null,
      legacyPhoneOwner ? 'legacy_verified_phone' : null,
      unverifiedPhoneOwner ? 'same_user_unverified_phone' : null
    ].filter(Boolean),
    canonicalEmail: canonicalEmail[0] || null,
    canonicalPhone: canonicalPhone[0] || null,
    legacyEmail: legacyEmail.rows[0] || null,
    legacyPhone: legacyPhone.rows[0] || null
  };
}

async function lookupDoneForYouClient(db, { email, phone = null }) {
  const contacts = normalizeLookupContacts({ email, phone });
  return withTransaction(db, async client => {
    const ownership = await readExactContactOwnership(client, contacts);
    if (!ownership.targetUserId) {
      return {
        expectedUserId: null,
        matched: false,
        matchedBy: [],
        account: null,
        contacts: {
          email: maskEmail(contacts.email.normalizedValue),
          phone: contacts.phone ? maskPhone(contacts.phone.normalizedValue) : null
        }
      };
    }
    const { rows } = await client.query(
      `SELECT canonical_user.id,canonical_user.name,canonical_user.account_status,
              organizer.id AS organizer_id,organizer.org_name,organizer.public_slug
         FROM users canonical_user
         LEFT JOIN organizers organizer ON organizer.user_id=canonical_user.id
        WHERE canonical_user.id=$1`,
      [ownership.targetUserId]
    );
    if (!rows[0]) {
      throw new DoneForYouProvisioningError(
        'canonical_user_not_found',
        'The exact contact match no longer has a canonical account.',
        409
      );
    }
    const claimed = await readDoneForYouClaimState(client, ownership.targetUserId);
    return {
      expectedUserId: Number(ownership.targetUserId),
      matched: true,
      matchedBy: ownership.matchedBy,
      account: {
        userId: Number(rows[0].id),
        name: rows[0].name || null,
        status: rows[0].account_status,
        organizerId: rows[0].organizer_id ? Number(rows[0].organizer_id) : null,
        hostName: rows[0].org_name || null,
        hostSlug: rows[0].public_slug || null,
        claimed: claimed.claimed,
        claimedAt: claimed.claimedAt
      },
      contacts: {
        email: maskEmail(contacts.email.normalizedValue),
        phone: contacts.phone ? maskPhone(contacts.phone.normalizedValue) : null
      }
    };
  });
}

async function requireActiveOperator(client, actorAdminOperatorId) {
  const { rows } = await client.query(
    `SELECT id,email,role,status
       FROM admin_operators
      WHERE id=$1 AND status='active'
      FOR SHARE`,
    [actorAdminOperatorId]
  );
  if (!rows[0]) {
    throw new DoneForYouProvisioningError(
      'active_admin_operator_required',
      'A current administrator session is required.',
      403
    );
  }
  return rows[0];
}

async function lockActiveUser(client, userId) {
  const { rows } = await client.query(
    `SELECT id,name,account_status,created_at,updated_at
       FROM users
      WHERE id=$1
      FOR UPDATE`,
    [userId]
  );
  const user = rows[0];
  if (!user) {
    throw new DoneForYouProvisioningError(
      'canonical_user_not_found',
      'The matched Silver Glider account no longer exists.',
      409
    );
  }
  if (user.account_status !== 'active') {
    throw new DoneForYouProvisioningError(
      'account_not_active',
      'That Silver Glider account is not active. Resolve its status before preparing a Host Page.',
      409
    );
  }
  return user;
}

async function createCanonicalShell(client, contactName) {
  const { rows } = await client.query(
    `INSERT INTO users (name)
     VALUES ($1)
     RETURNING id,name,account_status,created_at,updated_at`,
    [contactName]
  );
  return rows[0];
}

async function lockSingleOrganizer(client, userId) {
  const { rows } = await client.query(
    `SELECT id,user_id,email,name,org_name,public_slug,logo_url,header_image_url,
            bio,website_url,instagram_handle,contact_email,last_login_at,created_at,updated_at
       FROM organizers
      WHERE user_id=$1 OR id=$1
      ORDER BY id
      FOR UPDATE`,
    [userId]
  );
  if (rows.length > 1) {
    throw new DoneForYouProvisioningError(
      'multiple_host_pages',
      'That account has more than one compatibility Host Page record.',
      409
    );
  }
  return rows[0] || null;
}

async function availableHostSlug(client, hostName, userId) {
  const base = slugify(hostName).slice(0, 60) || 'host';
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    [`done-for-you:host-slug:${base}`]
  );
  const candidates = [base, `${base}-${Number(userId).toString(36)}`];
  for (let suffix = 2; suffix <= 20; suffix += 1) {
    candidates.push(`${base.slice(0, 54)}-${Number(userId).toString(36)}-${suffix}`);
  }
  const { rows } = await client.query(
    `SELECT LOWER(public_slug) AS public_slug
       FROM organizers
      WHERE LOWER(public_slug)=ANY($1::text[])
      FOR SHARE`,
    [candidates]
  );
  const used = new Set(rows.map(row => row.public_slug));
  const available = candidates.find(candidate => !used.has(candidate));
  if (!available) {
    throw new DoneForYouProvisioningError(
      'host_slug_unavailable',
      'A unique Host Page address could not be prepared.',
      409
    );
  }
  return available;
}

async function ensureSingleHostPage(client, {
  user,
  lockedOrganizer,
  hostName,
  contactName,
  compatibilityEmail
}) {
  let organizer = lockedOrganizer || null;
  const publicSlug = organizer?.public_slug
    || await availableHostSlug(client, cleanText(organizer?.org_name, HOST_NAME_MAX) || hostName, user.id);
  if (!organizer) {
    const name = cleanText(user.name, CONTACT_NAME_MAX) || contactName;
    const inserted = await client.query(
      `INSERT INTO organizers
         (id,user_id,email,name,org_name,public_slug,last_login_at)
       VALUES ($1,$1,$2,$3,$4,$5,NULL)
       RETURNING id,user_id,email,name,org_name,public_slug,logo_url,header_image_url,
                 bio,website_url,instagram_handle,contact_email,last_login_at,created_at,updated_at`,
      [user.id, compatibilityEmail, name, hostName, publicSlug]
    );
    return { organizer: inserted.rows[0], created: true, updated: false };
  }

  const needsContactName = !cleanText(organizer.name, CONTACT_NAME_MAX);
  const needsHostName = !cleanText(organizer.org_name, HOST_NAME_MAX);
  const needsSlug = !organizer.public_slug;
  if (!needsContactName && !needsHostName && !needsSlug) {
    return { organizer, created: false, updated: false };
  }
  const updated = await client.query(
    `UPDATE organizers
        SET name=CASE WHEN NULLIF(BTRIM(name),'') IS NULL THEN $2 ELSE name END,
            org_name=CASE WHEN NULLIF(BTRIM(org_name),'') IS NULL THEN $3 ELSE org_name END,
            public_slug=COALESCE(public_slug,$4),
            updated_at=NOW()
      WHERE id=$1
      RETURNING id,user_id,email,name,org_name,public_slug,logo_url,header_image_url,
                bio,website_url,instagram_handle,contact_email,last_login_at,created_at,updated_at`,
    [organizer.id, contactName, hostName, publicSlug]
  );
  organizer = updated.rows[0];
  return { organizer, created: false, updated: true };
}

async function ensureMarker(client, targetUserId, actorAdminOperatorId) {
  const existing = await client.query(
    `SELECT id,target_user_id,created_by_admin_operator_id,created_at,updated_at
       FROM admin_done_for_you_clients
      WHERE target_user_id=$1
      FOR UPDATE`,
    [targetUserId]
  );
  if (existing.rows[0]) return { marker: existing.rows[0], created: false };
  const inserted = await client.query(
    `INSERT INTO admin_done_for_you_clients
       (target_user_id,created_by_admin_operator_id)
     VALUES ($1,$2)
     ON CONFLICT (target_user_id) DO NOTHING
     RETURNING id,target_user_id,created_by_admin_operator_id,created_at,updated_at`,
    [targetUserId, actorAdminOperatorId]
  );
  if (inserted.rows[0]) return { marker: inserted.rows[0], created: true };
  const raced = await client.query(
    `SELECT id,target_user_id,created_by_admin_operator_id,created_at,updated_at
       FROM admin_done_for_you_clients
      WHERE target_user_id=$1
      FOR UPDATE`,
    [targetUserId]
  );
  return { marker: raced.rows[0], created: false };
}

async function touchExistingMarker(client, markerResult, mutated) {
  if (markerResult.created || !mutated) return markerResult;
  const { rows } = await client.query(
    `UPDATE admin_done_for_you_clients
        SET updated_at=NOW()
      WHERE id=$1
      RETURNING id,target_user_id,created_by_admin_operator_id,created_at,updated_at`,
    [markerResult.marker.id]
  );
  return { marker: rows[0], created: false };
}

async function attachProvisioningContact(client, {
  userId,
  identity,
  markerId,
  canonicalIdentity = null,
  verifiedEvidence = null
}) {
  if (!identity) return null;
  const verifiedAt = verifiedEvidence ? new Date(verifiedEvidence.verifiedAt) : null;
  const verified = verifiedAt && !Number.isNaN(verifiedAt.getTime());
  const beforeVerified = canonicalIdentity?.verification_scope === VERIFICATION_SCOPES.ACCOUNT &&
    Boolean(canonicalIdentity?.verified_at);
  const attached = await attachIdentity(client, {
    userId,
    identityType: identity.identityType,
    value: identity.value,
    verificationScope: verified ? VERIFICATION_SCOPES.ACCOUNT : VERIFICATION_SCOPES.UNVERIFIED,
    verifiedAt: verified ? verifiedAt : null,
    verificationSource: verified ? verifiedEvidence.source : PROVISION_SOURCE,
    sourceRecordId: markerId,
    isPrimary: false
  });
  return {
    ...attached,
    repaired: Boolean(verified && !beforeVerified && !attached.created)
  };
}

function auditContext(value, max) {
  return String(value || '').slice(0, max) || null;
}

async function writeProvisioningAudit(client, {
  actorAdminOperatorId,
  targetUserId,
  marker,
  userCreated,
  host,
  matchedBy,
  email,
  phone,
  claimed,
  actionType,
  mutations,
  requestIp,
  userAgent,
  beforeState,
  afterState
}) {
  await client.query(
    `INSERT INTO admin_account_audit_log
       (actor_user_id,actor_admin_operator_id,target_user_id,action_type,reason,
        before_state,after_state,metadata,request_ip,user_agent)
     VALUES (NULL,$1,$2,$3,
             'Administrator prepared a Done For You client account and Host Page',
             $4::jsonb,$5::jsonb,$6::jsonb,$7,$8)`,
    [
      actorAdminOperatorId,
      targetUserId,
      actionType,
      JSON.stringify(beforeState || {}),
      JSON.stringify(afterState || {}),
      JSON.stringify({
        markerId: Number(marker.id),
        canonicalUserCreated: Boolean(userCreated),
        canonicalUserNameCompleted: Boolean(mutations.userNameCompleted),
        hostPageCreated: Boolean(host.created),
        hostPageCompleted: Boolean(host.updated),
        emailAttached: Boolean(mutations.emailAttached),
        phoneAttached: Boolean(mutations.phoneAttached),
        emailProjectionRepaired: Boolean(mutations.emailProjectionRepaired),
        phoneProjectionRepaired: Boolean(mutations.phoneProjectionRepaired),
        claimed: Boolean(claimed.claimed),
        matchedBy,
        contactTypes: [email ? 'email' : null, phone ? 'phone' : null].filter(Boolean)
      }),
      auditContext(requestIp, 100),
      auditContext(userAgent, 1000)
    ]
  );
}

async function provisionDoneForYouClient(db, {
  actorAdminOperatorId: actorValue,
  expectedUserId,
  hostName,
  contactName,
  email,
  phone = null,
  requestIp = null,
  userAgent = null
}) {
  const actorAdminOperatorId = positiveId(actorValue, 'actorAdminOperatorId');
  if (expectedUserId === undefined) {
    throw new DoneForYouProvisioningError(
      'done_for_you_lookup_required',
      'Preview the exact account match before provisioning.',
      409
    );
  }
  const expectedOwner = expectedUserIdValue(expectedUserId);
  const contacts = normalizeProvisioningInput({ hostName, contactName, email, phone });

  return withTransaction(db, async client => {
    await requireActiveOperator(client, actorAdminOperatorId);
    await lockProvisioningKeys(client, contacts);

    // Canonical identities and proven legacy projections are re-read under
    // lock after the preview. The expected id (including explicit null) makes
    // a concurrent account appearance or reassignment visible to the admin.
    const ownership = await readExactContactOwnership(client, contacts, { forUpdate: true });
    let targetUserId = ownership.targetUserId;
    if (targetUserId !== expectedOwner) {
      throw new DoneForYouProvisioningError(
        'done_for_you_lookup_changed',
        'The exact contact match changed. Review the client again before provisioning.',
        409,
        { expectedUserId: expectedOwner, actualUserId: targetUserId }
      );
    }
    let userCreated = false;
    let user;
    let lockedOrganizer = null;
    if (targetUserId) {
      // Canonical identity operations use identity -> organizer -> user. Keep
      // this same global order so provisioning cannot deadlock with sign-in or
      // recipient verification.
      lockedOrganizer = await lockSingleOrganizer(client, targetUserId);
      user = await lockActiveUser(client, targetUserId);
    } else {
      user = await createCanonicalShell(client, contacts.contactName);
      targetUserId = Number(user.id);
      userCreated = true;
    }

    const beforeState = {
      canonicalUser: userCreated ? null : {
        id: Number(user.id),
        hasName: Boolean(cleanText(user.name, CONTACT_NAME_MAX)),
        status: user.account_status
      },
      doneForYouClient: null,
      hostPage: lockedOrganizer ? {
        id: Number(lockedOrganizer.id),
        hasName: Boolean(cleanText(lockedOrganizer.org_name, HOST_NAME_MAX)),
        hasSlug: Boolean(lockedOrganizer.public_slug)
      } : null,
      contacts: {
        email: ownership.canonicalEmail
          ? { scope: ownership.canonicalEmail.verification_scope }
          : null,
        phone: ownership.canonicalPhone
          ? { scope: ownership.canonicalPhone.verification_scope }
          : null
      }
    };

    // Support may complete missing display fields, but must never overwrite a
    // name the account owner already supplied.
    let userNameCompleted = false;
    if (!cleanText(user.name, CONTACT_NAME_MAX)) {
      const updatedUser = await client.query(
        `UPDATE users SET name=$2,updated_at=NOW() WHERE id=$1
         RETURNING id,name,account_status,created_at,updated_at`,
        [targetUserId, contacts.contactName]
      );
      user = updatedUser.rows[0];
      userNameCompleted = true;
    }

    const host = await ensureSingleHostPage(client, {
      user,
      lockedOrganizer,
      hostName: contacts.hostName,
      contactName: contacts.contactName,
      compatibilityEmail: contacts.email.normalizedValue
    });
    let markerResult = await ensureMarker(
      client,
      targetUserId,
      actorAdminOperatorId
    );

    let emailAttachment;
    let phoneAttachment;
    try {
      emailAttachment = await attachProvisioningContact(client, {
        userId: targetUserId,
        identity: contacts.email,
        markerId: markerResult.marker.id,
        canonicalIdentity: ownership.canonicalEmail,
        verifiedEvidence: ownership.legacyEmail?.last_login_at
          ? {
              verifiedAt: ownership.legacyEmail.last_login_at,
              source: 'legacy_organizers.last_login_at'
            }
          : null
      });
      phoneAttachment = await attachProvisioningContact(client, {
        userId: targetUserId,
        identity: contacts.phone,
        markerId: markerResult.marker.id,
        canonicalIdentity: ownership.canonicalPhone,
        verifiedEvidence: ownership.legacyPhone?.verified_at
          ? {
              verifiedAt: ownership.legacyPhone.verified_at,
              source: 'account_phone_credentials'
            }
          : null
      });
    } catch (error) {
      if (!(error instanceof CanonicalIdentityConflictError)) throw error;
      throw new DoneForYouProvisioningError(
        'done_for_you_lookup_changed',
        'The exact contact match changed. Review the client again before provisioning.',
        409,
        {
          expectedUserId: expectedOwner,
          actualUserId: Number(error.existingUserId) || null,
          ownerUserIds: [error.existingUserId, targetUserId].map(Number).filter(Boolean)
        }
      );
    }

    const claimed = await readDoneForYouClaimState(client, targetUserId);
    const matchedBy = ownership.matchedBy;
    const mutations = {
      userCreated,
      userNameCompleted,
      markerCreated: markerResult.created,
      hostPageCreated: host.created,
      hostPageCompleted: host.updated,
      emailAttached: Boolean(emailAttachment?.created),
      phoneAttached: Boolean(phoneAttachment?.created),
      emailProjectionRepaired: Boolean(emailAttachment?.repaired),
      phoneProjectionRepaired: Boolean(phoneAttachment?.repaired)
    };
    const mutated = Object.values(mutations).some(Boolean);
    markerResult = await touchExistingMarker(
      client,
      markerResult,
      mutated && !markerResult.created
    );
    if (mutated) {
      await writeProvisioningAudit(client, {
        actorAdminOperatorId,
        targetUserId,
        marker: markerResult.marker,
        userCreated,
        host,
        matchedBy,
        email: contacts.email,
        phone: contacts.phone,
        claimed,
        actionType: markerResult.created
          ? 'done_for_you_client_provisioned'
          : 'done_for_you_client_updated',
        mutations,
        requestIp,
        userAgent,
        beforeState,
        afterState: {
          canonicalUser: {
            id: targetUserId,
            hasName: Boolean(user.name || contacts.contactName),
            status: user.account_status || 'active'
          },
          doneForYouClient: { id: Number(markerResult.marker.id) },
          hostPage: {
            id: Number(host.organizer.id),
            hasName: Boolean(host.organizer.org_name),
            hasSlug: Boolean(host.organizer.public_slug)
          },
          contacts: {
            email: { scope: emailAttachment?.identity?.verification_scope || 'unverified' },
            phone: phoneAttachment
              ? { scope: phoneAttachment.identity?.verification_scope || 'unverified' }
              : null
          }
        }
      });
    }

    return {
      id: Number(markerResult.marker.id),
      userId: targetUserId,
      organizerId: Number(host.organizer.id),
      markerCreated: markerResult.created,
      userCreated,
      hostPageCreated: host.created,
      hostPageCompleted: host.updated,
      emailAttached: mutations.emailAttached,
      phoneAttached: mutations.phoneAttached,
      noOp: !mutated,
      matchedBy,
      claimed: claimed.claimed,
      claimedAt: claimed.claimedAt,
      hostPage: {
        name: host.organizer.org_name,
        slug: host.organizer.public_slug
      }
    };
  });
}

async function listDoneForYouClients(db, { limit = 100 } = {}) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const { rows } = await db.query(
    `SELECT marker.id,marker.target_user_id,marker.created_at,marker.updated_at,
            canonical_user.name AS contact_name,canonical_user.account_status,
            organizer.id AS organizer_id,organizer.org_name,organizer.public_slug,
            organizer.last_login_at,
            (SELECT MAX(identity.verified_at)
               FROM user_identities identity
              WHERE identity.user_id=canonical_user.id
                AND identity.revoked_at IS NULL
                AND identity.verification_scope='account'
                AND identity.verified_at IS NOT NULL) AS verified_identity_at,
            (SELECT identity.value
               FROM user_identities identity
              WHERE identity.user_id=canonical_user.id
                AND identity.identity_type='email' AND identity.revoked_at IS NULL
              ORDER BY identity.is_primary DESC,identity.created_at,id LIMIT 1) AS email,
            (SELECT identity.value
               FROM user_identities identity
              WHERE identity.user_id=canonical_user.id
                AND identity.identity_type='phone' AND identity.revoked_at IS NULL
              ORDER BY identity.is_primary DESC,identity.created_at,id LIMIT 1) AS phone,
            (SELECT COUNT(*)::int FROM events event
              WHERE event.organizer_id=organizer.id) AS event_count
       FROM admin_done_for_you_clients marker
       JOIN users canonical_user ON canonical_user.id=marker.target_user_id
       LEFT JOIN organizers organizer ON organizer.user_id=canonical_user.id
      ORDER BY marker.created_at DESC,marker.id DESC
      LIMIT $1`,
    [boundedLimit]
  );
  return rows.map(row => {
    const claimed = claimedStateFromRow(row);
    return {
      id: Number(row.id),
      userId: Number(row.target_user_id),
      contactName: row.contact_name || null,
      accountStatus: row.account_status,
      claimed: claimed.claimed,
      claimedAt: claimed.claimedAt,
      email: row.email || null,
      phone: row.phone || null,
      organizerId: row.organizer_id ? Number(row.organizer_id) : null,
      hostName: row.org_name || null,
      host: row.organizer_id ? {
        organizerId: Number(row.organizer_id),
        name: row.org_name || null,
        slug: row.public_slug || null
      } : null,
      eventCount: Number(row.event_count || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  });
}

async function readDoneForYouClient(db, markerIdValue, { forUpdate = false } = {}) {
  const markerId = positiveId(markerIdValue, 'clientId');
  if (forUpdate) {
    // Read the immutable target first, then acquire row locks in the same
    // organizer -> canonical user -> marker order as provisioning. Avoid a
    // multi-relation FOR UPDATE JOIN: PostgreSQL is free to acquire those
    // rowmarks in plan order, which can invert our global lock order.
    const target = (await db.query(
      'SELECT target_user_id FROM admin_done_for_you_clients WHERE id=$1',
      [markerId]
    )).rows[0];
    if (!target) return null;
    const targetUserId = Number(target.target_user_id);
    const organizer = await db.query(
      'SELECT id FROM organizers WHERE user_id=$1 FOR UPDATE',
      [targetUserId]
    );
    if (!organizer.rows[0]) return null;
    const canonicalUser = await db.query(
      'SELECT id FROM users WHERE id=$1 FOR UPDATE',
      [targetUserId]
    );
    if (!canonicalUser.rows[0]) return null;
    const marker = await db.query(
      `SELECT id FROM admin_done_for_you_clients
        WHERE id=$1 AND target_user_id=$2 FOR UPDATE`,
      [markerId, targetUserId]
    );
    if (!marker.rows[0]) return null;
  }
  const { rows } = await db.query(
    `SELECT marker.id,marker.target_user_id,marker.created_by_admin_operator_id,
            marker.created_at,marker.updated_at,
            canonical_user.name AS contact_name,canonical_user.account_status,
            canonical_user.created_at AS user_created_at,
            organizer.id AS organizer_id,organizer.email AS compatibility_email,
            organizer.org_name,organizer.public_slug,organizer.logo_url,
            organizer.header_image_url,organizer.avatar_url,organizer.bio,
            organizer.website_url,organizer.instagram_handle,organizer.contact_email,
            organizer.last_login_at,
            (SELECT MAX(identity.verified_at)
               FROM user_identities identity
              WHERE identity.user_id=canonical_user.id
                AND identity.revoked_at IS NULL
                AND identity.verification_scope='account'
                AND identity.verified_at IS NOT NULL) AS verified_identity_at
       FROM admin_done_for_you_clients marker
       JOIN users canonical_user ON canonical_user.id=marker.target_user_id
       ${forUpdate ? 'JOIN' : 'LEFT JOIN'} organizers organizer ON organizer.user_id=canonical_user.id
      WHERE marker.id=$1`,
    [markerId]
  );
  const row = rows[0];
  if (!row) return null;
  // A pg Pool safely parallelizes these reads, but this helper is also called
  // with one checked-out Client inside claim transactions. Sequential reads
  // avoid overlapping client.query calls (deprecated by pg and unsafe for
  // transaction/lock reasoning).
  const identities = await db.query(
      `SELECT id,identity_type,value,normalized_value,verification_scope,verified_at,
              verification_source,is_primary,created_at
         FROM user_identities
        WHERE user_id=$1 AND revoked_at IS NULL
          AND identity_type IN ('email','phone')
        ORDER BY identity_type,is_primary DESC,created_at,id`,
      [row.target_user_id]
    );
  const events = await db.query(
      `SELECT id,slug,title,event_date,start_time,status,visibility,venue_name,
              created_at,updated_at
         FROM events
        WHERE organizer_id=$1
        ORDER BY event_date DESC,start_time DESC,id DESC`,
      [row.organizer_id]
    );
  const invitations = await db.query(
      `SELECT id,email,sent_at,expires_at,claimed_at,revoked_at,delivery_failed_at,
              created_at
         FROM admin_account_invitations
        WHERE target_user_id=$1
        ORDER BY created_at DESC,id DESC`,
      [row.target_user_id]
    );
  const claimed = claimedStateFromRow(row);
  return {
    id: Number(row.id),
    owner: {
      userId: Number(row.target_user_id),
      name: row.contact_name || null,
      status: row.account_status,
      claimed: claimed.claimed,
      claimedAt: claimed.claimedAt,
      createdAt: row.user_created_at
    },
    host: row.organizer_id ? {
      organizerId: Number(row.organizer_id),
      name: row.org_name || null,
      slug: row.public_slug || null,
      logoUrl: row.logo_url || null,
      headerImageUrl: row.header_image_url || null,
      avatarUrl: row.avatar_url || null,
      bio: row.bio || null,
      websiteUrl: row.website_url || null,
      instagramHandle: row.instagram_handle || null,
      contactEmail: row.contact_email || null
    } : null,
    identities: identities.rows.map(identity => ({
      id: Number(identity.id),
      type: identity.identity_type,
      value: identity.value,
      verified: identity.verification_scope === VERIFICATION_SCOPES.ACCOUNT && Boolean(identity.verified_at),
      verificationScope: identity.verification_scope,
      verificationSource: identity.verification_source,
      primary: Boolean(identity.is_primary),
      createdAt: identity.created_at
    })),
    events: events.rows.map(event => ({
      id: Number(event.id),
      slug: event.slug,
      title: event.title,
      date: event.event_date,
      startTime: event.start_time,
      status: event.status,
      visibility: event.visibility,
      venueName: event.venue_name || null,
      createdAt: event.created_at,
      updatedAt: event.updated_at
    })),
    claimInvitations: invitations.rows.map(invitation => ({
      id: Number(invitation.id),
      email: invitation.email,
      status: invitation.claimed_at ? 'claimed'
        : invitation.revoked_at ? 'revoked'
          : invitation.delivery_failed_at ? 'delivery_failed'
            : !invitation.sent_at ? 'creating'
              : new Date(invitation.expires_at) <= new Date() ? 'expired' : 'sent',
      sentAt: invitation.sent_at,
      expiresAt: invitation.expires_at,
      claimedAt: invitation.claimed_at,
      createdAt: invitation.created_at
    })),
    createdByAdminOperatorId: Number(row.created_by_admin_operator_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

module.exports = {
  DoneForYouProvisioningError,
  claimedStateFromRow,
  listDoneForYouClients,
  lookupDoneForYouClient,
  maskEmail,
  maskPhone,
  normalizeLookupContacts,
  normalizeProvisioningInput,
  provisionDoneForYouClient,
  readDoneForYouClient,
  readDoneForYouClaimState,
  resolvedOwner
};
