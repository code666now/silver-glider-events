const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('shared browser API scopes only root customer API paths inside the admin editor realm', () => {
  const api = read('public/js/api.js');

  assert.match(api, /function sgIsAdminEditorPath\(pathname = location\.pathname\)/);
  assert.match(api, /path\.startsWith\('\/api\/'\)/);
  assert.match(api, /return `\/admin-editor\$\{path\}`/);
  assert.match(api, /fetch\(sgRequestPath\(path\)/);
  assert.match(api, /renderAdminEditorNav\(el\)/);
  assert.match(api, />Exit setup<\/button>/);
  assert.match(api, /api\('\/admin-editor\/api\/workspace\/exit'/);
  assert.match(api, /new CustomEvent\('sg:admin-editor-before-exit', \{ cancelable: true \}\)/);
  assert.doesNotMatch(api, /renderAdminEditorNav[\s\S]{0,1200}\/api\/auth\/logout/);
});

test('expired editor workspaces recover to Done For You without a login or retry loop', () => {
  const api = read('public/js/api.js');
  const editor = read('public/js/event-form.js');

  assert.match(api, /if \(res\.status === 401\) \{\s*if \(sgIsAdminEditorPath\(\)\) \{\s*window\.location\.replace\(sgAdminEditorRecoveryPath\(\)\)/);
  assert.match(api, /\[401, 403, 404, 409\]\.includes\(error\.status\)/);
  assert.match(editor, /function showEditLoadError\(\) \{\s*if \(adminEditorMode\) \{\s*window\.location\.replace\(sgAdminEditorRecoveryPath\(\)\)/);
  assert.doesNotMatch(editor, /adminEditorMode[\s\S]{0,180}\/admin-editor\/events\/new\?id=/);
});

test('quick create stays shared but enters the bound advanced admin editor', () => {
  const script = read('public/js/event-create.js');

  assert.match(script, /const adminEditorMode = sgIsAdminEditorPath\(\)/);
  assert.match(script, /await sgExitAdminEditorWorkspace\(\)/);
  assert.match(script, /if \(adminEditorMode\) \{[\s\S]*\/admin-editor\/events\/new\?id=\$\{encodeURIComponent\(created\.id\)\}&advanced=1/);
  assert.match(script, /else \{[\s\S]*sessionStorage\.setItem\('sge-owner-editor-reopen', created\.slug\)/);
  assert.match(script, /api\('\/api\/places\/config'\)/);
  assert.match(script, /api\('\/api\/events'/);
});

test('admin quick create never restores one client draft into another workspace', () => {
  const script = read('public/js/event-create.js');

  assert.match(script, /function persistQuickCreateDraft\(\) \{\s*if \(adminEditorMode\) return;/);
  assert.match(script, /function restoreQuickCreateDraft\(\) \{\s*if \(adminEditorMode\) \{\s*try \{ window\.sessionStorage\.removeItem\(draftStorageKey\); \}/);
  assert.match(script, /sg:admin-editor-before-exit[\s\S]{0,320}clearQuickCreateDraft\(\)/);
  assert.match(script, /quickCreateDirty && !window\.confirm\('Discard this unfinished event setup\?'\)/);
});

test('advanced event editor uses the isolated API, hides customer-only actions, and publishes after saving', () => {
  const script = read('public/js/event-form.js');
  const html = read('src/views/event-form.html');

  assert.match(script, /const adminEditorMode = sgIsAdminEditorPath\(\)/);
  for (const upload of ['vibe-photo', 'cover', 'flyer']) {
    assert.match(script, new RegExp(`sgRequestPath\\('\\/api\\/uploads\\/${upload}'\\)`));
  }
  assert.match(script, /const showWaitlist = !adminEditorMode/);
  assert.match(script, /if \(adminEditorMode\) return;[\s\S]{0,400}\/api\/commerce\/interest/);
  assert.match(script, /preview\.hidden = adminEditorMode/);
  assert.match(script, /Host identity is managed from the Done For You client record/);
  assert.match(script, /if \(!adminEditorMode && editId && savedEventDetails && savedRsvpCount > 0\)/);
  assert.match(script, /await api\(`\/api\/events\/\$\{editId\}`[\s\S]*await api\(`\/api\/events\/\$\{data\.event\.id\}\/publish`/);
  assert.match(script, /window\.location\.href = published\.redirect \|\| '\/admin\/done-for-you'/);
  assert.match(html, /id="event-mobile-flow-preview"/);
  assert.match(script, /sg:admin-editor-before-exit[\s\S]{0,220}Discard your unsaved changes/);

  // Customer editing remains in the same source and keeps its existing destinations.
  assert.match(script, /window\.location\.href = editId \? `\/events\/\$\{encodeURIComponent\(editId\)\}\/manage` : '\/events'/);
  assert.match(script, /sessionStorage\.setItem\('sge-manage-message'/);
});

test('admin editor omits customer feedback and legal UI and keeps Host context on phone headers', () => {
  const api = read('public/js/api.js');
  const legal = read('public/js/legal-footer.js');
  const createHtml = read('src/views/event-create.html');
  const formHtml = read('src/views/event-form.html');

  assert.match(api, /function mountFeedbackBubble\(\) \{\s*if \(sgIsAdminEditorPath\(\)\) return;/);
  assert.match(legal, /path === '\/admin-editor' \|\| path\.startsWith\('\/admin-editor\/'\)/);
  assert.match(api, /document\.querySelectorAll\('\[data-admin-editor-mobile-context\]'\)/);
  assert.match(api, /paintMobileContext\(`For \$\{hostName\}`\)/);
  assert.match(createHtml, /data-admin-editor-mobile-context hidden/);
  assert.match(formHtml, /data-admin-editor-mobile-context hidden/);
  assert.doesNotMatch(api.match(/function renderAdminEditorNav[\s\S]*?\n\}/)?.[0] || '', /email|phone/i);
});

test('Done For You detail opens isolated workspaces for new events and drafts only', () => {
  const html = read('src/views/admin-done-for-you-detail.html');
  const script = read('public/js/admin-done-for-you-detail.js');

  assert.match(html, /id="create-client-event"/);
  assert.match(html, /id="event-workspace-status"/);
  assert.match(script, /status === 'draft' && eventId/);
  assert.match(script, /data-event-id=/);
  assert.match(script, /\/api\/admin\/done-for-you\/\$\{encodeURIComponent\(dfyDetailState\.id\)\}\/editor-workspaces/);
  assert.match(script, /body: eventId \? \{ eventId \} : \{\}/);
  assert.match(script, /Boolean\(dfyDetailUserId\(\) && dfyDetailHostId\(\) && dfyDetailAccountStatus\(\) === 'active'\)/);
  assert.doesNotMatch(script, /setSessionCookie|\/api\/auth\/login|impersonat/i);
});
