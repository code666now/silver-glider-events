const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CanonicalIdentityConflictError,
  CanonicalIdentityError,
  attachIdentity,
  attachVerifiedPhoneIdentity,
  ensureCanonicalUser,
  normalizeEmail,
  normalizeIdentity,
  normalizeVerification,
  resolveAccountIdentity,
  resolveOrCreateOrganizerByEmail,
  resolveScopedIdentity,
  resolveVerifiedPhoneIdentity,
  revokeActivePhoneIdentity,
  withCanonicalIdentityTransaction
} = require('../src/lib/canonical-identity');

function identityRow(overrides = {}) {
  return {
    id: 31,
    user_id: 7,
    identity_type: 'email',
    value: 'Person@Example.com',
    normalized_value: 'person@example.com',
    verified_at: null,
    verification_scope: 'unverified',
    verification_source: 'legacy_organizers.email',
    source_record_id: 7,
    verification_context_type: null,
    verification_context_id: null,
    is_primary: true,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides
  };
}

test('identity normalization is deterministic without changing opaque Google subjects', () => {
  assert.equal(normalizeEmail('  PERSON@Example.COM '), 'person@example.com');
  assert.deepEqual(normalizeIdentity('phone', '(415) 555-0123'), {
    identityType: 'phone',
    value: '+14155550123',
    normalizedValue: '+14155550123'
  });
  assert.deepEqual(normalizeIdentity('google', '  109876543210ABC  '), {
    identityType: 'google',
    value: '109876543210ABC',
    normalizedValue: '109876543210ABC'
  });
  assert.throws(
    () => normalizeEmail('not-an-email'),
    error => error instanceof CanonicalIdentityError && error.code === 'invalid_email'
  );
});

test('event and photo proofs require context and cannot masquerade as account proof', () => {
  assert.throws(
    () => normalizeVerification({
      verificationScope: 'photo',
      verifiedAt: new Date(),
      verificationSource: 'photo_access_token'
    }),
    error => error instanceof CanonicalIdentityError
      && error.code === 'invalid_verification_context'
  );

  assert.throws(
    () => normalizeVerification({
      verificationScope: 'account',
      verifiedAt: new Date(),
      verificationSource: 'magic_link',
      verificationContextType: 'event',
      verificationContextId: 12
    }),
    error => error instanceof CanonicalIdentityError
      && error.code === 'invalid_verification_context'
  );
});

test('ensureCanonicalUser is idempotent and permits a null name', async () => {
  let sql;
  let values;
  const expected = { id: 7, name: null };
  const db = {
    async query(receivedSql, receivedValues) {
      sql = receivedSql;
      values = receivedValues;
      return { rows: [expected] };
    }
  };

  const user = await ensureCanonicalUser(db, { id: 7, name: '' });
  assert.equal(user, expected);
  assert.match(sql, /ON CONFLICT \(id\) DO UPDATE/);
  assert.match(sql, /COALESCE\(users\.name,EXCLUDED\.name\)/);
  assert.deepEqual(values.slice(0, 2), [7, null]);
});

test('attachIdentity refuses to auto-merge an identifier owned by another user', async () => {
  const owner = identityRow({ user_id: 8 });
  const db = {
    async query(sql) {
      if (sql.startsWith('SELECT id FROM users')) return { rows: [{ id: 7 }] };
      if (sql.includes('FROM user_identities')) return { rows: [owner] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  await assert.rejects(
    attachIdentity(db, {
      userId: 7,
      identityType: 'email',
      value: 'PERSON@example.com',
      verificationScope: 'unverified',
      verificationSource: 'legacy_organizers.email',
      sourceRecordId: 7,
      isPrimary: true
    }),
    error => error instanceof CanonicalIdentityConflictError
      && error.code === 'identity_conflict'
      && error.existingUserId === 8
      && error.requestedUserId === 7
  );
});

test('same-owner attach is idempotent and can explicitly promote proof to account scope', async () => {
  const original = identityRow();
  const promotedAt = new Date('2026-06-15T18:00:00Z');
  const promoted = identityRow({
    verified_at: promotedAt,
    verification_scope: 'account',
    verification_source: 'magic_link'
  });
  const calls = [];
  const db = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT id FROM users')) return { rows: [{ id: 7 }] };
      if (sql.includes('FROM user_identities')) return { rows: [original] };
      if (sql.startsWith('UPDATE user_identities')) return { rows: [promoted] };
      if (sql.startsWith('INSERT INTO user_identity_verifications')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const result = await attachIdentity(db, {
    userId: 7,
    identityType: 'email',
    value: 'person@example.com',
    verifiedAt: promotedAt,
    verificationScope: 'account',
    verificationSource: 'magic_link',
    sourceRecordId: 901,
    isPrimary: true
  });

  assert.equal(result.created, false);
  assert.equal(result.identity.verification_scope, 'account');
  const update = calls.find(call => call.sql.startsWith('UPDATE user_identities'));
  assert.ok(update);
  assert.equal(update.values[1], true);
  assert.equal(update.values[3], 'account');
  assert.equal(update.values[4], 'magic_link');
});

test('a lower-scope proof never downgrades an existing account identity', async () => {
  const accountIdentity = identityRow({
    verified_at: new Date('2026-02-01T00:00:00Z'),
    verification_scope: 'account',
    verification_source: 'magic_link'
  });
  let queryCount = 0;
  const db = {
    async query(sql) {
      queryCount += 1;
      if (sql.startsWith('SELECT id FROM users')) return { rows: [{ id: 7 }] };
      if (sql.includes('FROM user_identities')) return { rows: [accountIdentity] };
      if (sql.startsWith('INSERT INTO user_identity_verifications')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const result = await attachIdentity(db, {
    userId: 7,
    identityType: 'email',
    value: 'person@example.com',
    verifiedAt: new Date('2026-07-01T00:00:00Z'),
    verificationScope: 'photo',
    verificationSource: 'photo_access_token',
    verificationContextType: 'event',
    verificationContextId: 44
  });

  assert.equal(result.identity.verification_scope, 'account');
  assert.equal(queryCount, 3);
});

test('fresh attach uses conflict-safe insertion and returns the created identity', async () => {
  const created = identityRow({
    id: 91,
    value: '+14155550123',
    normalized_value: '+14155550123',
    identity_type: 'phone',
    verified_at: new Date('2026-04-10T12:00:00Z'),
    verification_scope: 'account',
    verification_source: 'account_phone_credentials',
    source_record_id: 55
  });
  const calls = [];
  const db = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT id FROM users')) return { rows: [{ id: 7 }] };
      if (sql.includes('FROM user_identities') && sql.includes('normalized_value=$2')) {
        return { rows: [] };
      }
      if (sql.includes('AND is_primary')) return { rows: [] };
      if (sql.startsWith('INSERT INTO user_identities')) return { rows: [created] };
      if (sql.startsWith('INSERT INTO user_identity_verifications')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const result = await attachIdentity(db, {
    userId: 7,
    identityType: 'phone',
    value: '415-555-0123',
    verifiedAt: created.verified_at,
    verificationScope: 'account',
    verificationSource: 'account_phone_credentials',
    sourceRecordId: 55,
    isPrimary: true
  });

  assert.equal(result.created, true);
  assert.equal(result.identity.id, 91);
  const insert = calls.find(call => call.sql.startsWith('INSERT INTO user_identities'));
  assert.match(insert.sql, /ON CONFLICT DO NOTHING/);
  assert.equal(insert.values[3], '+14155550123');
});

test('account resolver explicitly excludes lower-scope and unverified identities', async () => {
  let sql;
  const db = {
    async query(receivedSql) {
      sql = receivedSql;
      return { rows: [] };
    }
  };

  assert.equal(await resolveAccountIdentity(db, {
    identityType: 'email',
    value: 'person@example.com'
  }), null);
  assert.match(sql, /verification_scope='account'/);
  assert.match(sql, /verified_at IS NOT NULL/);
});

test('attachIdentity owns a transaction when it receives a pool', async () => {
  const calls = [];
  let released = false;
  const existing = identityRow();
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('FROM user_identities')) return { rows: [existing] };
      if (sql.startsWith('SELECT id FROM users')) return { rows: [{ id: 7 }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {
      released = true;
    }
  };
  const pool = {
    async query() {},
    async connect() {
      return client;
    }
  };

  const result = await attachIdentity(pool, {
    userId: 7,
    identityType: 'email',
    value: 'person@example.com',
    verificationScope: 'unverified',
    verificationSource: 'organizers.email',
    sourceRecordId: 7,
    isPrimary: true
  });
  assert.equal(result.created, false);
  assert.equal(calls[0], 'BEGIN');
  assert.equal(calls.at(-1), 'COMMIT');
  assert.equal(released, true);
});

test('same-user concurrent attach re-reads after the user lock and stays idempotent', async () => {
  const concurrentWinner = identityRow();
  const order = [];
  let identityReads = 0;
  const db = {
    async query(sql) {
      if (sql.includes('FROM user_identities')) {
        order.push('identity');
        identityReads += 1;
        return { rows: identityReads === 1 ? [] : [concurrentWinner] };
      }
      if (sql.startsWith('SELECT id FROM users')) {
        order.push('user');
        return { rows: [{ id: 7 }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const result = await attachIdentity(db, {
    userId: 7,
    identityType: 'email',
    value: 'person@example.com',
    verificationScope: 'unverified',
    verificationSource: 'organizers.email',
    sourceRecordId: 7,
    isPrimary: true
  });
  assert.equal(result.created, false);
  assert.equal(result.identity.id, concurrentWinner.id);
  assert.deepEqual(order, ['identity', 'user', 'identity']);
});

test('promoting an existing non-primary identity reports a controlled primary conflict', async () => {
  const secondary = identityRow({ id: 32, is_primary: false });
  let updated = false;
  const db = {
    async query(sql) {
      if (sql.includes('AND is_primary')) {
        return {
          rows: [{
            id: 31,
            user_id: 7,
            identity_type: 'email',
            normalized_value: 'other@example.com'
          }]
        };
      }
      if (sql.includes('FROM user_identities')) return { rows: [secondary] };
      if (sql.startsWith('SELECT id FROM users')) return { rows: [{ id: 7 }] };
      if (sql.startsWith('UPDATE user_identities')) updated = true;
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  await assert.rejects(
    attachIdentity(db, {
      userId: 7,
      identityType: 'email',
      value: 'person@example.com',
      verificationScope: 'unverified',
      verificationSource: 'organizers.email',
      sourceRecordId: 7,
      isPrimary: true
    }),
    error => error instanceof CanonicalIdentityConflictError
      && error.code === 'primary_identity_conflict'
  );
  assert.equal(updated, false);
});

test('multiple event proofs remain context-specific while the identity stays unverified', async () => {
  const unverified = identityRow();
  const contexts = [];
  const db = {
    async query(sql, values) {
      if (sql.includes('FROM user_identities')) return { rows: [unverified] };
      if (sql.startsWith('SELECT id FROM users')) return { rows: [{ id: 7 }] };
      if (sql.startsWith('INSERT INTO user_identity_verifications')) {
        contexts.push(values[6]);
        return { rows: [{ id: contexts.length, verification_context_id: values[6] }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  for (const eventId of [44, 45]) {
    const result = await attachIdentity(db, {
      userId: 7,
      identityType: 'email',
      value: 'person@example.com',
      verifiedAt: new Date(Date.UTC(2026, 5, eventId - 40, 12)),
      verificationScope: 'event',
      verificationSource: 'typed_guest_code',
      sourceRecordId: 1000 + eventId,
      verificationContextType: 'event',
      verificationContextId: eventId
    });
    assert.equal(result.identity.verification_scope, 'unverified');
    assert.equal(result.identity.verified_at, null);
  }
  assert.deepEqual(contexts, [44, 45]);
});

test('scoped resolver requires the exact context proof', async () => {
  let sql;
  let values;
  const db = {
    async query(receivedSql, receivedValues) {
      sql = receivedSql;
      values = receivedValues;
      return { rows: [] };
    }
  };
  assert.equal(await resolveScopedIdentity(db, {
    identityType: 'email',
    value: 'person@example.com',
    verificationScope: 'photo',
    verificationContextType: 'event',
    verificationContextId: 44
  }), null);
  assert.match(sql, /JOIN user_identity_verifications proof/);
  assert.deepEqual(values.slice(2), ['photo', 'event', 44]);
});

test('pool-owned identity transactions commit and release their client', async () => {
  const calls = [];
  let released = false;
  const client = {
    async query(sql) {
      calls.push(sql);
      return { rows: [{ ok: true }] };
    },
    release() {
      released = true;
    }
  };
  const pool = {
    async query() {},
    async connect() {
      return client;
    }
  };

  const result = await withCanonicalIdentityTransaction(pool, async connection => {
    const response = await connection.query('SELECT identity work');
    return response.rows[0];
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ['BEGIN', 'SELECT identity work', 'COMMIT']);
  assert.equal(released, true);
});

test('email resolver rejects multiple normalized legacy rows without creating or merging', async () => {
  const writes = [];
  const db = {
    async query(sql) {
      if (/^(INSERT|UPDATE)/.test(sql)) writes.push(sql);
      if (sql.includes('FROM user_identities')) return { rows: [] };
      if (sql.includes('FROM organizers') && sql.includes('LOWER(BTRIM(email))')) {
        return {
          rows: [
            { id: 7, email: 'person@example.com' },
            { id: 8, email: ' person@example.com ' }
          ]
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  await assert.rejects(
    resolveOrCreateOrganizerByEmail(db, { email: ' PERSON@example.com ' }),
    error => error instanceof CanonicalIdentityConflictError
      && error.code === 'ambiguous_legacy_email'
  );
  assert.equal(writes.length, 0);
});

test('verified phone attach refuses a legacy credential owned by another user', async () => {
  const organizer = {
    id: 7,
    user_id: 7,
    email: 'person@example.com',
    name: null,
    account_status: 'active',
    created_at: new Date('2026-01-01T00:00:00Z'),
    last_login_at: null
  };
  const db = {
    async query(sql) {
      if (sql.includes('FROM user_identities')) return { rows: [] };
      if (sql.includes('FROM organizers') && sql.includes('WHERE organizer.id=$1')) {
        return { rows: [organizer] };
      }
      if (sql.startsWith('INSERT INTO users')) return { rows: [{ id: 7, name: null }] };
      if (sql.startsWith('UPDATE organizers')) return { rows: [organizer] };
      if (sql.includes('FROM account_phone_credentials')) {
        return {
          rows: [{
            id: 55,
            organizer_id: 8,
            phone_e164: '+14155550123',
            verified_at: new Date('2026-02-01T00:00:00Z')
          }]
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  await assert.rejects(
    attachVerifiedPhoneIdentity(db, {
      userId: 7,
      phone: '+14155550123',
      verifiedAt: new Date('2026-02-01T00:00:00Z')
    }),
    error => error instanceof CanonicalIdentityConflictError
      && error.code === 'phone_owner_conflict'
      && error.existingUserId === 8
  );
});

test('phone attach keeps the credential, identity, organizer, user lock order', async () => {
  const verifiedAt = new Date('2026-02-01T00:00:00Z');
  const organizer = {
    id: 7,
    user_id: 7,
    email: 'person@example.com',
    name: null,
    account_status: 'active',
    created_at: new Date('2026-01-01T00:00:00Z'),
    last_login_at: null
  };
  const credential = {
    id: 55,
    organizer_id: 7,
    phone_e164: '+14155550123',
    verified_at: verifiedAt
  };
  const canonical = identityRow({
    id: 92,
    identity_type: 'phone',
    value: '+14155550123',
    normalized_value: '+14155550123',
    verified_at: verifiedAt,
    verification_scope: 'account',
    verification_source: 'account_phone_credentials',
    source_record_id: 55
  });
  const lockOrder = [];
  const db = {
    async query(sql) {
      if (sql.includes('FROM account_phone_credentials')) {
        lockOrder.push('credential');
        return { rows: [credential] };
      }
      if (sql.includes('FROM user_identities')) {
        lockOrder.push('identity');
        return { rows: [canonical] };
      }
      if (sql.includes('FROM organizers') && sql.includes('WHERE organizer.id=$1')) {
        lockOrder.push('organizer');
        return { rows: [organizer] };
      }
      if (sql.startsWith('INSERT INTO users')) {
        lockOrder.push('user');
        return { rows: [{ id: 7, name: null }] };
      }
      if (sql.startsWith('UPDATE organizers')) return { rows: [organizer] };
      if (sql.startsWith('SELECT id FROM users')) return { rows: [{ id: 7 }] };
      if (sql.startsWith('INSERT INTO user_identity_verifications')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  await attachVerifiedPhoneIdentity(db, {
    userId: 7,
    phone: '+14155550123',
    verifiedAt,
    verificationSource: 'twilio_verify'
  });
  assert.deepEqual(lockOrder.slice(0, 4), ['credential', 'identity', 'organizer', 'user']);
});

test('verified phone resolver repairs a missing canonical row from active legacy proof', async () => {
  const verifiedAt = new Date('2026-02-01T00:00:00Z');
  const organizer = {
    id: 7,
    user_id: 7,
    email: 'person@example.com',
    name: null,
    account_status: 'active',
    created_at: new Date('2026-01-01T00:00:00Z'),
    last_login_at: null
  };
  const credential = {
    id: 55,
    organizer_id: 7,
    phone_e164: '+14155550123',
    verified_at: verifiedAt
  };
  const repairedIdentity = identityRow({
    id: 92,
    identity_type: 'phone',
    value: '+14155550123',
    normalized_value: '+14155550123',
    verified_at: verifiedAt,
    verification_scope: 'account',
    verification_source: 'account_phone_credentials',
    source_record_id: 55
  });
  const db = {
    async query(sql) {
      if (sql.includes('FROM user_identities')) return { rows: [] };
      if (sql.includes('FROM account_phone_credentials')) return { rows: [credential] };
      if (sql.includes('FROM organizers') && sql.includes('WHERE organizer.id=$1')) {
        return { rows: [organizer] };
      }
      if (sql.startsWith('INSERT INTO users')) return { rows: [{ id: 7, name: null }] };
      if (sql.startsWith('UPDATE organizers')) return { rows: [organizer] };
      if (sql.startsWith('SELECT id FROM users')) return { rows: [{ id: 7 }] };
      if (sql.includes('AND is_primary')) return { rows: [] };
      if (sql.startsWith('INSERT INTO user_identities')) return { rows: [repairedIdentity] };
      if (sql.startsWith('INSERT INTO user_identity_verifications')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const result = await resolveVerifiedPhoneIdentity(db, { phone: '(415) 555-0123' });
  assert.equal(result.repaired, true);
  assert.equal(result.identity.user_id, 7);
  assert.equal(result.identity.verification_scope, 'account');
  assert.equal(result.credential.id, 55);
});

test('phone revocation is idempotent across canonical, legacy, and pending challenges', async () => {
  const calls = [];
  const db = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('FROM user_identities')) return { rows: [] };
      if (sql.includes('FROM account_phone_credentials')) return { rows: [] };
      if (sql.startsWith('UPDATE account_phone_credentials')) return { rows: [], rowCount: 0 };
      if (sql.startsWith('UPDATE phone_auth_challenges')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const result = await revokeActivePhoneIdentity(db, {
    userId: 7,
    phone: '+14155550123'
  });
  assert.equal(result.identityRevoked, false);
  assert.equal(result.credentialRevoked, false);
  assert.equal(result.challengesInvalidated, 0);
  assert.ok(calls.some(sql => sql.startsWith('UPDATE account_phone_credentials')));
  assert.ok(calls.some(sql => sql.startsWith('UPDATE phone_auth_challenges')));
});
