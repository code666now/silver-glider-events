const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const readMigrations = () => fs.readdirSync(path.join(root, 'src/db/migrations'))
  .filter(file => file.endsWith('.sql'))
  .sort()
  .map(file => read(`src/db/migrations/${file}`))
  .join('\n');

test('account support schema keeps status canonical and history append-only', () => {
  const migration = read('src/db/migrations/047_admin_accounts_support.sql');

  assert.match(migration, /ALTER TABLE users[\s\S]*account_status TEXT NOT NULL DEFAULT 'active'/);
  assert.match(migration, /CHECK \(account_status IN \('active', 'suspended'\)\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS admin_account_audit_log/);
  assert.match(migration, /actor_user_id\s+INTEGER NOT NULL REFERENCES users\(id\)/);
  assert.match(migration, /target_user_id\s+INTEGER REFERENCES users\(id\)/);
  assert.match(migration, /before_state\s+JSONB NOT NULL/);
  assert.match(migration, /after_state\s+JSONB NOT NULL/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS admin_account_support_notes/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS admin_account_invitations/);
  assert.match(migration, /sent_at\s+TIMESTAMPTZ/);
  assert.match(migration, /SET sent_at=COALESCE\(sent_at,claimed_at,created_at\)/);
  assert.match(migration, /Invitations provision nothing up front/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON admin_account_audit_log/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON admin_account_support_notes/);
  assert.match(migration, /'claim_account'/);
});

test('account support APIs are admin-only, audited, and expose masked identity data', () => {
  const route = read('src/routes/admin-accounts.js');

  assert.match(route, /router\.use\('\/api\/admin\/accounts', requireAdmin\)/);
  assert.match(route, /sameOriginMutation/);
  assert.match(route, /router\.get\('\/api\/admin\/accounts'/);
  assert.match(route, /router\.get\('\/api\/admin\/accounts\/:id'/);
  assert.match(route, /identity_type='email'/);
  assert.match(route, /identity_type='phone'/);
  assert.match(route, /maskEmail\(/);
  assert.match(route, /maskPhone\(/);
  assert.match(route, /maskedValue:/);
  assert.doesNotMatch(route, /\n\s*value:\s*identity\.value/,
    'detail responses must not return raw identity values');
  assert.match(route, /email:\s*maskEmail\(row\.verified_email \|\| row\.email\)/);
  assert.match(route, /phone:\s*row\.verified_phone \? maskPhone\(row\.verified_phone\) : null/);

  for (const action of ['profile_name_updated', 'sessions_revoked', 'account_suspended',
    'account_reactivated', 'support_note_added', 'account_invitation_created',
    'account_invitation_sent', 'account_invitation_delivery_failed']) {
    assert.match(route, new RegExp(`actionType: '${action}'`));
  }
  assert.match(route, /if \(userId === actorUserId\)[\s\S]*cannot suspend your own account/);
  assert.match(route, /pg_advisory_xact_lock/);
  assert.match(route, /last active administrator cannot be suspended/);
  assert.match(route, /sessions_valid_after/);
  assert.match(route, /UPDATE magic_link_tokens[\s\S]*used_at/);
  assert.match(route, /UPDATE phone_auth_challenges[\s\S]*used_at/);
  assert.match(route, /UPDATE guest_sessions[\s\S]*revoked_at/);
});

test('setup invitations require recipient proof and never pre-create a verified account', () => {
  const route = read('src/routes/admin-accounts.js');
  const challenge = read('src/lib/sign-in-challenges.js');
  const mailer = read('src/lib/mailer.js');

  assert.match(route, /intent: 'claim_account'/);
  assert.match(route, /withCode: false/);
  assert.match(route, /account_already_exists/);
  assert.match(route, /active invitation was already sent/);
  assert.match(route, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
  assert.match(route, /account_invitation_stale_revoked/);
  assert.match(route, /sent_at=COALESCE\(sent_at,NOW\(\)\)/);
  assert.doesNotMatch(route, /INSERT INTO users/);
  assert.doesNotMatch(route, /INSERT INTO user_identities/);
  assert.match(challenge, /RETURNING id/);
  assert.match(mailer, /sendAccountClaimInvitation/);
  assert.match(mailer, /NODE_ENV === 'production'[\s\S]*delivery is unavailable/);
  assert.match(mailer, /link expires in 7 days and works once/i);
});

test('Accounts & Support UI is mobile-safe and offers only explicit support actions', () => {
  const html = read('src/views/admin-accounts.html');
  const script = read('public/js/admin-accounts.js');
  const css = read('public/css/admin-accounts.css');

  assert.match(html, /Accounts &amp; Support/);
  assert.match(html, /Search by name, user ID, email, or phone/);
  assert.match(html, /id="open-invitation"/);
  assert.match(html, /id="account-sign-out-all"/);
  assert.match(html, /id="account-status-action"/);
  assert.match(html, /id="support-action-reason"[^>]*required/);
  assert.match(html, /id="account-note-form"/);
  assert.match(html, /id="account-audit"/);
  assert.match(html, /These actions never reveal credentials or sign you in as the user/);

  assert.match(script, /\/api\/admin\/accounts/);
  assert.match(script, /maskEmail/);
  assert.match(script, /maskPhone/);
  assert.match(script, /reason\.length < 8/);
  assert.match(script, /endpoint: 'sign-out-all'/);
  assert.match(script, /endpoint: 'suspend'/);
  assert.match(script, /endpoint: 'reactivate'/);
  assert.doesNotMatch(html, /id="(?:impersonate|edit-credential)/i);
  assert.doesNotMatch(script, /\/api\/admin\/accounts\/[^`'"\n]+\/(?:impersonate|identit)/i);

  assert.match(css, /@media \(max-width:879px\)[\s\S]*height:100dvh/);
  assert.match(css, /\.accounts-icon-button \{[^}]*width:44px;height:44px/);
  assert.match(css, /\.accounts-support-actions \.sg-btn \{[^}]*min-height:44px/);
  assert.match(css, /@media \(max-width:560px\)[\s\S]*\.accounts-dialog-actions \.sg-btn \{[^}]*min-height:52px/);
});

test('test-account deletion is an explicit guarded command that leaves a canonical tombstone', () => {
  const migrations = readMigrations();
  const safetyMigration = read('src/db/migrations/049_test_account_deletion_safety.sql');
  const route = read('src/routes/admin-accounts.js');
  const worker = read('src/jobs/managed-media-deletions.js');
  const cloudinary = read('src/lib/cloudinary.js');
  const index = read('src/index.js');

  assert.match(migrations, /account_status[\s\S]*'deleted'/);
  assert.match(migrations, /deleted_at\s+TIMESTAMPTZ/);
  assert.match(migrations, /deleted_by_user_id\s+INTEGER/);
  assert.match(migrations, /deletion_reason\s+TEXT/);

  assert.match(route, /router\.post\('\/api\/admin\/accounts\/:id\/delete-test-account'/);
  assert.match(route, /router\.post\('\/api\/admin\/accounts\/:id\/mark-test-account'/);
  assert.doesNotMatch(route, /router\.delete\('\/api\/admin\/accounts\/:id'/,
    'the generic account DELETE surface must remain absent');
  assert.match(route, /hasIdentityStepUp\(req,\s*actorUserId\)/);
  assert.match(route, /identity_step_up_required/);
  assert.match(route, /testAccountConfirmed\s*=\s*req\.body\?\.testAccountConfirmed\s*===\s*true/);
  assert.match(route, /if \(!testAccountConfirmed\)/);
  assert.match(route, /DELETE USER/);
  assert.match(route, /MARK TEST USER/);
  assert.match(route, /reason\.length\s*<\s*8/);
  assert.match(route, /userId\s*===\s*actorUserId/);
  assert.match(route, /is_admin/);
  assert.match(route, /account\.is_test_account/);
  assert.match(route, /actionType:\s*'test_account_designated'/);

  for (const blocker of [
    'non_free_plan',
    'sms_credit_balance',
    'sms_financial_history',
    'sms_delivery_history',
    'commerce_events',
    'active_followers',
    'unresolved_identity_conflicts',
    'support_notes',
    'external_contributed_photos',
    'historical_identities',
    'external_optout_history',
    'external_event_relationships',
    'external_delivery_history',
    'not_designated_test_account'
  ]) {
    assert.match(route, new RegExp(`['"]${blocker}['"]`));
  }
  assert.match(route, /account_not_deletable/);
  assert.match(route, /actionType:\s*'test_account_deleted'/);
  assert.match(route, /account_status='deleted'/);
  assert.match(route, /name=NULL/);
  assert.match(route, /DELETE FROM organizers/);
  assert.match(route, /DELETE FROM user_identities/);
  assert.match(route, /DELETE FROM magic_link_tokens/);
  assert.match(route, /INSERT INTO managed_media_deletion_jobs/);
  assert.match(route, /await client\.query\('COMMIT'\)[\s\S]*queueManagedMediaDeletionJobs\(mediaJobIds\)/);

  assert.match(safetyMigration, /is_test_account BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(safetyMigration, /test_account_marked_at TIMESTAMPTZ/);
  assert.match(safetyMigration, /test_account_marked_by_user_id INTEGER REFERENCES users\(id\)/);
  assert.match(safetyMigration, /CHAR_LENGTH\(BTRIM\(test_account_mark_reason\)\) BETWEEN 8 AND 500/);
  assert.match(safetyMigration, /CREATE TABLE IF NOT EXISTS managed_media_deletion_jobs/);
  assert.match(safetyMigration, /status\s+TEXT NOT NULL DEFAULT 'pending'/);
  assert.match(safetyMigration, /UNIQUE \(source_kind, source_user_id, public_id\)/);
  assert.match(safetyMigration, /managed_media_deletion_jobs_pending_idx/);

  assert.match(worker, /publicIdStillReferenced/);
  assert.match(worker, /status='processing',attempt_count=attempt_count\+1/);
  assert.match(worker, /status='pending',next_attempt_at=NOW\(\) \+ INTERVAL '10 minutes'/);
  assert.match(worker, /LIMIT 25/);
  assert.match(worker, /cron\.schedule\('\* \* \* \* \*'/);
  assert.match(index, /managed-media-deletions'\)\.startManagedMediaDeletionCron\(\)/);

  assert.match(cloudinary, /url\.hostname !== 'res\.cloudinary\.com'/);
  assert.match(cloudinary, /decodeURIComponent\(segments\[0\] \|\| ''\) !== cloudName/);
  assert.match(cloudinary, /segments\[1\] !== 'image'/);
  assert.match(cloudinary, /publicId\.includes\('\.\.'\)/);
  assert.match(cloudinary, /\[\\\\\?#\]\/\.test\(publicId\)/);
  assert.match(cloudinary, /publicId\.startsWith\(`\$\{folder\}\//);
});

test('test-account deletion uses a dedicated accessible mobile danger flow', () => {
  const html = read('src/views/admin-accounts.html');
  const script = read('public/js/admin-accounts.js');
  const css = read('public/css/admin-accounts.css');

  assert.match(html, /id="account-delete-zone"/);
  assert.match(html, /Danger zone/);
  assert.match(html, /id="delete-test-account"[^>]*>Delete test account permanently</);
  assert.match(html, /id="delete-account-dialog"[^>]*aria-labelledby="delete-account-title"[^>]*aria-describedby="delete-account-description"/);
  assert.match(html, /id="delete-account-reason"[^>]*minlength="8"[^>]*required/);
  assert.match(html, /id="delete-account-confirmation"[^>]*required/);
  assert.match(html, /id="delete-account-test-confirmed"[^>]*type="checkbox"[^>]*required/);
  assert.match(html, /id="confirm-delete-test-account"[^>]*>Delete permanently</);
  assert.doesNotMatch(script, /window\.confirm\s*\(/);
  assert.match(script, /DELETE USER \$\{state\.selectedId\}/);
  assert.match(script, /MARK TEST USER \$\{state\.selectedId\}/);
  assert.match(script, /deletionCanMark/);
  assert.match(script, /state\.deleteMode\s*=\s*mode/);
  assert.match(script, /mode === 'delete' \? 'delete-test-account' : 'mark-test-account'/);
  assert.match(script, /Nothing is deleted in this step/);
  assert.match(script, /confirmButton\.setAttribute\('aria-label',[\s\S]*Mark account as test data/);
  assert.match(script, /Verify and mark account as test data/);
  assert.match(script, /testAccountConfirmed:\s*true/);
  assert.match(script, /delete-test-account/);
  assert.match(script, /identity_step_up_required/);
  assert.match(script, /\/api\/me\/identities\/step-up\/start/);
  assert.match(script, /\/api\/auth\/verify-code/);
  assert.match(script, /state\.selectedId\s*=\s*null/);
  assert.match(script, /search\.focus\(/);
  assert.match(css, /@media \(max-width:560px\)[\s\S]*#confirm-delete-test-account[\s\S]*min-height:52px/);
  assert.match(css, /@media \(max-width:560px\)[\s\S]*delete-account[\s\S]*safe-area-inset-bottom/);
});
