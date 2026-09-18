const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('phone guest faces stay compact, readable, thumb friendly, and zoom safe', () => {
  const styles = read('public/css/familiar-faces.css');
  const client = read('public/js/manage.js');

  assert.match(styles, /@media \(max-width:879px\)[\s\S]*?\.manage-shell \.familiar-faces-grid \{ grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(styles, /\.manage-shell \.familiar-face-name \{[\s\S]*?font-size:13px/);
  assert.match(styles, /\.manage-shell \.familiar-face-status \{[\s\S]*?font-size:12px/);
  assert.match(styles, /\.manage-shell \.familiar-face-note \{[^}]*font-size:12px/);
  assert.match(styles, /\.manage-shell \.familiar-face-share \{[^}]*min-height:44px/);
  assert.match(styles, /@media \(max-width:359px\)[\s\S]*?repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(styles, /@media \(max-width:359px\)[\s\S]*?#familiar-people-bar:not\(\.is-confirming\)[\s\S]*?white-space:nowrap/);
  assert.match(styles, /@media \(max-width:279px\)[\s\S]*?repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.manage-shell \.familiar-face-avatar \{ transition:none; \}/);
  assert.match(client, /face\.status \? `, \$\{face\.status\}` : ''/);
  assert.match(client, /face\.detail \? `, \$\{face\.detail\}` : ''/);
  assert.match(client, /data-detail="\$\{escapeHtml\(face\.detail \|\| ''\)\}"/);
  assert.match(client, /card\.dataset\.detail \? `, \$\{card\.dataset\.detail\}` : ''/);
  assert.match(client, /aria-label="\$\{escapeHtml\(selectionLabel\)\}"/);
});

test('phone invite picker uses one short row before restoring the confirmation disclosure', () => {
  const styles = read('public/css/familiar-faces.css');
  const client = read('public/js/manage.js');

  assert.match(client, /classList\.toggle\('is-confirming', peopleConfirming\)/);
  assert.match(client, /Each gets one email with an RSVP button\. They can unsubscribe anytime\./);
  assert.match(styles, /#familiar-people-bar:not\(\.is-confirming\) \{ flex-direction:row;align-items:center/);
  assert.match(styles, /#familiar-people-bar:not\(\.is-confirming\) \.familiar-faces-selection-copy span \{ display:none; \}/);
  assert.match(styles, /#familiar-people-secondary \{ min-height:44px/);
  assert.match(styles, /#familiar-people-send \{ min-height:48px/);
});

test('all three phone event editors present manual location switching as a link-like button', () => {
  const ownerStyles = read('public/css/event-owner-editor.css');
  const quickCreate = read('src/views/event-create.html');
  const eventForm = read('src/views/event-form.html');

  for (const [name, source] of [
    ['owner editor', ownerStyles],
    ['quick create', quickCreate],
    ['full event form', eventForm]
  ]) {
    assert.match(source, /location-(?:search-mode[\s\S]*?)?mode-button[\s\S]*?min-height:\s*44px;[\s\S]*?border:\s*0;[\s\S]*?background:\s*none;[\s\S]*?color:\s*var\(--sg-accent\)/, `${name} keeps a link-like 44px location switch`);
  }
});
