const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const {
  COOKIE_NAME,
  MAX_AGE_SECONDS,
  clearAdminEditorCookie,
  setAdminEditorCookie,
  tokenHash
} = require('../src/lib/admin-editor-workspace');

test('admin editor migration creates a constrained, immutable scoped grant', () => {
  const migration = read('src/db/migrations/056_admin_event_editor_workspaces.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS admin_event_editor_workspaces/);
  assert.match(migration, /done_for_you_client_id[\s\S]*REFERENCES admin_done_for_you_clients\(id\)/);
  assert.match(migration, /actor_admin_operator_id[\s\S]*REFERENCES admin_operators\(id\)/);
  assert.match(migration, /target_user_id\s+INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(migration, /organizer_id\s+INTEGER NOT NULL REFERENCES organizers\(id\) ON DELETE CASCADE/);
  assert.match(migration, /event_id[\s\S]*REFERENCES events\(id\)/);
  assert.match(migration, /status IN \('active','completed','exited','revoked','expired'\)/);
  assert.match(migration, /admin_event_editor_workspaces_actor_active_uq[\s\S]*WHERE status='active'/);
  assert.match(migration, /admin_event_editor_workspaces_event_active_uq[\s\S]*event_id IS NOT NULL/);
  assert.match(migration, /admin event editor workspace scope is immutable/);
  assert.match(migration, /OLD\.target_user_id IS DISTINCT FROM NEW\.target_user_id/);
  assert.match(migration, /OLD\.organizer_id IS DISTINCT FROM NEW\.organizer_id/);
  assert.match(migration, /admin_operator_access_change_revokes_editor_workspaces/);
  assert.match(migration, /AFTER UPDATE OF status,role,sessions_valid_after ON admin_operators/);
  assert.doesNotMatch(migration, /\b(?:email|phone|contact_name|host_name)\b/i);
});

test('admin editor cookie is opaque, short lived, strict, and path scoped', () => {
  assert.equal(COOKIE_NAME, 'sge_admin_editor');
  assert.equal(MAX_AGE_SECONDS, 7200);
  assert.equal(tokenHash('opaque-value').length, 64);
  assert.notEqual(tokenHash('opaque-value'), 'opaque-value');

  const headers = [];
  const res = { append(name, value) { headers.push([name, value]); } };
  setAdminEditorCookie(res, 'opaque-value');
  clearAdminEditorCookie(res);
  assert.match(headers[0][1], /^sge_admin_editor=opaque-value;/);
  assert.match(headers[0][1], /Path=\/admin-editor/);
  assert.match(headers[0][1], /HttpOnly/);
  assert.match(headers[0][1], /SameSite=Strict/);
  assert.match(headers[0][1], /Max-Age=7200/);
  assert.match(headers[1][1], /sge_admin_editor=;/);
  assert.match(headers[1][1], /Max-Age=0/);
});

test('admin editor scope never creates or borrows a customer session', () => {
  const service = read('src/lib/admin-editor-workspace.js');
  const middleware = read('src/middleware/requireAdminEditorWorkspace.js');
  const route = read('src/routes/admin-editor.js');
  const startRoute = read('src/routes/admin-done-for-you.js');
  const combined = `${service}\n${middleware}\n${route}\n${startRoute}`;

  assert.match(route, /requireAdmin, requireDedicatedAdmin, requireAdminEditorWorkspace/);
  assert.match(middleware, /req\.adminEditorWorkspace = safeWorkspace\(row\)/);
  assert.match(middleware, /actor_admin_operator_id/);
  assert.match(middleware, /target_account_status !== 'active'/);
  assert.match(middleware, /current_target_user_id/);
  assert.match(middleware, /event_status === 'draft'/);
  assert.doesNotMatch(combined, /setSessionCookie|signSession|sge_session|req\.organizer\s*=/);
});

test('admin editor document failures recover to Done For You while API failures stay JSON', () => {
  const middleware = read('src/middleware/requireAdminEditorWorkspace.js');

  assert.match(middleware, /EDITOR_RECOVERY_PATH = '\/admin\/done-for-you\?editor=expired'/);
  assert.match(
    middleware,
    /method !== 'GET' && method !== 'HEAD'[\s\S]*!requestPath\.startsWith\('\/admin-editor\/api\/'\)/
  );
  assert.match(
    middleware,
    /if \(isAdminEditorDocumentRequest\(req\)\) \{[\s\S]*res\.redirect\(302, EDITOR_RECOVERY_PATH\)/
  );
  assert.match(middleware, /return res\.status\(status\)\.json\(\{ error, message \}\)/);
});

test('workspace start and exit are scoped, audited, and clear on admin logout', () => {
  const service = read('src/lib/admin-editor-workspace.js');
  const editorRoute = read('src/routes/admin-editor.js');
  const doneForYouRoute = read('src/routes/admin-done-for-you.js');
  const authRoute = read('src/routes/admin-auth.js');
  const adminMiddleware = read('src/middleware/requireAdmin.js');
  const operators = read('src/lib/admin-operators.js');
  const index = read('src/index.js');

  assert.match(doneForYouRoute, /post\('\/api\/admin\/done-for-you\/:id\/editor-workspaces'/);
  assert.match(doneForYouRoute, /\/admin-editor\/events\/new\?id=\$\{eventId\}&advanced=1/);
  assert.match(editorRoute, /post\('\/api\/workspace\/exit'/);
  assert.match(service, /done_for_you_event_workspace_opened/);
  assert.match(service, /done_for_you_event_workspace_exited/);
  assert.match(service, /done_for_you_event_workspace_revoked/);
  assert.match(service, /done_for_you_event_workspace_expired/);
  assert.match(service, /done_for_you_event_workspace_completed/);
  assert.match(service, /WHERE id=\$1 AND status='active'[\s\S]*FOR UPDATE/);
  assert.match(adminMiddleware, /req\.adminSession = dedicated\.session/);
  assert.match(doneForYouRoute, /sessionIssuedAt: req\.adminSession\.issuedAt/);
  assert.match(service, /issuedAt < credentialCutoff/);
  assert.match(authRoute, /loadAdminOperator\(pool, req\)[\s\S]*revokeAdminEditorWorkspacesForOperator[\s\S]*sessionIssuedAt: dedicated\.session\.issuedAt/);
  assert.match(authRoute, /clearAdminEditorCookie\(res\)/);
  assert.match(operators, /nextStatus === 'disabled'[\s\S]*\? 'operator_disabled'/);
  assert.match(operators, /cause: 'operator_sessions_revoked'/);
  assert.match(index, /app\.use\('\/admin-editor', require\('\.\/routes\/admin-editor'\)\)/);
});

test('admin login and shared API redirects recognize only the two admin realms', () => {
  const index = read('src/index.js');
  const login = read('src/views/admin-login.html');
  const middleware = read('src/middleware/requireAdmin.js');
  const browserApi = read('public/js/api.js');
  for (const source of [index, login, middleware, browserApi]) {
    assert.match(source, /\/admin-editor/);
  }
  assert.match(index, /!next\.startsWith\('\/'\)[\s\S]*next\.startsWith\('\/\/'\)[\s\S]*next\.includes\('\\\\'\)/);
  assert.match(login, /!relative\.startsWith\('\/'\)[\s\S]*relative\.startsWith\('\/\/'\)[\s\S]*parsed\.origin !== location\.origin/);
  assert.match(browserApi, /normalized === '\/admin-editor'/);
  assert.match(middleware, /path === '\/admin-editor'/);
});

test('credential invalidation locks workspace accounts before the operator and audits each active workspace once', () => {
  const service = read('src/lib/admin-editor-workspace.js');
  const logoutStart = service.indexOf('async function revokeAdminEditorWorkspacesForOperator');
  const start = service.indexOf('async function invalidateAdminOperatorAccessInTransaction');
  const end = service.indexOf('\nmodule.exports', start);
  const logout = service.slice(logoutStart, start);
  const invalidation = service.slice(start, end);
  const operatorLock = invalidation.indexOf('FROM admin_operators');
  const workspaceLock = invalidation.indexOf('FROM admin_event_editor_workspaces workspace');
  const update = invalidation.indexOf("SET status='revoked'");
  const audit = invalidation.indexOf('writeLifecycleAudit');
  const epoch = invalidation.indexOf('sessions_valid_after=GREATEST');
  const challenges = invalidation.indexOf('UPDATE admin_auth_challenges');
  const proofs = invalidation.indexOf('UPDATE admin_action_proofs');
  assert.ok(operatorLock >= 0 && workspaceLock > operatorLock && update > workspaceLock &&
    audit > update && epoch > audit && challenges > epoch && proofs > challenges);
  assert.match(logout, /lockAdminEditorWorkspaceAccountsInTransaction[\s\S]*invalidateAdminOperatorAccessInTransaction/);
  assert.match(invalidation, /WHERE workspace\.actor_admin_operator_id=\$1 AND workspace\.status='active'/);
  assert.match(invalidation, /actorAdminOperatorId/);
});
