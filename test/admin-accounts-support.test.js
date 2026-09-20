const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

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
  assert.doesNotMatch(html, /id="(?:delete|impersonate|edit-credential)/i);
  assert.doesNotMatch(script, /\/api\/admin\/accounts\/[^`'"\n]+\/(?:delete|impersonate|identit)/i);

  assert.match(css, /@media \(max-width:879px\)[\s\S]*height:100dvh/);
  assert.match(css, /\.accounts-icon-button \{[^}]*width:44px;height:44px/);
  assert.match(css, /\.accounts-support-actions \.sg-btn \{[^}]*min-height:44px/);
  assert.match(css, /@media \(max-width:560px\)[\s\S]*\.accounts-dialog-actions \.sg-btn \{[^}]*min-height:52px/);
});
