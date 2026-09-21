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

test('dedicated admin operators are independent principals with isolated passcodes and sessions', () => {
  const migration = read('src/db/migrations/051_admin_operator_auth.sql');
  const invalidationMigration = read('src/db/migrations/052_admin_operator_credential_invalidation.sql');
  const migrations = fs.readdirSync(path.join(root, 'src/db/migrations')).filter(file => file.endsWith('.sql')).sort();
  const session = read('src/lib/admin-session.js');
  const middleware = read('src/middleware/requireAdmin.js');
  const auth = read('src/routes/admin-auth.js');
  const adminRoutes = read('src/routes/admin.js');
  const commerceRoutes = read('src/routes/commerce.js');
  const feedbackRoutes = read('src/routes/feedback.js');
  const index = read('src/index.js');
  const login = read('src/views/admin-login.html');
  const operatorTable = migration.slice(
    migration.indexOf('CREATE TABLE IF NOT EXISTS admin_operators'),
    migration.indexOf('CREATE INDEX IF NOT EXISTS admin_operators_status_idx')
  );

  assert.ok(migrations.indexOf('051_admin_operator_auth.sql') > migrations.indexOf('050_direct_admin_account_deletion.sql'));
  assert.ok(migrations.indexOf('052_admin_operator_credential_invalidation.sql') > migrations.indexOf('051_admin_operator_auth.sql'));
  assert.match(operatorTable, /email\s+TEXT NOT NULL UNIQUE/);
  assert.match(operatorTable, /role IN \('super_admin','support'\)/);
  assert.match(operatorTable, /status IN \('active','disabled'\)/);
  assert.doesNotMatch(operatorTable, /REFERENCES (?:users|organizers)/);
  assert.match(migration, /SELECT DISTINCT LOWER\(BTRIM\(organizer\.email\)\),'super_admin','active'/);
  assert.match(migration, /organizer\.is_admin=TRUE/);
  assert.match(migration, /canonical_user\.account_status='active'/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS admin_auth_challenges/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS admin_action_proofs/);
  assert.match(migration, /actor_admin_operator_id/);
  assert.match(invalidationMigration, /BEFORE UPDATE OF status ON admin_operators/);
  assert.match(invalidationMigration, /sessions_valid_after := GREATEST/);
  assert.match(invalidationMigration, /UPDATE admin_auth_challenges[\s\S]*used_at=invalidated_at/);
  assert.match(invalidationMigration, /UPDATE admin_action_proofs[\s\S]*consumed_at=invalidated_at/);

  assert.match(session, /COOKIE_NAME = 'sge_admin_session'/);
  assert.match(session, /HttpOnly; SameSite=Strict/);
  assert.match(session, /NODE_ENV === 'production' \? '; Secure'/);
  assert.match(session, /status='active'/);
  assert.match(session, /sessions_valid_after/);
  assert.match(middleware, /req\.adminOperator = dedicated\.operator/);
  assert.match(middleware, /req\.adminActor = \{/);
  assert.match(middleware, /LEGACY_ADMIN_AUTH_ENABLED \|\| 'false'/);
  assert.match(middleware, /function requireSuperAdmin/);
  assert.match(middleware, /error: 'super_admin_required'/);
  assert.match(middleware, /function sameOriginMutation/);
  assert.match(middleware, /continueAuthenticated\(req, res, next\)/);
  assert.match(middleware, /res\.redirect\(`\/admin\/login/);

  assert.match(auth, /router\.post\('\/api\/admin\/auth\/start'/);
  assert.match(auth, /router\.post\('\/api\/admin\/auth\/verify'/);
  assert.match(auth, /router\.get\('\/api\/admin\/auth\/me'/);
  assert.match(auth, /router\.post\('\/api\/admin\/auth\/logout'/);
  assert.match(auth, /SELECT id,email FROM admin_operators[\s\S]*status='active'/);
  assert.doesNotMatch(auth, /INSERT INTO admin_operators/);
  assert.match(auth, /Always set a same-shaped browser token/);
  assert.match(auth, /ACTION_PROOF_COOKIE = 'sge_admin_action'/);
  assert.match(auth, /runInBackground\(async \(\) =>/);
  assert.match(auth, /router\.post\('\/api\/admin\/auth\/logout'[\s\S]*sameOriginMutation/);
  assert.match(auth, /UPDATE admin_action_proofs[\s\S]*operator_id=\$2[\s\S]*action=\$3[\s\S]*target_user_id=\$4[\s\S]*consumed_at IS NULL/);
  assert.match(adminRoutes, /events\/:id\/collect-photos', requireSuperAdmin/);
  assert.match(adminRoutes, /admin\/sms\/test', requireSuperAdmin/);
  assert.match(commerceRoutes, /commerce-interest\/send', requireAdmin, requireSuperAdmin/);
  assert.match(feedbackRoutes, /delete\('\/api\/admin\/feedback\/:id', requireAdmin, requireSuperAdmin/);
  assert.match(index, /app\.use\(require\('\.\/routes\/admin-auth'\)\)/);
  assert.match(index, /app\.get\('\/admin\/login'/);
  assert.match(login, /Operator sign in/);
  assert.match(login, /autocomplete="one-time-code"/);
});

test('account support APIs are admin-only, audited, and label complete identity data accurately', () => {
  const route = read('src/routes/admin-accounts.js');
  const middleware = read('src/middleware/requireAdmin.js');

  assert.match(route, /router\.use\('\/api\/admin\/accounts', requireAdmin\)/);
  assert.doesNotMatch(route, /function sameOriginMutation/);
  assert.match(middleware, /\['POST', 'PUT', 'PATCH', 'DELETE'\][\s\S]*sameOriginMutation/);
  assert.match(route, /router\.get\('\/api\/admin\/accounts'/);
  assert.match(route, /router\.get\('\/api\/admin\/accounts\/:id'/);
  assert.match(route, /identity_type='email'/);
  assert.match(route, /identity_type='phone'/);
  assert.match(route, /value:\s*identity\.value/);
  assert.doesNotMatch(route, /maskedValue:/);
  assert.doesNotMatch(route, /function maskPhone/);
  assert.match(route, /Verified sign-in email/);
  assert.match(route, /Verified sign-in phone/);
  assert.match(route, /Contact email \(not verified for sign-in\)/);
  assert.match(route, /RSVP email \(not verified for sign-in\)/);
  assert.match(route, /No email on file/);
  assert.match(route, /No phone on file/);
  assert.match(route, /contactMethods/);
  assert.match(route, /contactSummary/);
  assert.doesNotMatch(route, /router\.(?:post|put|patch)\([^\n]*identit/i,
    'administrator account APIs must not mark contact data verified');

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
  assert.match(html, /Verified sign-in methods and contact-only details are labeled separately/);

  assert.match(script, /\/api\/admin\/accounts/);
  assert.match(script, /contactMethods/);
  assert.match(script, /contactSummary/);
  assert.match(script, /Verified sign-in \$\{type\}/);
  assert.match(script, /Contact\/RSVP \$\{type\} \(not verified for sign-in\)/);
  assert.match(script, /No \$\{type\} on file/);
  assert.doesNotMatch(script, /function\s+mask(?:Email|Phone)/);
  assert.doesNotMatch(script, /No email[^\n]{0,120}Verified/);
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

test('direct Super Admin deletion keeps a tombstone without the test-account blocker maze', () => {
  const migrations = readMigrations();
  const safetyMigration = read('src/db/migrations/049_test_account_deletion_safety.sql');
  const reconciliation = read('src/db/migrations/050_direct_admin_account_deletion.sql');
  const route = read('src/routes/admin-accounts.js');
  const worker = read('src/jobs/managed-media-deletions.js');
  const cloudinary = read('src/lib/cloudinary.js');
  const index = read('src/index.js');

  assert.match(migrations, /account_status[\s\S]*'deleted'/);
  assert.match(migrations, /deleted_at\s+TIMESTAMPTZ/);
  assert.match(migrations, /deleted_by_user_id\s+INTEGER/);
  assert.match(migrations, /deletion_reason\s+TEXT/);

  assert.match(route, /router\.post\('\/api\/admin\/accounts\/:id\/delete-account'/);
  assert.doesNotMatch(route, /delete-test-account|mark-test-account/);
  assert.doesNotMatch(route, /router\.delete\('\/api\/admin\/accounts\/:id'/,
    'the generic account DELETE surface must remain absent');
  assert.match(route, /isDedicatedSuperAdmin\(req\)/);
  assert.match(route, /consumeAdminActionProof\(client, req/);
  assert.match(route, /operatorId:\s*actorAdminOperatorId[\s\S]*action:\s*'account_delete'[\s\S]*targetUserId:\s*userId/);
  assert.match(route, /admin_step_up_required/);
  assert.doesNotMatch(route, /hasIdentityStepUp|identity_step_up_required/);
  assert.match(route, /DELETE USER/);
  assert.match(route, /reason\.length\s*<\s*8/);
  assert.match(route, /Number\(userId\) === Number\(actorUserId\)/);
  assert.match(route, /account\.is_admin/);
  assert.match(route, /'self_account'/);
  assert.match(route, /'administrator_account'/);
  assert.doesNotMatch(route, /not_designated_test_account|non_free_plan|sms_financial_history|historical_identities/);
  for (const warning of ['owned_events', 'owned_event_rsvps', 'owned_event_guest_sessions',
    'owned_event_invitations', 'owned_event_comments', 'owned_event_messages',
    'owned_event_photos', 'owned_event_recipients', 'linked_rsvps', 'sms_credit_balance',
    'financial_history_retained', 'support_history_retained']) {
    assert.match(route, new RegExp(`['"]${warning}['"]`));
  }
  assert.match(route, /account_not_deletable/);
  assert.match(route, /actionType:\s*'account_deleted'/);
  assert.match(route, /account_status='deleted'/);
  assert.match(route, /name=NULL/);
  assert.match(route, /UPDATE organizers/);
  assert.doesNotMatch(route, /DELETE FROM organizers/);
  assert.match(route, /DELETE FROM user_identities/);
  assert.match(route, /DELETE FROM account_phone_credentials/);
  assert.match(route, /DELETE FROM magic_link_tokens/);
  assert.match(route, /account-deletion:\$\{userId\}:sms-credit-forfeiture/);
  assert.match(route, /ON CONFLICT \(external_key\) DO NOTHING/);
  assert.doesNotMatch(route, /WHERE organizer_id<>\$2 AND LOWER\(BTRIM\(email\)\)/);
  assert.doesNotMatch(route, /DELETE FROM rsvps[\s\S]{0,220}LOWER\(BTRIM\(email\)\)/);
  assert.doesNotMatch(route, /recipient\.recipient=ANY/);
  assert.match(route, /INSERT INTO managed_media_deletion_jobs/);
  assert.match(route, /'account_deletion'/);
  assert.match(route, /await client\.query\('COMMIT'\)[\s\S]*queueManagedMediaDeletionJobs\(mediaJobIds\)/);

  assert.match(safetyMigration, /is_test_account BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(safetyMigration, /test_account_marked_at TIMESTAMPTZ/);
  assert.match(safetyMigration, /test_account_marked_by_user_id INTEGER REFERENCES users\(id\)/);
  assert.match(safetyMigration, /CHAR_LENGTH\(BTRIM\(test_account_mark_reason\)\) BETWEEN 8 AND 500/);
  assert.match(safetyMigration, /CREATE TABLE IF NOT EXISTS managed_media_deletion_jobs/);
  assert.match(safetyMigration, /status\s+TEXT NOT NULL DEFAULT 'pending'/);
  assert.match(safetyMigration, /UNIQUE \(source_kind, source_user_id, public_id\)/);
  assert.match(safetyMigration, /managed_media_deletion_jobs_pending_idx/);
  assert.doesNotMatch(reconciliation, /DROP COLUMN IF EXISTS is_test_account/);
  assert.doesNotMatch(reconciliation, /SET source_kind='account_deletion'/);
  assert.match(reconciliation,
    /CHECK \(source_kind IN \('test_account_deletion','account_deletion'\)\)/);

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

test('account deletion uses one accessible mobile danger flow with fresh email proof', () => {
  const html = read('src/views/admin-accounts.html');
  const script = read('public/js/admin-accounts.js');
  const css = read('public/css/admin-accounts.css');

  assert.match(html, /id="account-delete-zone"/);
  assert.match(html, /Danger zone/);
  assert.match(html, /id="delete-account-action"[^>]*>Delete account</);
  assert.match(html, /id="delete-account-dialog"[^>]*aria-labelledby="delete-account-title"[^>]*aria-describedby="delete-account-description"/);
  assert.match(html, /This cannot be undone/);
  assert.match(html, /id="account-delete-summary"/);
  assert.match(html, /id="account-delete-warnings"/);
  assert.match(html, /id="delete-account-reason"[^>]*minlength="8"[^>]*required/);
  assert.match(html, /id="delete-account-confirmation"[^>]*required/);
  assert.match(html, /id="submit-delete-account"[^>]*>Continue to email confirmation</);
  assert.doesNotMatch(html, /delete-account-test-confirmed/);
  assert.doesNotMatch(html, /test[- ]account/i);
  assert.doesNotMatch(script, /window\.confirm\s*\(/);
  assert.match(script, /DELETE USER \$\{state\.selectedId\}/);
  assert.match(script, /\/delete-account`/);
  assert.doesNotMatch(script, /delete-test-account|mark-test-account|testAccountConfirmed|deletionCanMark|deleteMode/);
  assert.match(script, /admin_step_up_required/);
  assert.match(script, /\/api\/admin\/auth\/step-up\/start/);
  assert.match(script, /\/api\/admin\/auth\/step-up\/complete/);
  assert.match(script, /Continue to email confirmation/);
  assert.match(script, /Verify and delete/);
  assert.match(script, /was permanently deleted/);
  assert.match(script, /state\.selectedId\s*=\s*null/);
  assert.match(script, /search\.focus\(/);
  assert.match(css, /@media \(max-width:560px\)[\s\S]*#submit-delete-account[\s\S]*min-height:52px/);
  assert.match(css, /@media \(max-width:560px\)[\s\S]*delete-account[\s\S]*safe-area-inset-bottom/);
});
