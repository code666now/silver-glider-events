const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('shared and public-event secondary actions keep 44px touch targets', () => {
  const brand = read('public/css/brand.css');
  const standard = read('src/views/event-public.html');
  const flyer = read('public/css/event-public-flyer.css');
  const confirmation = read('public/css/rsvp-confirmation.css');

  assert.match(brand, /\.sg-social-link \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/);
  assert.match(brand, /\.sg-legal-links \.sg-legal-link \{[\s\S]*?min-width: 44px !important;[\s\S]*?min-height: 44px !important;/);
  assert.match(brand, /\.host-your-own \{[\s\S]*?min-height: 44px;/);

  for (const styles of [standard, flyer]) {
    assert.match(styles, /\.rsvp-close \{[\s\S]*?min-height:\s*44px;/);
    assert.match(styles, /\.(?:venue|flyer-venue) a \{[^}]*min-height:\s*44px/);
    assert.match(styles, /\.host-attribution a \{[^}]*min-height:\s*44px/);
  }

  assert.match(confirmation, /\.rsvp-confirmation-close \{[\s\S]*?width:44px;[\s\S]*?height:44px;/);
});

test('host page and owner photo browser keep quiet controls thumb friendly', () => {
  const host = read('src/views/host-public.html');
  const ownerEditor = read('public/css/event-owner-editor.css');

  assert.match(host, /\.host-owner-dashboard \{[\s\S]*?min-height:44px/);
  assert.match(host, /\.host-link \{[\s\S]*?width:44px;height:44px/);
  assert.match(host, /\.follow-modal-close \{ width:44px;height:44px/);
  assert.match(host, /\.follow-use-email \{ min-height:44px/);
  assert.match(host, /\.follow-account-secondary \{ min-height:44px/);
  assert.match(host, /\.host-footer a \{ min-height:44px/);
  assert.match(ownerEditor, /@media \(max-width: 879px\), \(hover: none\) and \(pointer: coarse\) \{[\s\S]*?\.owner-photo-category \{ min-height: 44px; \}/);
});

test('mobile Settings save feedback remains live and visible above fixed action docks', () => {
  const view = read('src/views/settings-v2.html');
  const styles = read('public/css/settings.css');

  assert.match(view, /id="account-status" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(view, /id="host-status" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(styles, /#account-status,#host-status \{[\s\S]*?position:fixed;[\s\S]*?z-index:36;[\s\S]*?text-align:center;/);
  assert.match(styles, /#account-status \{ bottom:calc\(96px \+ env\(safe-area-inset-bottom\)\); \}/);
  assert.match(styles, /#host-status \{ bottom:calc\(166px \+ env\(safe-area-inset-bottom\)\); \}/);
  assert.match(styles, /body:not\(\.has-mobile-sticky-action\) #host-status \{ bottom:calc\(20px \+ env\(safe-area-inset-bottom\)\); \}/);
  assert.match(styles, /#account-status:empty,#host-status:empty \{ display:none; \}/);
});
