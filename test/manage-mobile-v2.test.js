const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('phone event management uses one task hub and the original action controls', () => {
  const view = read('src/views/event-manage.html');
  const client = read('public/js/manage.js');
  const mobileTasks = [...view.matchAll(/data-manage-mobile-open="([^"]+)"/g)].map(match => match[1]);

  assert.deepEqual(mobileTasks, ['overview', 'guests', 'promote', 'photos', 'more']);
  assert.match(view, /class="manage-mobile-nav"[\s\S]*id="manage-mobile-back"[\s\S]*id="manage-mobile-preview-slot"/);
  const mobileViewCss = view.slice(view.indexOf('@media (max-width: 879px)'), view.indexOf('</style>'));
  for (const task of mobileTasks) assert.match(mobileViewCss, new RegExp(`data-mobile-view="${task}"`));
  assert.match(client, /mobileManageLayout = window\.matchMedia\('\(max-width: 879px\)'\)/);
  assert.match(client, /\$\('manage-mobile-preview-slot'\)\.append\(viewLink\)/);
  assert.match(client, /mobilePreviewMarker\.parentNode\.insertBefore\(viewLink, mobilePreviewMarker\.nextSibling\)/);
  assert.match(client, /setMobileManageView\('home'/);

  for (const id of ['view-link', 'copy-link', 'edit-link', 'duplicate', 'cancel-event', 'delete-event']) {
    assert.equal((view.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} stays a single control`);
  }
});

test('phone management sizing, focus, and safe areas stay below the 880px split', () => {
  const view = read('src/views/event-manage.html');
  const familiar = read('public/css/familiar-faces.css');
  const sms = read('public/css/sms-notifications.css');
  const mobileViewCss = view.slice(view.indexOf('@media (max-width: 879px)'), view.indexOf('</style>'));

  assert.match(mobileViewCss, /padding-right:max\(22px,env\(safe-area-inset-right\)\)/);
  assert.match(mobileViewCss, /font-size:34px/);
  assert.match(mobileViewCss, /min-height:104px/);
  assert.match(mobileViewCss, /min-height:58px/);
  assert.match(mobileViewCss, /:focus-visible/);
  assert.match(mobileViewCss, /padding-bottom:calc\(112px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(mobileViewCss, /\.feedback-bubble \{ display:none !important; \}/);
  assert.match(view, /@media \(min-width: 1024px\)[\s\S]*max-width:1260px/);

  assert.match(familiar, /@media \(max-width:879px\)[\s\S]*bottom:calc\(72px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(familiar, /body\.has-familiar-mobile-action \.sg-toast \{ bottom:calc\(300px \+ env\(safe-area-inset-bottom\)\); \}/);
  assert.match(familiar, /\.familiar-invite-dialog-foot[\s\S]*env\(safe-area-inset-bottom\)/);
  assert.match(sms, /@media \(max-width:879px\)[\s\S]*\.sms-dialog-close:focus-visible/);
  assert.match(sms, /\.sms-dialog-foot[\s\S]*env\(safe-area-inset-bottom\)/);
});
