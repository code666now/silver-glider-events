const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('new-event management keeps its success note and offers one accessible Host Page prompt', () => {
  const view = read('src/views/event-manage.html');
  const client = read('public/js/manage.js');

  assert.match(view, /id="created-note"[\s\S]*Your event is live\./);
  assert.match(view, /id="created-host-note"/);
  assert.match(client, /created-host-note'[\s\S]*\/settings\/host-page/);

  assert.match(view, /<dialog class="host-page-success-dialog" id="host-page-success-dialog" aria-labelledby="host-page-success-title" aria-describedby="host-page-success-copy">/);
  assert.match(view, /id="host-page-success-close"[^>]*aria-label="Close"/);
  assert.match(view, /id="host-page-success-title" tabindex="-1">Your Host Page is live\.<\/h2>/);
  assert.match(view, /id="host-page-success-personalize" href="\/settings\/host-page">Personalize my page<\/a>/);
  assert.match(view, /id="host-page-success-view"[^>]*target="_blank"[^>]*rel="noopener"/);
  assert.match(view, /id="host-page-success-later"[^>]*>Keep managing my event<\/button>/);

  assert.match(client, /if \(createdFromEventFlow\)[\s\S]*showHostPageSuccessIfNeeded\(\)/);
  assert.match(client, /api\('\/api\/host-onboarding'\)/);
  assert.match(client, /state\.showHostPageSuccess/);
  assert.match(client, /safeHostPageUrl\(state\.hostPageUrl\)/);
  assert.match(client, /'host-page-success-dialog'\)\.showModal\(\)/);
  assert.match(client, /'host-page-success-title'\)\.focus\(\)/);
  assert.match(client, /fetch\('\/api\/host-onboarding\/seen'/);
  assert.match(client, /keepalive: true/);
  assert.match(client, /'host-page-success-dialog'\)\.addEventListener\('close', markHostPageSuccessSeen\)/);
});

test('Host Page prompt becomes a thumb-friendly bottom sheet on phones', () => {
  const view = read('src/views/event-manage.html');
  const mobile = view.slice(view.indexOf('@media (max-width: 879px)'), view.indexOf('</style>'));

  assert.match(mobile, /\.host-page-success-dialog\s*\{[\s\S]*width:100%[\s\S]*margin:auto 0 0[\s\S]*border-radius:28px 28px 0 0/);
  assert.match(mobile, /max-height:calc\(100vh - 32px\);max-height:calc\(100dvh - 32px\)/);
  assert.match(mobile, /overflow-y:auto;overscroll-behavior:contain/);
  assert.match(mobile, /padding:36px 22px calc\(24px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(mobile, /\.host-page-success-actions\s*\{\s*grid-template-columns:1fr/);
  assert.match(mobile, /min-height:var\(--sg-mobile-control-height\)/);
});
