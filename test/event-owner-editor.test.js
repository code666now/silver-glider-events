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

  assert.match(route, /const ownerPreview = organizerViewer\(req, event\)/);
  assert.match(route, /const ownerEditorHtml = ownerPreview \? renderOwnerEditor\(event\) : ''/);
  assert.match(route, /replace\(\/\{\{OWNER_EDITOR_HTML\}\}\/g, ownerEditorHtml\)/);
  assert.match(renderer, /id="owner-edit-trigger"/);
  assert.match(renderer, /role="tablist" aria-label="Event editing sections"/);
  assert.match(renderer, /data-owner-tab="appearance"/);
  assert.match(renderer, /data-owner-tab="details"/);
  assert.match(renderer, /data-owner-tab="settings"/);
  assert.match(renderer, /They stay private until you save\./);
  assert.match(renderer, /role="switch"/);
  assert.equal((renderer.match(/<i aria-hidden="true"><b>On<\/b><b>Off<\/b><\/i>/g) || []).length, 3);
  assert.match(renderer, /Admission, music &amp; advanced settings/);
  assert.match(renderer, /owner-flyer-default[\s\S]*Match Photo/);
  assert.doesNotMatch(renderer, /id="owner-end-time"/);

  assert.match(client, /request\(`\/api\/events\/\$\{EVENT\.id\}`/);
  assert.match(client, /method: 'PUT'/);
  assert.match(client, /function previewImage\(/);
  assert.match(client, /function previewTheme\(theme\)/);
  assert.match(client, /function previewDetails\(\)/);
  assert.match(client, /function reconcileEditorFields\(\)/);
  assert.match(client, /setInterval\(reconcileEditorFields, 200\)/);
  assert.match(client, /function closeEditor[\s\S]*reconcileEditorFields\(\)/);
  assert.match(client, /Discard your unsaved event changes\?/);
  assert.match(client, /sessionStorage\.setItem\('sge-owner-editor-reopen'/);
  assert.match(client, /people have'\} RSVP’d\. This change may affect their plans\./);
  assert.doesNotMatch(client, /\$\('owner-end-time'\)/);
  assert.doesNotMatch(client, /end_time:/);
  assert.match(renderer, /id="owner-places-status" role="status"/);
  assert.match(renderer, /id="owner-location-search"[^>]+placeholder="Search venue or address"/);
  assert.match(renderer, /id="owner-location-manual-toggle"[^>]*>Enter manually</);
  assert.match(renderer, /Location name <small>Optional<\/small>/);
  assert.match(renderer, /id="owner-location-name"/);
  assert.doesNotMatch(renderer, /id="owner-venue"|id="owner-address"/);
  assert.match(client, /request\('\/api\/places\/config'\)/);
  assert.match(client, /new google\.maps\.places\.Autocomplete\(\$\('owner-location-search'\)/);
  assert.match(client, /fields: \['name', 'formatted_address', 'address_components', 'geometry', 'place_id', 'types'\]/);
  assert.doesNotMatch(client, /types:\s*\['establishment'\]/);
  assert.match(client, /function populateOwnerLocation\(\)/);
  assert.match(client, /function syncOwnerManualLocation\(\)/);
  assert.match(client, /LocationUtils\.recordForPlace\(place\)/);
  assert.match(client, /LocationUtils\.displayParts\(activeName, activeAddress\)/);
  assert.match(client, /venue_city: draft\.venueCity \|\| null/);
  assert.match(client, /google_place_id: draft\.googlePlaceId \|\| null/);
  assert.match(client, /clearPlaceMeta\(\);[\s\S]*renderOwnerLocation\(\);[\s\S]*previewDetails\(\);[\s\S]*syncDirtyState\(\)/);
});

test('event descriptions preserve paragraph spacing in live previews and published pages', () => {
  const route = read('src/routes/public.js');
  const standard = read('src/views/event-public.html');
  const flyerStyles = read('public/css/event-public-flyer.css');
  const client = read('public/js/event-owner-editor.js');

  assert.match(route, /event\.description[\s\S]*replace\(\/\\n\/g, '<br>'\)/);
  assert.match(standard, /\.desc \{[^}]*white-space: pre-line;/);
  assert.match(flyerStyles, /\.desc \{[^}]*white-space: pre-line;/);
  assert.match(client, /description\.textContent = draft\.description \|\| ''/);
});

test('appearance panel matches dashboard cover-fit preview behavior', () => {
  const client = read('public/js/event-owner-editor.js');
  const styles = read('public/css/event-owner-editor.css');

  assert.match(client, /function previewImage\(\{ resolveAutoFit = false \} = \{\}\)/);
  assert.match(client, /function defaultCoverFitFromImage\(image\)/);
  assert.match(client, /image\.naturalHeight > image\.naturalWidth \? 'contain' : 'cover'/);
  assert.match(client, /classList\.toggle\('fit-contain', draft\.coverFitMode === 'contain'\)/);
  assert.match(client, /previewImage\(\{ resolveAutoFit: true \}\)/);
  assert.match(styles, /\.owner-image-card\.fit-contain \{[\s\S]*var\(--sg-surface\);/);
  assert.match(styles, /\.owner-image-card\.fit-contain img \{ object-fit: contain; \}/);
});

test('owner edit trigger uses the neutral platform treatment', () => {
  const styles = read('public/css/event-owner-editor.css');

  assert.match(styles, /\.owner-edit-trigger \{[\s\S]*background: rgba\(35,35,39,\.9\);/);
  assert.match(styles, /\.owner-edit-trigger:hover \{[^}]*border-color: rgba\(28,197,190,\.45\);[^}]*background: rgba\(47,47,52,\.95\);/);
  assert.doesNotMatch(styles, /rgba\(38,10,83|rgba\(92,28,205/);
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
  assert.match(styles, /input:checked \+ i::after \{ transform: translateX\(35px\)/);
  assert.match(styles, /\.pac-container \{[\s\S]*z-index: 2000;[\s\S]*background: #141416;/);

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
  assert.match(ownerClient, /const videoEffects = \{[\s\S]*'liquid-stardust': 'sg-events\/effects\/liquid-stardust'[\s\S]*'color-static': 'sg-events\/effects\/color-static'[\s\S]*disco: 'sg-events\/effects\/disco'[\s\S]*fog: 'sg-events\/effects\/fog'/);
  assert.match(ownerClient, /function syncEffectMedia\(theme, background\)/);
  assert.match(ownerClient, /document\.createElement\('video'\)/);
  assert.match(ownerClient, /seamlessLoop \? seamlessLoop\.play\(\) : video\.play\(\)/);
  assert.match(ownerClient, /video\.pause\(\)/);
  assert.match(ownerClient, /if \(video\.dataset\.ownerPreview\) video\.remove\(\)/);
  assert.match(ownerClient, /navigator\.connection\?\.saveData/);
  assert.match(ownerClient, /prefers-reduced-motion: reduce/);
  assert.match(ownerClient, /document\.createElement\('canvas'\)/);
  assert.match(ownerClient, /requestAnimationFrame\(animate\)/);
});

test('appearance gradients match the dashboard and visibly replace the artwork palette', () => {
  const brand = read('public/css/brand.css');
  const ownerStyles = read('public/css/event-owner-editor.css');
  const ownerClient = read('public/js/event-owner-editor.js');
  const publicClient = read('public/js/public-event.js');

  for (const theme of ['midnight', 'aurora', 'sunset', 'ocean']) {
    const dashboardTheme = brand.match(new RegExp(`\\.bg-${theme} \\{([\\s\\S]*?)\\n\\}`));
    const ownerTheme = ownerStyles.match(new RegExp(`\\.owner-theme-${theme} \\{\\n([\\s\\S]*?)\\n\\}`));
    assert.ok(dashboardTheme && ownerTheme, `${theme} should exist in both pickers`);
    assert.equal(
      ownerTheme[1].match(/background-image:([\s\S]*)/)[1].replace(/\s+/g, ''),
      dashboardTheme[1].match(/background-image:([\s\S]*)/)[1].replace(/\s+/g, ''),
      `${theme} colors should match the dashboard`
    );
  }

  assert.match(ownerClient, /background\.classList\.remove\('image-palette'/);
  assert.match(ownerClient, /const themeClass = effectKeys\.includes\(draft\.backgroundTheme\)/);
  assert.match(ownerClient, /if \(draft\.backgroundTheme === 'adaptive'\) applyArtworkPalette/);
  assert.match(publicClient, /if \(EVENT\.adaptiveBackground\)/);
});

test('guest experience switches preview owner-only page sections without saving', () => {
  const route = read('src/routes/public.js');
  const ownerClient = read('public/js/event-owner-editor.js');
  const publicClient = read('public/js/public-event.js');
  const styles = read('public/css/event-owner-editor.css');

  assert.match(route, /renderGuestList\(event, rows, \{ ownerPreview = false \} = \{\}\)/);
  assert.match(route, /data-owner-preview-section="guest-list"/);
  assert.match(route, /data-owner-preview-section="guest-fields"/);
  assert.match(route, /data-owner-preview-section="comments"/);
  assert.match(route, /event\.show_guest_list \|\| ownerPreview/);
  assert.match(publicClient, /window\.SGEventPreview = \{/);
  assert.match(publicClient, /setGuestListVisible\(visible\)/);
  assert.match(publicClient, /setGuestFieldsVisible\(visible\)/);
  assert.match(publicClient, /setCommentsVisible\(visible\)/);
  assert.match(ownerClient, /function previewGuestSettings\(\)/);
  assert.match(ownerClient, /preview\.setGuestListVisible\(draft\.showGuestList\)/);
  assert.match(ownerClient, /preview\.setGuestFieldsVisible\(draft\.allowGuests\)/);
  assert.match(ownerClient, /preview\.setCommentsVisible\(draft\.commentsEnabled\)/);
  assert.match(styles, /\[data-owner-preview-section\]\[hidden\] \{ display: none !important; \}/);
});
