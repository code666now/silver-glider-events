const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'phone-auth-schema-unit-secret';
const { createSignInChallenge } = require('../src/lib/sign-in-challenges');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('phone auth schema keeps account credentials separate from messaging consent', () => {
  const migration = read('src/db/migrations/041_phone_auth.sql');
  const verifyOnlyMigration = read('src/db/migrations/042_verify_only_phone_auth.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS account_phone_credentials/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS phone_auth_challenges/);
  assert.match(migration, /account_phone_credentials_active_phone_uq[\s\S]*WHERE revoked_at IS NULL/);
  assert.match(migration, /account_phone_credentials_active_organizer_uq[\s\S]*WHERE revoked_at IS NULL/);
  assert.match(migration, /purpose IN \('enroll', 'sign_in'\)/);
  assert.match(migration, /phone_e164 ~ '\^\\\+\[1-9\]\[0-9\]\{7,14\}\$'/);
  assert.doesNotMatch(migration, /ALTER TABLE (rsvps|host_follows)/);
  assert.match(verifyOnlyMigration, /purpose='sign_in' AND provider_sid IS NULL AND used_at IS NULL/);
  assert.match(verifyOnlyMigration, /purpose = 'sign_in' AND provider_sid IS NOT NULL[\s\S]*organizer_id IS NOT NULL/);
  assert.doesNotMatch(verifyOnlyMigration, /ALTER TABLE (rsvps|host_follows)/);
});

test('a phone enrollment email challenge retains its exact phone challenge link', async () => {
  let query;
  let values;
  const db = {
    async query(receivedQuery, receivedValues) {
      query = receivedQuery;
      values = receivedValues;
      return { rows: [] };
    }
  };

  const created = await createSignInChallenge(db, {
    email: 'lucas@example.com',
    intent: 'bind_phone',
    phoneAuthChallengeId: 87,
    returnPath: '/events/new'
  });

  assert.match(query, /phone_auth_challenge_id/);
  assert.equal(values[5], 87);
  assert.equal(created.phoneAuthChallengeId, 87);
  assert.equal(created.code.length, 6);
  assert.ok(created.requestToken);
});

test('concurrent phone bindings are converted into a safe identity conflict', () => {
  const phoneAuth = read('src/lib/phone-auth.js');
  assert.match(phoneAuth, /error\?\.code === '23505'/);
  assert.match(phoneAuth, /code: 'phone_identity_conflict', status: 409/);
});
