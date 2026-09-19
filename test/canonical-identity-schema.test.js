const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(
  __dirname,
  '..',
  'src',
  'db',
  'migrations',
  '043_canonical_user_identity_foundation.sql'
), 'utf8');

test('canonical users preserve organizer IDs and use one safely repaired allocator', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS users/);
  assert.match(migration, /id\s+INTEGER PRIMARY KEY/);
  assert.match(migration, /name\s+TEXT,/);
  assert.doesNotMatch(migration, /name\s+TEXT NOT NULL/);
  assert.match(migration, /INSERT INTO users \(id, name, created_at, updated_at\)[\s\S]*SELECT[\s\S]*o\.id/);
  assert.match(migration, /pg_get_serial_sequence\('organizers', 'id'\)/);
  assert.match(migration, /SELECT last_value,is_called/);
  assert.match(migration, /GREATEST\(sequence_last_value, COALESCE\(maximum_user_id, 1\)\)/);
  assert.doesNotMatch(migration, /setval\([\s\S]{0,200}COALESCE\(\(SELECT MAX/);
  assert.match(migration, /CHECK \(user_id IS NULL OR user_id = id\)/);
  assert.match(migration, /CREATE TRIGGER organizers_ensure_canonical_user[\s\S]*AFTER INSERT OR UPDATE OF name ON organizers/);
  assert.doesNotMatch(migration, /CREATE TRIGGER organizers_ensure_canonical_user[\s\S]*BEFORE INSERT/);
  assert.match(migration, /UPDATE organizers[\s\S]*SET user_id = NEW\.id/);
  assert.match(migration, /SET name = EXCLUDED\.name,[\s\S]*users\.name IS DISTINCT FROM EXCLUDED\.name/);
});

test('active normalized identities are unique and proof scope is explicit', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS user_identities/);
  assert.match(migration, /identity_type IN \('email', 'phone', 'google'\)/);
  assert.match(migration, /user_identities_scope_check[\s\S]*verification_scope IN \('unverified', 'account'\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS user_identity_verifications/);
  assert.match(migration, /user_identity_verifications_scope_check[\s\S]*verification_scope IN \('account', 'event', 'photo'\)/);
  assert.match(migration, /user_identity_verifications_active_proof_uq[\s\S]*COALESCE\(verification_context_type, ''\)[\s\S]*COALESCE\(verification_context_id, 0\)/);
  assert.match(migration, /user_identities_active_value_uq[\s\S]*\(identity_type, normalized_value\)[\s\S]*WHERE revoked_at IS NULL/);
  assert.match(migration, /user_identities_active_primary_uq[\s\S]*WHERE revoked_at IS NULL AND is_primary/);
});

test('legacy email backfill verifies only login-backed evidence and quarantines collisions', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS user_identity_conflicts/);
  assert.match(migration, /COUNT\(\*\) OVER \(PARTITION BY LOWER\(BTRIM\(o\.email\)\)\)/);
  assert.match(migration, /candidate\.normalized_count > 1/);
  assert.match(migration, /'normalized_value_collision'/);
  assert.match(migration, /CASE WHEN candidate\.last_login_at IS NULL THEN 'unverified' ELSE 'account' END/);
  assert.match(migration, /WHEN candidate\.last_login_at IS NULL THEN 'legacy_organizers\.email'[\s\S]*ELSE 'legacy_organizers\.last_login_at'/);
  assert.doesNotMatch(migration, /FROM\s+(rsvps|host_follows|guest_invitations)/i);
});

test('phone backfill imports only active verified account credentials', () => {
  assert.match(migration, /FROM account_phone_credentials credential[\s\S]*WHERE credential\.revoked_at IS NULL/);
  assert.match(migration, /candidate\.verified_at,[\s\S]*'account',[\s\S]*'account_phone_credentials'/);
  assert.doesNotMatch(migration, /FROM\s+(rsvps|host_follows|guest_invitations)/i);
});
