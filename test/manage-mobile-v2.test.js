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

  assert.deepEqual(mobileTasks, ['overview', 'guests', 'promote', 'photos', 'actions']);
  assert.match(view, /class="manage-mobile-nav"[\s\S]*id="manage-mobile-back"[\s\S]*id="manage-mobile-preview-slot"/);
  assert.ok(view.indexOf('id="manage-mobile-edit-slot"') < view.indexOf('data-manage-mobile-open="overview"'));
  assert.match(view, /manage-edit-mobile-copy[\s\S]*<strong>Edit event<\/strong>[\s\S]*Change details, appearance, RSVP, and settings/);
  assert.match(view, /data-manage-mobile-open="actions"[\s\S]*<strong>Event actions<\/strong>/);
  assert.doesNotMatch(view.slice(view.indexOf('id="manage-mobile-hub"'), view.indexOf('<div class="stat-row">')), /<strong>More<\/strong>/);
  const mobileViewCss = view.slice(view.indexOf('@media (max-width: 879px)'), view.indexOf('</style>'));
  for (const task of mobileTasks) assert.match(mobileViewCss, new RegExp(`data-mobile-view="${task}"`));
  assert.match(client, /mobileManageLayout = window\.matchMedia\('\(max-width: 879px\)'\)/);
  assert.match(client, /\$\('manage-mobile-preview-slot'\)\.append\(viewLink\)/);
  assert.match(client, /\$\('manage-mobile-edit-slot'\)\.append\(\$\('edit-link'\)\)/);
  assert.match(client, /mobileEditMarker\.parentNode\.insertBefore\(\$\('edit-link'\), mobileEditMarker\.nextSibling\)/);
  assert.match(client, /mobilePreviewMarker\.parentNode\.insertBefore\(viewLink, mobilePreviewMarker\.nextSibling\)/);
  assert.match(client, /setMobileManageView\('home'/);
  assert.match(client, /\$\('manage-mobile-screen-intro'\)\.hidden = view === 'home'/);
  assert.match(client, /view === 'actions'[\s\S]*\$\('more-menu'\)\.setAttribute\('open', ''\)/);
  assert.match(client, /view === 'actions'[\s\S]*\$\('more-menu-panel'\)/);
  assert.match(view, /class="manage-mobile-screen-intro"[\s\S]*<h1 class="sr-only" id="manage-mobile-screen-title">Overview<\/h1>/);
  assert.doesNotMatch(view, /<p>Manage event<\/p>/);

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
  assert.match(mobileViewCss, /font-size:var\(--sg-mobile-page-title-size\)/);
  assert.match(mobileViewCss, /min-height:104px/);
  assert.match(mobileViewCss, /min-height:var\(--sg-mobile-control-height\)/);
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

test('phone event actions are direct while desktop keeps the disclosure menu', () => {
  const view = read('src/views/event-manage.html');
  const client = read('public/js/manage.js');
  const mobileViewCss = view.slice(view.indexOf('@media (max-width: 879px)'), view.indexOf('</style>'));

  assert.match(view, /id="more-menu-panel" role="region" tabindex="-1" aria-labelledby="manage-mobile-actions-title"/);
  assert.match(view, /id="manage-mobile-actions-title">Event actions<\/h2>/);
  assert.match(mobileViewCss, /data-mobile-view="actions"[\s\S]*\.more-menu > summary \{ display:none; \}/);
  assert.match(mobileViewCss, /data-mobile-view="actions"[\s\S]*\.manage-danger-zone \{ display:block; \}/);
  assert.match(mobileViewCss, /data-mobile-view="actions"[\s\S]*\.manage-mobile-screen-intro span \{ display:none; \}/);
  assert.match(client, /activeMobileManageView !== 'actions'/);
  assert.match(client, /activeMobileManageView === 'actions'\) return/);

  const panel = view.slice(view.indexOf('id="more-menu-panel"'), view.indexOf('</details>'));
  assert.match(panel, /id="duplicate"/);
  assert.match(panel, /id="cancel-event"/);
  assert.match(view, /class="manage-danger-zone"[\s\S]*id="delete-event"/);
});
