const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.env.SESSION_SECRET ||= 'account-identity-controls-unit-secret';

const {
  COOKIE_NAME,
  MAX_AGE_SECONDS,
  clearIdentityStepUpCookie,
  hasIdentityStepUp,
  parseIdentityStepUp,
  setIdentityStepUpCookie,
  signIdentityStepUp
} = require('../src/lib/identity-step-up');
const {
  makePrimaryEmail,
  removeAccountIdentity,
  replaceVerifiedPhone
} = require('../src/lib/account-identities');
const {
  CanonicalIdentityConflictError,
  CanonicalIdentityError
} = require('../src/lib/canonical-identity');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

function signedStepUpPayload(userId, issuedAt, expiresAt) {
  const payload = `${userId}.${issuedAt}.${expiresAt}`;
  const signature = crypto
    .createHmac('sha256', process.env.SESSION_SECRET)
    .update(`identity-step-up:${payload}`)
    .digest('hex');
  return `${payload}.${signature}`;
}

function responseRecorder() {
  const cookies = [];
  return {
    cookies,
    append(name, value) {
      assert.equal(name, 'Set-Cookie');
      cookies.push(value);
    }
  };
}

function poolFor(handler) {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      return handler(sql, values, calls);
    },
    release() {
      released = true;
    }
  };
  return {
    calls,
    client,
    get released() {
      return released;
    },
    pool: {
      async query(sql, values) {
        calls.push({ sql, values });
        return handler(sql, values, calls);
      },
      async connect() {
        return client;
      }
    }
  };
}

function emailIdentity(overrides = {}) {
  return {
    id: 31,
    user_id: 7,
    identity_type: 'email',
    value: 'owner@example.com',
    normalized_value: 'owner@example.com',
    verified_at: new Date('2026-01-01T00:00:00Z'),
    is_primary: true,
    ...overrides
  };
}

test('identity step-up proof is signed, user-bound, short-lived, and tamper-evident', () => {
  const token = signIdentityStepUp(42, Date.now() - 1000);
  const parsed = parseIdentityStepUp(token);
  assert.equal(parsed.userId, 42);
  assert.ok(parsed.expiresAt <= Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS);
  assert.ok(parsed.expiresAt > Math.floor(Date.now() / 1000));

  const request = { headers: { cookie: `${COOKIE_NAME}=${encodeURIComponent(token)}` } };
  assert.equal(hasIdentityStepUp(request, 42), true);
  assert.equal(hasIdentityStepUp(request, 43), false);

  const replacement = token.endsWith('0') ? '1' : '0';
  assert.equal(parseIdentityStepUp(`${token.slice(0, -1)}${replacement}`), null);

  const expired = signedStepUpPayload(
    42,
    Date.now() - ((MAX_AGE_SECONDS + 10) * 1000),
    Math.floor(Date.now() / 1000) - 1
  );
  assert.equal(parseIdentityStepUp(expired), null);
  assert.equal(parseIdentityStepUp('not-a-proof'), null);
});

test('identity step-up cookie helpers set hardened attributes and clear the proof', () => {
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const response = responseRecorder();
    setIdentityStepUpCookie(response, 7);
    clearIdentityStepUpCookie(response);

    assert.match(response.cookies[0], new RegExp(`^${COOKIE_NAME}=`));
    assert.match(response.cookies[0], /; Path=\/; HttpOnly; SameSite=Lax;/);
    assert.match(response.cookies[0], new RegExp(`Max-Age=${MAX_AGE_SECONDS}`));
    assert.match(response.cookies[0], /; Secure$/);
    assert.equal(
      response.cookies[1],
      `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
    );
  } finally {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  }
});

test('migration 046 scopes account attachment and phone replacement challenges', () => {
  const migration = read('src/db/migrations/046_account_identity_controls.sql');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS requested_user_id INTEGER REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(migration, /'attach_email', 'identity_step_up'/);
  assert.match(
    migration,
    /\(intent IN \('attach_email','identity_step_up'\)\) = \(requested_user_id IS NOT NULL\)/
  );
  assert.match(migration, /purpose IN \('enroll', 'sign_in', 'add_phone'\)/);
  assert.match(
    migration,
    /purpose = 'add_phone' AND provider_sid IS NOT NULL AND code_hash IS NULL AND organizer_id IS NOT NULL/
  );
  assert.doesNotMatch(migration, /ALTER TABLE (rsvps|host_follows)/);
});

test('Account settings exposes one focused, responsive identity-management flow', () => {
  const view = read('src/views/settings-v2.html');
  const client = read('public/js/settings.js');
  const styles = read('public/css/settings.css');
  const routes = read('src/routes/auth.js');

  assert.match(view, /Sign-in &amp; recovery/);
  assert.match(view, /id="identity-add-email"/);
  assert.match(view, /id="identity-add-phone"/);
  assert.match(view, /<dialog class="identity-dialog"/);
  assert.doesNotMatch(view, /id="email-value"/);

  assert.match(client, /api\('\/api\/me\/identities'\)/);
  assert.match(client, /api\('\/api\/me\/identities\/step-up\/start'/);
  assert.match(client, /api\('\/api\/auth\/verify-code'/);
  assert.match(client, /identity_step_up_required/);
  assert.match(client, /body\.classList\.add\('identity-dialog-open'\)/);

  assert.match(styles, /@media\(max-width:879px\)[\s\S]*\.identity-dialog\s*\{[\s\S]*height:100dvh/);
  assert.match(styles, /body\.identity-dialog-open \.settings-form-actions/);

  const protectedRoutes = routes.match(/requireIdentityStepUp/g) || [];
  assert.ok(protectedRoutes.length >= 5, 'every credential mutation should require fresh proof');
  assert.match(routes, /clearIdentityStepUpCookie\(res\)/);
});

test('making a secondary email primary mirrors organizers.email in one transaction', async () => {
  const primary = emailIdentity();
  const secondary = emailIdentity({
    id: 32,
    value: 'Second@Example.com',
    normalized_value: 'second@example.com',
    is_primary: false
  });
  const harness = poolFor(async sql => {
    if (sql.includes('FROM user_identities') && sql.includes("identity_type='email'")) {
      return { rows: [primary, secondary] };
    }
    if (sql.includes('FROM organizers')) return { rows: [{ id: 7, email: primary.normalized_value }] };
    if (sql.startsWith('UPDATE user_identities')) return { rows: [] };
    if (sql.startsWith('UPDATE organizers')) return { rows: [] };
    if (sql.startsWith('UPDATE users')) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  });

  const result = await makePrimaryEmail(harness.pool, { userId: 7, identityId: 32 });

  assert.equal(result.id, 32);
  assert.equal(result.isPrimary, true);
  assert.equal(harness.calls[0].sql, 'BEGIN');
  assert.equal(harness.calls.at(-1).sql, 'COMMIT');
  assert.equal(harness.released, true);
  const clearPrimary = harness.calls.find(call => /SET is_primary=FALSE/.test(call.sql));
  const setPrimary = harness.calls.find(call => /SET is_primary=TRUE/.test(call.sql));
  const mirror = harness.calls.find(call => call.sql.startsWith('UPDATE organizers'));
  assert.deepEqual(clearPrimary.values, [7]);
  assert.deepEqual(setPrimary.values, [32]);
  assert.deepEqual(mirror.values, [7, 'second@example.com']);
});

test('a primary-email mirror collision rolls back the primary swap', async () => {
  const primary = emailIdentity();
  const secondary = emailIdentity({
    id: 32,
    value: 'second@example.com',
    normalized_value: 'second@example.com',
    is_primary: false
  });
  const harness = poolFor(async sql => {
    if (sql.includes('FROM user_identities') && sql.includes("identity_type='email'")) {
      return { rows: [primary, secondary] };
    }
    if (sql.includes('FROM organizers')) return { rows: [{ id: 7, email: primary.normalized_value }] };
    if (sql.startsWith('UPDATE user_identities')) return { rows: [] };
    if (sql.startsWith('UPDATE organizers')) {
      const error = new Error('duplicate organizer email');
      error.code = '23505';
      throw error;
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  await assert.rejects(
    makePrimaryEmail(harness.pool, { userId: 7, identityId: 32 }),
    error => error instanceof CanonicalIdentityConflictError
      && error.code === 'email_owner_conflict'
  );
  assert.equal(harness.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(harness.calls.some(call => call.sql === 'COMMIT'), false);
  assert.equal(harness.released, true);
});

test('primary and last verified emails cannot be removed', async t => {
  await t.test('the current primary is protected', async () => {
    const primary = emailIdentity();
    const secondary = emailIdentity({ id: 32, is_primary: false });
    const harness = poolFor(async sql => {
      if (sql.includes('WHERE id=$1 AND user_id=$2')) return { rows: [primary] };
      if (sql.includes('FOR UPDATE')) return { rows: [primary, secondary] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await assert.rejects(
      removeAccountIdentity(harness.pool, { userId: 7, identityId: 31 }),
      error => error instanceof CanonicalIdentityError
        && error.code === 'primary_identity_required'
    );
    assert.equal(harness.calls.at(-1).sql, 'ROLLBACK');
  });

  await t.test('the only verified email is protected even if legacy data lacks a primary flag', async () => {
    const onlyEmail = emailIdentity({ is_primary: false });
    const harness = poolFor(async sql => {
      if (sql.includes('WHERE id=$1 AND user_id=$2')) return { rows: [onlyEmail] };
      if (sql.includes('FOR UPDATE')) return { rows: [onlyEmail] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await assert.rejects(
      removeAccountIdentity(harness.pool, { userId: 7, identityId: 31 }),
      error => error instanceof CanonicalIdentityError
        && error.code === 'last_email_required'
    );
    assert.equal(harness.calls.at(-1).sql, 'ROLLBACK');
  });
});

test('phone replacement rolls back the old-phone revocation when the new phone is owned elsewhere', async () => {
  const oldPhone = '+14155550123';
  const newPhone = '+14155550124';
  const oldIdentity = {
    id: 91,
    user_id: 7,
    identity_type: 'phone',
    value: oldPhone,
    normalized_value: oldPhone,
    verified_at: new Date('2026-01-01T00:00:00Z'),
    verification_scope: 'account',
    verification_source: 'account_phone_credentials',
    source_record_id: 55,
    is_primary: true
  };
  const harness = poolFor(async (sql, values) => {
    if (sql.startsWith('SELECT id,is_admin FROM organizers')) {
      return { rows: [{ id: 7, is_admin: false }] };
    }
    if (sql.startsWith('SELECT normalized_value')) return { rows: [{ normalized_value: oldPhone }] };
    if (sql.includes('FROM account_phone_credentials') && sql.includes('phone_e164=$1 AND')) {
      return { rows: [{ id: 55, organizer_id: 7, phone_e164: oldPhone }] };
    }
    if (sql.includes('FROM user_identities') && sql.includes('normalized_value=$2')) {
      return { rows: values[1] === oldPhone ? [oldIdentity] : [] };
    }
    if (sql.startsWith('UPDATE user_identities')) return { rows: [{ id: 91 }] };
    if (sql.startsWith('UPDATE user_identity_verifications')) return { rows: [] };
    if (sql.startsWith('UPDATE account_phone_credentials')) return { rows: [{ id: 55 }] };
    if (sql.startsWith('UPDATE phone_auth_challenges')) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM account_phone_credentials') && sql.includes('(phone_e164=$1 OR organizer_id=$2)')) {
      assert.deepEqual(values, [newPhone, 7]);
      return {
        rows: [{
          id: 72,
          organizer_id: 8,
          phone_e164: newPhone,
          verified_at: new Date('2026-02-01T00:00:00Z')
        }]
      };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  await assert.rejects(
    replaceVerifiedPhone(harness.pool, {
      userId: 7,
      phone: newPhone,
      verifiedAt: new Date('2026-03-01T00:00:00Z')
    }),
    error => error instanceof CanonicalIdentityConflictError
      && error.code === 'phone_owner_conflict'
      && error.existingUserId === 8
  );

  assert.ok(harness.calls.some(call => call.sql.startsWith('UPDATE account_phone_credentials')));
  assert.equal(harness.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(harness.calls.some(call => call.sql === 'COMMIT'), false);
  assert.equal(harness.released, true);
});
