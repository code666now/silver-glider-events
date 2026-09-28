const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const {
  DoneForYouProvisioningError,
  claimedStateFromRow,
  maskEmail,
  maskPhone,
  normalizeProvisioningInput,
  resolvedOwner
} = require('../src/lib/admin-done-for-you');

test('Done For You migration keeps a PII-free one-to-one canonical marker', () => {
  const migration = read('src/db/migrations/055_admin_done_for_you_foundation.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS admin_done_for_you_clients/);
  assert.match(migration, /target_user_id\s+INTEGER NOT NULL UNIQUE REFERENCES users\(id\)/);
  assert.match(migration, /created_by_admin_operator_id\s+BIGINT NOT NULL REFERENCES admin_operators\(id\)/);
  assert.doesNotMatch(migration, /admin_done_for_you_clients[\s\S]{0,500}\b(?:email|phone|contact_name|host_name)\b/i);

  assert.match(migration, /ADD COLUMN IF NOT EXISTS target_user_id INTEGER REFERENCES users\(id\)/);
  assert.match(migration, /claimed_user_id IS NULL[\s\S]*target_user_id IS NULL[\s\S]*claimed_user_id=target_user_id/);
  assert.match(migration, /admin_account_invitations_pending_target_uq/);
  assert.match(migration, /WHERE target_user_id IS NOT NULL[\s\S]*claimed_at IS NULL[\s\S]*revoked_at IS NULL[\s\S]*delivery_failed_at IS NULL/);
  assert.doesNotMatch(migration, /admin_account_invitations_pending_target_uq[\s\S]{0,300}(?:NOW\(\)|expires_at)/);
});

test('provisioning resolves exact canonical contacts and never searches RSVP data', () => {
  const service = read('src/lib/admin-done-for-you.js');
  assert.match(service, /FROM user_identities/);
  assert.match(service, /identity_type='email' AND normalized_value=\$1/);
  assert.match(service, /FROM organizers organizer[\s\S]*LOWER\(BTRIM\(organizer\.email\)\)=\$1/);
  assert.match(service, /FROM account_phone_credentials credential[\s\S]*credential\.phone_e164=\$1/);
  assert.match(service, /done-for-you:identity:email:/);
  assert.match(service, /\.filter\(Boolean\)\.sort\(\)/);
  assert.doesNotMatch(service, /\bFROM rsvps\b|\bJOIN rsvps\b/i);
  assert.doesNotMatch(service, /ILIKE|similarity\s*\(/i);
  const identityLock = service.indexOf('const ownership = await readExactContactOwnership');
  const organizerLock = service.indexOf('lockedOrganizer = await lockSingleOrganizer');
  const userLock = service.indexOf('user = await lockActiveUser');
  assert.ok(identityLock >= 0 && organizerLock > identityLock && userLock > organizerLock,
    'provisioning keeps the shared identity -> organizer -> user lock order');
});

test('new provisioning creates an aligned shell and unverified contacts only', () => {
  const service = read('src/lib/admin-done-for-you.js');
  assert.match(service, /INSERT INTO users \(name\)/);
  assert.match(service, /INSERT INTO organizers[\s\S]*\(id,user_id,email,name,org_name,public_slug,last_login_at\)[\s\S]*VALUES \(\$1,\$1,[\s\S]*,NULL\)/);
  assert.match(service, /verificationScope: verified \? VERIFICATION_SCOPES\.ACCOUNT : VERIFICATION_SCOPES\.UNVERIFIED/);
  assert.match(service, /verifiedAt: verified \? verifiedAt : null/);
  assert.match(service, /isPrimary: false/);
  assert.doesNotMatch(service, /INSERT INTO (?:account_phone_credentials|magic_link_tokens|phone_auth_challenges|guest_sessions)/i);
  assert.doesNotMatch(service, /setSessionCookie|setAdminSessionCookie|last_login_at\s*=\s*NOW/i);
});

test('existing Host Page values are reused and only empty host fields are completed', () => {
  const service = read('src/lib/admin-done-for-you.js');
  assert.match(service, /WHERE user_id=\$1 OR id=\$1[\s\S]*FOR UPDATE/);
  assert.match(service, /if \(!needsContactName && !needsHostName && !needsSlug\)[\s\S]*updated: false/);
  assert.match(service, /name=CASE WHEN NULLIF\(BTRIM\(name\),''\) IS NULL THEN \$2 ELSE name END/);
  assert.match(service, /org_name=CASE WHEN NULLIF\(BTRIM\(org_name\),''\) IS NULL THEN \$3 ELSE org_name END/);
  assert.match(service, /public_slug=COALESCE\(public_slug,\$4\)/);
  assert.match(service, /if \(!cleanText\(user\.name[\s\S]*UPDATE users SET name=\$2/);
  assert.doesNotMatch(service, /SET\s+(?:email|logo_url|header_image_url|bio|website_url)=/i);
});

test('marker creation is idempotent and audit metadata stays PII-minimal', () => {
  const service = read('src/lib/admin-done-for-you.js');
  assert.match(service, /WHERE target_user_id=\$1\s+FOR UPDATE/);
  assert.match(service, /ON CONFLICT \(target_user_id\) DO NOTHING/);
  assert.match(service, /const mutated = Object\.values\(mutations\)\.some\(Boolean\)/);
  assert.match(service, /if \(mutated\) \{\s*await writeProvisioningAudit/);
  assert.match(service, /done_for_you_client_updated/);
  assert.match(service, /UPDATE admin_done_for_you_clients[\s\S]*SET updated_at=NOW\(\)/);
  assert.match(service, /noOp: !mutated/);
  assert.match(service, /actor_user_id,actor_admin_operator_id,target_user_id/);
  assert.match(service, /VALUES \(NULL,\$1,\$2,\$3,/);
  assert.match(service, /contactTypes: \[email \? 'email' : null, phone \? 'phone' : null\]\.filter\(Boolean\)/);
  assert.doesNotMatch(service, /metadata:[\s\S]{0,500}(?:contactName|hostName|publicSlug)/);
  assert.equal(maskEmail('client@example.com'), 'c•••@example.com');
  assert.equal(maskPhone('+14155552671'), '••••2671');
});

test('split email and phone owners stop provisioning instead of merging accounts', () => {
  assert.equal(resolvedOwner({ user_id: 12 }, null), 12);
  assert.equal(resolvedOwner(null, { user_id: 12 }), 12);
  assert.equal(resolvedOwner({ user_id: 12 }, { user_id: 12 }), 12);
  assert.equal(resolvedOwner(null, null), null);
  assert.throws(
    () => resolvedOwner({ user_id: 12 }, { user_id: 44 }),
    error => error instanceof DoneForYouProvisioningError
      && error.code === 'split_identity_owners'
      && error.status === 409
  );
});

test('claim state requires recipient-owned account proof or an earlier login', () => {
  assert.deepEqual(claimedStateFromRow(null), { claimed: false, claimedAt: null });
  assert.deepEqual(
    claimedStateFromRow({ last_login_at: null, verified_identity_at: null }),
    { claimed: false, claimedAt: null }
  );
  assert.deepEqual(
    claimedStateFromRow({
      last_login_at: '2026-01-01T00:00:00.000Z',
      verified_identity_at: '2026-02-01T00:00:00.000Z'
    }),
    { claimed: true, claimedAt: '2026-02-01T00:00:00.000Z' }
  );
});

test('provisioning input is normalized once and rejects incomplete client data', () => {
  const input = normalizeProvisioningInput({
    hostName: '  Night   Market ',
    contactName: '  Ada   Rivera ',
    email: ' ADA@Example.COM ',
    phone: '+1 (415) 555-2671'
  });
  assert.equal(input.hostName, 'Night Market');
  assert.equal(input.contactName, 'Ada Rivera');
  assert.equal(input.email.normalizedValue, 'ada@example.com');
  assert.equal(input.phone.normalizedValue, '+14155552671');
  assert.throws(
    () => normalizeProvisioningInput({ hostName: '', contactName: 'Ada', email: 'ada@example.com' }),
    error => error.code === 'invalid_host_name'
  );
});
