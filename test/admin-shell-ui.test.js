const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('admin shell replaces duplicated tabs with one capability-gated workspace sidebar', () => {
  const shell = read('public/js/admin-shell.js');
  const api = read('public/js/api.js');
  const settings = read('public/js/settings.js');
  const pages = ['accounts', 'hosts', 'events', 'ticketing', 'feedback', 'invitations'];

  for (const page of pages) {
    const html = read(`src/views/admin-${page}.html`);
    assert.match(html, /\/css\/admin-shell\.css/);
    assert.match(html, /\/js\/api\.js[\s\S]*\/js\/admin-shell\.js/);
    assert.doesNotMatch(html, /admin-section-nav/);
    assert.doesNotMatch(html, />The Line</);
  }

  for (const destination of ['/admin', '/admin/accounts', '/admin/done-for-you', '/admin/hosts', '/admin/events', '/admin/ticketing', '/admin/feedback', '/admin/invitations', '/admin/team']) {
    assert.equal(shell.includes(`'${destination}'`), true, `${destination} should be in the workspace sidebar`);
  }
  assert.doesNotMatch(shell, /\/admin\/line/);
  assert.match(shell, /capabilities\.manageOperators === true/);
  assert.doesNotMatch(shell, /operator\.role === ['"]super_admin['"]/);
  assert.match(shell, /data-admin-link="team"[\s\S]*hidden/);
  assert.match(shell, /aria-current="page"[\s\S]*scrollIntoView/);

  assert.match(api, /function getAdminSession/);
  assert.match(api, /function sgIsAdminPath/);
  assert.match(api, /sgAdminSessionPromise = api\('\/api\/admin\/auth\/me'\)/);
  assert.match(api, /class="sg-nav-brand" href="\/admin"/);
  assert.doesNotMatch(settings, /href=["']\/admin/);
  assert.doesNotMatch(settings, /const adminLinks|organizer\.is_admin/);
});

test('overview uses released account and operator endpoints only', () => {
  const html = read('src/views/admin-overview.html');
  const script = read('public/js/admin-overview.js');

  assert.match(html, /data-admin-section="overview"/);
  assert.match(html, /id="overview-total"/);
  assert.match(html, /id="overview-hosts"/);
  assert.match(html, /id="overview-active"/);
  assert.match(script, /\/api\/admin\/accounts\?limit=1/);
  assert.match(script, /\/api\/admin\/operators\?limit=1/);
  assert.doesNotMatch(`${html}\n${script}`, /identity-changes|pending-verifications/);
  assert.match(html, /\/admin\/accounts\?type=host/);
  assert.match(html, /href="\/admin\/events"/);
});

test('team controls use target-bound fresh verification and the operator roster API', () => {
  const html = read('src/views/admin-team.html');
  const script = read('public/js/admin-team.js');
  const stepUp = read('public/js/admin-step-up.js');

  assert.match(html, /data-admin-section="team"/);
  assert.match(html, /prove ownership of this inbox with an email passcode/);
  assert.match(html, /id="operator-role"[\s\S]*value="support"[\s\S]*value="super_admin"/);
  assert.match(script, /api\('\/api\/admin\/operators'\)/);
  assert.match(script, /api\('\/api\/admin\/operators', \{ method: 'POST'/);
  assert.match(script, /\/api\/admin\/operators\/\$\{encodeURIComponent\(teamState\.selected\.id\)\}/);
  assert.match(script, /\/revoke-sessions/);
  assert.match(script, /`new:\$\{email\}`/);
  assert.match(script, /`operator:\$\{teamState\.selected\.id\}`/);
  assert.match(stepUp, /targetKey/);
  assert.match(stepUp, /\/api\/admin\/auth\/step-up\/start/);
  assert.match(stepUp, /\/api\/admin\/auth\/step-up\/complete/);
});
