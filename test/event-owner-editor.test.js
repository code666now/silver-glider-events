const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('public event pages provide an owner-only progressive live editing shell', () => {
  const route = read('src/routes/public.js');
  const renderer = read('src/lib/event-owner-editor.js');
  const client = read('public/js/event-owner-editor.js');

  assert.match(route, /organizerViewer\(req, event\) \? renderOwnerEditor\(event\) : ''/);
  assert.match(route, /replace\(\/\{\{OWNER_EDITOR_HTML\}\}\/g, ownerEditorHtml\)/);
  assert.match(renderer, /id="owner-edit-trigger"/);
  assert.match(renderer, /role="tablist" aria-label="Event editing sections"/);
  assert.match(renderer, /data-owner-tab="appearance"/);
  assert.match(renderer, /data-owner-tab="details"/);
  assert.match(renderer, /data-owner-tab="settings"/);
  assert.match(renderer, /They stay private until you save\./);
  assert.match(renderer, /role="switch"/);
  assert.match(renderer, /Admission, music &amp; advanced settings/);
  assert.match(renderer, /owner-flyer-default[\s\S]*Default wall/);
  assert.doesNotMatch(renderer, /id="owner-end-time"/);

  assert.match(client, /request\(`\/api\/events\/\$\{EVENT\.id\}`/);
  assert.match(client, /method: 'PUT'/);
  assert.match(client, /function previewImage\(\)/);
  assert.match(client, /function previewTheme\(theme\)/);
  assert.match(client, /function previewDetails\(\)/);
  assert.match(client, /Discard your unsaved event changes\?/);
  assert.match(client, /sessionStorage\.setItem\('sge-owner-editor-reopen'/);
  assert.match(client, /people have'\} RSVP’d\. This change may affect their plans\./);
  assert.doesNotMatch(client, /\$\('owner-end-time'\)/);
  assert.doesNotMatch(client, /end_time:/);
});

test('desktop uses a right editing rail while mobile uses a collapsible bottom sheet', () => {
  const styles = read('public/css/event-owner-editor.css');
  const standard = read('src/views/event-public.html');
  const flyer = read('src/views/event-public-flyer.html');

  assert.match(styles, /--owner-panel-width: 420px/);
  assert.match(styles, /\.owner-editor \{[\s\S]*position: fixed;[\s\S]*inset: 0 0 0 auto;/);
  assert.match(styles, /body\.owner-editor-open \{ padding-right: var\(--owner-panel-width\)/);
  assert.match(styles, /@media \(max-width: 879px\)[\s\S]*inset: auto 0 0;[\s\S]*height: min\(88dvh,760px\)/);
  assert.match(styles, /\.owner-editor\.is-peeking \{ transform: translateY\(calc\(100% - 70px\)\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);

  for (const template of [standard, flyer]) {
    assert.match(template, /event-owner-editor\.css/);
    assert.match(template, /\{\{OWNER_EDITOR_HTML\}\}/);
    assert.match(template, /event-owner-editor\.js/);
  }
});

test('appearance editing reuses protected uploads and rate-conscious photo search', () => {
  const client = read('public/js/event-owner-editor.js');
  assert.match(client, /'\/api\/uploads\/flyer' : '\/api\/uploads\/cover'/);
  assert.match(client, /\/api\/photos\/search\?q=/);
  assert.match(client, /per_page=12/);
  assert.match(client, /halloween pumpkins costumes haunted spooky/);
  assert.match(client, /autumn leaves cozy harvest warm/);
  assert.doesNotMatch(client, /addEventListener\('input',[\s\S]{0,120}loadPhotos/);
});

test('appearance previews mount only the selected animated effect', () => {
  const route = read('src/routes/public.js');
  const publicClient = read('public/js/public-event.js');
  const ownerClient = read('public/js/event-owner-editor.js');

  assert.match(route, /data-effect-theme="\$\{theme\}"/);
  assert.match(publicClient, /canvas\.dataset\.effectTheme = 'static'/);
  assert.match(ownerClient, /const videoEffects = \{[\s\S]*disco: 'sg-events\/effects\/disco'[\s\S]*fog: 'sg-events\/effects\/fog'/);
  assert.match(ownerClient, /function syncEffectMedia\(theme, background\)/);
  assert.match(ownerClient, /document\.createElement\('video'\)/);
  assert.match(ownerClient, /video\.play\(\)\.then/);
  assert.match(ownerClient, /video\.pause\(\)/);
  assert.match(ownerClient, /if \(video\.dataset\.ownerPreview\) video\.remove\(\)/);
  assert.match(ownerClient, /navigator\.connection\?\.saveData/);
  assert.match(ownerClient, /prefers-reduced-motion: reduce/);
  assert.match(ownerClient, /document\.createElement\('canvas'\)/);
  assert.match(ownerClient, /requestAnimationFrame\(animate\)/);
});
