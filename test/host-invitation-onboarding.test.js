const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

function routeBlock(source, method, route, nextMethod) {
  const start = source.indexOf(`router.${method}('${route}'`);
  assert.notEqual(start, -1, `${method.toUpperCase()} ${route} is present`);
  const end = nextMethod
    ? source.indexOf(`router.${nextMethod.method}('${nextMethod.route}'`, start + 1)
    : source.indexOf('\nmodule.exports', start + 1);
  assert.notEqual(end, -1, `${method.toUpperCase()} ${route} has a bounded source block`);
  return source.slice(start, end);
}

test('Host invitation onboarding browser code compiles', () => {
  const view = read('src/views/host-invitation.html');
  const scripts = [...view.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .filter(Boolean);

  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0], { filename: 'host-invitation.html' }));
});

test('Host invitation router exposes the exact, narrowly validated endpoints', () => {
  const route = read('src/routes/host-invitation-onboarding.js');

  assert.match(route, /const TOKEN_RE = \/\^\[a-z0-9-\]\{12,220\}\$\//);
  assert.match(route, /router\.get\('\/host-invitation\/:token'/);
  assert.match(route, /router\.get\('\/api\/public\/host-invitations\/:token'/);
  assert.match(route, /router\.get\('\/api\/host-invitations\/:token', requireOrganizer/);
  assert.match(route, /router\.post\('\/api\/host-invitations\/:token\/accept', requireOrganizer/);
  assert.match(route, /module\.exports = router/);
});

test('Invitation reads are read-only, privacy scoped, and never expose the token payload', () => {
  const route = read('src/routes/host-invitation-onboarding.js');
  const publicRead = routeBlock(route, 'get', '/api/public/host-invitations/:token', {
    method: 'get', route: '/host-invitation/:token'
  });
  const pageRead = routeBlock(route, 'get', '/host-invitation/:token', {
    method: 'get', route: '/api/host-invitations/:token'
  });
  const accountRead = routeBlock(route, 'get', '/api/host-invitations/:token', {
    method: 'post', route: '/api/host-invitations/:token/accept'
  });

  for (const block of [publicRead, pageRead, accountRead]) {
    assert.doesNotMatch(block, /\b(?:UPDATE|INSERT|DELETE)\b/);
  }
  assert.match(publicRead, /res\.json\(\{ invitation: \{ hostName: invitation\.host_name \} \}\)/);
  assert.doesNotMatch(publicRead, /personal_note|joined_at|joined_organizer_id\s*[,}]/);
  assert.match(route, /Cache-Control', 'private, no-store'/);
  assert.match(route, /Referrer-Policy', 'no-referrer'/);
  assert.match(route, /X-Robots-Tag', 'noindex, nofollow, noarchive'/);
});

test('Acceptance is explicit, same-origin, locked, idempotent, and owner-safe', () => {
  const route = read('src/routes/host-invitation-onboarding.js');
  const accept = routeBlock(route, 'post', '/api/host-invitations/:token/accept');

  assert.match(accept, /sameOriginMutation\(req\)/);
  assert.match(accept, /client\.query\('BEGIN'\)/);
  assert.match(accept, /invitationByToken\(client, token, \{ lock: true \}\)/);
  assert.match(route, /\$\{lock \? 'FOR UPDATE' : ''\}/);
  assert.match(accept, /joined_organizer_id != null[\s\S]*Number\(invitation\.joined_organizer_id\) !== organizerId[\s\S]*invitationConflict/);
  assert.match(accept, /if \(invitation\.joined_organizer_id == null\)[\s\S]*UPDATE host_invitations[\s\S]*joined_organizer_id=\$2,joined_at=NOW\(\)/);
  assert.match(accept, /client\.query\('COMMIT'\)/);
  assert.match(route, /status\(404\)/);
  assert.match(route, /status\(410\)/);
  assert.match(route, /status\(409\)/);
});

test('Onboarding derives welcome, setup, and ready from joined ownership and the canonical Host Page', () => {
  const route = read('src/routes/host-invitation-onboarding.js');

  assert.match(route, /function hasResolvableHostPage\(host\)[\s\S]*String\(host\.publicSlug \|\| ''\)\.trim\(\)[\s\S]*String\(host\.orgName \|\| ''\)\.trim\(\)/);
  assert.match(route, /const existingHostPage = hasResolvableHostPage\(host\)/);
  assert.match(route, /const screen = joinedByCurrent[\s\S]*existingHostPage \? 'ready' : 'setup'[\s\S]*: 'welcome'/);
  assert.match(route, /suggestedHostName: \([\s\S]*String\(host\.orgName \|\| ''\)\.trim\(\) \|\|[\s\S]*String\(invitation\.host_name \|\| ''\)\.trim\(\)[\s\S]*\)\.slice\(0, 100\)/);
});

test('Partial legacy Host Pages recover through setup without replacing their stored slug', () => {
  const route = read('src/routes/host-invitation-onboarding.js');
  const view = read('src/views/host-invitation.html');

  assert.match(view, /function hostPageReady\(organizer\)[\s\S]*organizer\?\.publicSlug[\s\S]*organizer\?\.orgName/);
  assert.match(view, /if \(!hostPageReady\(organizer\)\) return showSetup\(\)/);
  assert.match(view, /state\.organizer\.publicSlug[\s\S]*\? 'Complete Host Page'[\s\S]*: 'Create Host Page'/);
  assert.match(view, /state\.existingHostPage = hostPageReady\(state\.organizer\)/);
  assert.match(view, /if \(!state\.existingHostPage\)[\s\S]*still needs a Host name/);
  assert.match(view, /Your details were saved, but the Host Page is not ready/);
  assert.match(view, /continue-without-logo'\)\.hidden = !profileReady/);
  assert.doesNotMatch(view, /public_slug\s*:/);
  assert.doesNotMatch(route, /UPDATE organizers/);
});

test('Onboarding reuses profile, upload, event, host, and dashboard flows without a duplicate editor', () => {
  const view = read('src/views/host-invitation.html');

  assert.match(view, /Publish unique event pages and collect RSVPs\./);
  assert.match(view, /request\('\/api\/settings', \{[\s\S]*method: 'PUT'/);
  assert.match(view, /name: state\.organizer\.name \|\| ''/);
  assert.match(view, /website_url: state\.organizer\.websiteUrl \|\| ''/);
  assert.match(view, /fetch\('\/api\/uploads\/host-logo'/);
  assert.ok(view.indexOf("request('/api/settings'") < view.indexOf('await uploadLogo(logoFile)'));
  assert.match(view, /href="\/events\/new"/);
  assert.match(view, /href="\/dashboard"/);
  assert.match(view, /`\/h\/\$\{encodeURIComponent\(slug\)\}`/);
  assert.match(view, /request\(`\$\{endpoint\}\/accept`, \{ method: 'POST'/);
  assert.match(view, /if \(destination === 'dashboard'\)[\s\S]*window\.location\.assign\('\/dashboard'\)/);
  assert.doesNotMatch(view, /\/api\/events|method:\s*'POST'[\s\S]{0,120}\/events/);
});

test('Onboarding keeps an existing public Host Page intact and has accessible recovery states', () => {
  const view = read('src/views/host-invitation.html');

  assert.match(view, /if \(state\.screen === 'ready'\) return showReady\(\{ existing: state\.existingHostPage \}\)/);
  assert.match(view, /We kept your existing Host Page exactly as it was/);
  assert.match(view, /role="alert"/);
  assert.match(view, /aria-live="polite"/);
  assert.match(view, /heading\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(view, /rawUrl\.startsWith\('blob:'\) \? rawUrl : safeHttpUrl\(rawUrl\)/);
  assert.match(view, /<meta name="referrer" content="no-referrer">/);
  assert.match(view, /<meta name="robots" content="noindex,nofollow,noarchive">/);
  assert.match(view, /Continue without the logo/);
});
