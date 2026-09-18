const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const occurrences = (source, pattern) => (source.match(pattern) || []).length;

test('mobile date and time controls share the 60px control geometry on every event editor', () => {
  const brand = read('public/css/brand.css');
  const main = read('public/css/main.css');
  const quickCreate = read('src/views/event-create.html');
  const eventForm = read('src/views/event-form.html');
  const ownerEditor = read('public/css/event-owner-editor.css');

  assert.match(brand, /--sg-mobile-control-height:\s*60px;/);
  assert.match(
    main,
    /@media \(max-width: 879px\)[\s\S]*--sg-mobile-control-height:\s*60px;/
  );

  assert.match(
    quickCreate,
    /\.quick-create-card \.owner-input\[type="date"\],[\s\S]*?\.quick-create-card \.owner-input\[type="time"\]\s*\{[^}]*height:\s*var\(--sg-mobile-control-height\);[^}]*min-height:\s*var\(--sg-mobile-control-height\);[^}]*\}/
  );
  assert.match(
    quickCreate,
    /\.quick-create-card \.owner-input\[type="date"\]::\-webkit-date-and-time-value,[\s\S]*?\.quick-create-card \.owner-input\[type="time"\]::\-webkit-date-and-time-value\s*\{\s*height:\s*1\.5em;\s*\}/
  );

  assert.match(
    eventForm,
    /#event-form \.sg-input\[type="date"\],[\s\S]*?#event-form \.sg-input\[type="time"\]\s*\{\s*height:\s*60px;\s*min-height:\s*60px;\s*\}/
  );
  assert.match(
    eventForm,
    /#event-form \.sg-input\[type="date"\]::\-webkit-date-and-time-value,[\s\S]*?#event-form \.sg-input\[type="time"\]::\-webkit-date-and-time-value\s*\{\s*height:\s*1\.5em;\s*\}/
  );

  assert.match(
    ownerEditor,
    /\.owner-input:not\(\.owner-textarea\)\s*\{[^}]*height:\s*60px;[^}]*min-height:\s*60px;[^}]*\}/
  );
  assert.match(
    ownerEditor,
    /\.owner-input\[type="date"\]::\-webkit-date-and-time-value,[\s\S]*?\.owner-input\[type="time"\]::\-webkit-date-and-time-value\s*\{\s*height:\s*1\.5em;\s*\}/
  );

  for (const [name, source] of [
    ['quick create', quickCreate],
    ['full event form', eventForm],
    ['owner editor', ownerEditor]
  ]) {
    assert.doesNotMatch(
      source,
      /\.(?:owner-)?location-mode-button\s*\{[^}]*min-height:\s*42px;/,
      `${name} must not restore the narrow-screen 42px location control`
    );
  }
  assert.match(
    eventForm,
    /@media \(max-width: 360px\)[\s\S]*?\.location-mode-button\s*\{\s*min-height:\s*60px;\s*\}/
  );
  assert.doesNotMatch(quickCreate, /\.quick-create-submit\s*\{\s*min-height:\s*52px;/);
  assert.match(eventForm, /#event-form \.commerce-interest \.sg-btn\s*\{[^}]*min-height:\s*60px;/);
  assert.match(ownerEditor, /\.owner-action-button\s*\{[^}]*min-height:\s*60px;/);
});

test('mobile event image actions never leave Remove stranded in a half-width column', () => {
  const eventForm = read('src/views/event-form.html');
  const eventClient = read('public/js/event-form.js');
  const ownerStyles = read('public/css/event-owner-editor.css');
  const ownerClient = read('public/js/event-owner-editor.js');

  assert.match(eventForm, /class="event-image-actions" id="cover-actions"/);
  assert.match(eventForm, /class="event-image-actions event-flyer-actions"/);
  assert.match(
    eventForm,
    /#event-form #btn-clear-cover,[\s\S]*?#event-form \.event-flyer-actions \.sg-btn\s*\{\s*grid-column:\s*1 \/ -1;\s*\}/
  );
  assert.match(eventForm, /#event-form \.event-flyer-actions\s*\{\s*grid-template-columns:\s*1fr;\s*\}/);
  assert.match(eventClient, /\$\('cover-actions'\)\.classList\.add\('has-photo-search'\)/);
  assert.match(eventClient, /\$\('cover-actions'\)\.classList\.remove\('has-photo-search'\)/);

  assert.match(
    ownerStyles,
    /\.owner-image-actions \.owner-action-muted\s*\{\s*grid-column:\s*1 \/ -1;\s*\}/
  );
  assert.match(
    ownerStyles,
    /\.owner-image-actions\.is-flyer-mode\s*\{\s*grid-template-columns:\s*1fr;\s*\}/
  );
  assert.match(ownerClient, /classList\.toggle\('is-flyer-mode', flyer\)/);
});

test('commerce waitlist stays one coherent coming-soon choice in both event editors', () => {
  const eventForm = read('src/views/event-form.html');
  const eventClient = read('public/js/event-form.js');
  const ownerRenderer = read('src/lib/event-owner-editor.js');
  const ownerClient = read('public/js/event-owner-editor.js');

  assert.equal(occurrences(eventForm, /id="commerce-interest-toggle"/g), 1);
  assert.equal(occurrences(ownerRenderer, /id="owner-commerce-interest-toggle"/g), 1);

  assert.match(
    eventForm,
    /id="admission-commerce"[^>]*aria-label="Sell with Silver Glider is coming soon"[^>]*disabled/
  );
  assert.match(
    eventClient,
    /const showWaitlist = commerceConfigLoaded && !commerceEnabled && !commerceEventId;[\s\S]*classList\.toggle\('has-waitlist', showWaitlist\)/
  );
  assert.match(
    eventForm,
    /#event-form #admission-commerce\.has-waitlist\s*\{[^}]*border-bottom:\s*0;[^}]*border-radius:\s*22px 22px 0 0;/
  );
  assert.match(
    eventForm,
    /#event-form \.commerce-interest\s*\{[^}]*margin-top:\s*0;[^}]*border-top:\s*0;[^}]*border-radius:\s*0 0 22px 22px;/
  );
  assert.doesNotMatch(eventForm, /<strong>Sell with Silver Glider is coming soon\.<\/strong>/);

  assert.match(
    ownerRenderer,
    /<input type="radio" name="owner_admission" value="silver_glider_tickets" disabled aria-disabled="true" hidden>/
  );
  assert.match(ownerRenderer, /<strong>Sell with Silver Glider<\/strong>[\s\S]*Coming soon\. Join the waitlist using your account email\./);
  assert.doesNotMatch(ownerRenderer, /<label class="owner-choice"><input type="radio" name="owner_admission" value="silver_glider_tickets" disabled/);

  for (const [name, client] of [
    ['full event form', eventClient],
    ['owner editor', ownerClient]
  ]) {
    assert.match(client, /['`]\/api\/commerce\/interest['`]/, `${name} should preserve the waitlist endpoint`);
    assert.match(client, /body:\s*\{ interested: nextInterested \}/);
    assert.match(client, /You’re on the list/);
    assert.match(client, /We’ll contact you at your account email when ticketing is available\./);
    assert.match(client, /commerceInterested \? 'Leave waitlist' : 'Join the waitlist'/);
  }
});

test('event creation and editing use the compact mobile title hierarchy without repeated context labels', () => {
  const brand = read('public/css/brand.css');
  const quickCreate = read('src/views/event-create.html');
  const eventForm = read('src/views/event-form.html');
  const eventClient = read('public/js/event-form.js');
  const ownerStyles = read('public/css/event-owner-editor.css');
  const ownerRenderer = read('src/lib/event-owner-editor.js');
  const ownerClient = read('public/js/event-owner-editor.js');

  assert.match(brand, /--sg-mobile-nav-title-size:\s*18px;/);
  assert.match(brand, /--sg-mobile-page-title-size:\s*clamp\(28px, 7\.5vw, 30px\);/);
  assert.match(brand, /--sg-mobile-helper-size:\s*15px;/);

  assert.match(quickCreate, /\.quick-create-mobile-top strong\s*\{[^}]*var\(--sg-mobile-nav-title-size\)/);
  assert.match(quickCreate, /\.quick-create-mobile-copy h1\s*\{[^}]*var\(--sg-mobile-page-title-size\)/);
  assert.match(quickCreate, /\.quick-create-mobile-copy p:last-child\s*\{[^}]*var\(--sg-mobile-helper-size\)/);

  assert.match(eventForm, /\.event-mobile-flow-heading h1\s*\{[\s\S]*?font-size:\s*var\(--sg-mobile-nav-title-size\)/);
  assert.match(eventForm, /\.event-mobile-screen-intro h2\s*\{[^}]*var\(--sg-mobile-page-title-size\)/);
  assert.match(eventForm, /id="event-mobile-screen-kicker" hidden><\/p>/);
  assert.match(eventClient, /`Step \$\{createStep \+ 1\} of \$\{mobileCreateSequence\.length\}`/);
  assert.match(eventClient, /kicker\.hidden = createStep < 0/);

  assert.match(ownerStyles, /\.owner-editor-head h2\s*\{[^}]*var\(--sg-mobile-nav-title-size\)/);
  assert.match(ownerStyles, /\.owner-mobile-screen-head h3\s*\{[^}]*var\(--sg-mobile-page-title-size\)/);
  assert.match(ownerRenderer, /id="owner-mobile-view-eyebrow" hidden><\/p>/);
  assert.doesNotMatch(ownerRenderer, /<p>Event setup<\/p>/);
  assert.match(ownerClient, /eyebrow\.hidden = !hasGuidedProgress/);
  assert.match(ownerClient, /`Step \$\{guidedIndex \+ 1\} of \$\{mobileDraftSequence\.length\}/);
});
