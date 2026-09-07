const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('seasonal effects lead, new static effects stay together, and Match Photo comes last', () => {
  const form = source('public/js/event-form.js');
  const ownerRenderer = source('src/lib/event-owner-editor.js');
  const expectedOrder = /'halloween'[\s\S]*'last-guest'[\s\S]*'static'[\s\S]*'liquid-stardust'[\s\S]*'color-static'[\s\S]*'saloon'[\s\S]*'adaptive'/;
  assert.match(form, /const EFFECTS = \['halloween', 'last-guest', 'disco', 'fog', 'paper', 'static', 'liquid-stardust', 'color-static', 'saloon', 'adaptive'\]/);
  assert.match(ownerRenderer, expectedOrder);
  assert.match(form, /adaptive: 'Match Photo'/);
  assert.match(form, /halloween: 'Halloween', 'liquid-stardust': 'Liquid Stardust', 'color-static': 'Color Static'/);
  assert.match(form, /saloon: 'After Hours Saloon'/);
});

test('Match Photo reuses the artwork palette as an explicit adaptive background', () => {
  const form = source('public/js/event-form.js');
  const ownerRenderer = source('src/lib/event-owner-editor.js');
  const ownerClient = source('public/js/event-owner-editor.js');
  const publicClient = source('public/js/public-event.js');
  const publicRoute = source('src/routes/public.js');
  const eventsRoute = source('src/routes/events.js');
  const brand = source('public/css/brand.css');

  assert.match(form, /function updateAdaptiveThemeSwatch\(colors\)/);
  assert.match(form, /updateAdaptiveThemeSwatch\(ArtworkColor\.paletteForBackground\(candidates\)\)/);
  assert.match(ownerRenderer, /\['adaptive', 'Match Photo', 'effect'\]/);
  assert.match(ownerClient, /if \(pageBackground && draft\.backgroundTheme === 'adaptive'\)/);
  assert.match(ownerClient, /background\.classList\.add\('image-palette'\)/);
  assert.match(publicClient, /if \(EVENT\.adaptiveBackground\)/);
  assert.match(publicClient, /background\.classList\.add\('image-palette'\)/);
  assert.match(publicRoute, /adaptiveBackground: theme === 'adaptive'/);
  assert.match(eventsRoute, /'midnight', 'aurora', 'sunset', 'ocean', 'adaptive'/);
  assert.match(brand, /\.sg-swatch\.fx-adaptive/);
  assert.match(brand, /\.bg-adaptive/);
});

test('seasonal video effects are accepted and render from dedicated assets', () => {
  assert.match(source('src/routes/events.js'), /'halloween', 'liquid-stardust', 'color-static', 'last-guest'/);
  const publicRoute = source('src/routes/public.js');
  assert.match(publicRoute, /halloween: 'sg-events\/effects\/halloween'/);
  assert.match(publicRoute, /'liquid-stardust': 'sg-events\/effects\/liquid-stardust'/);
  assert.match(publicRoute, /'color-static': 'sg-events\/effects\/color-static'/);
  assert.match(publicRoute, /'last-guest': 'sg-events\/effects\/the-last-guest'/);
  assert.match(source('public/js/public-event.js'), /\['halloween', 'liquid-stardust', 'color-static', 'last-guest', 'disco', 'fog'\]/);

  for (const view of ['src/views/event-public.html', 'public/css/event-public-flyer.css']) {
    const css = source(view);
    assert.match(css, /\.event-bg\.fx-halloween/);
    assert.match(css, /\.event-bg\.fx-liquid-stardust/);
    assert.match(css, /\.event-bg\.fx-color-static/);
    assert.match(css, /\.event-bg\.fx-last-guest/);
    assert.match(css, /sg-events\/effects\/halloween\.jpg/);
    assert.match(css, /sg-events\/effects\/liquid-stardust\.jpg/);
    assert.match(css, /sg-events\/effects\/color-static\.jpg/);
    assert.match(css, /sg-events\/effects\/the-last-guest\.jpg/);
  }

  const pickerCss = source('public/css/brand.css');
  assert.match(pickerCss, /\.sg-swatch\.fx-halloween/);
  assert.match(pickerCss, /\.sg-swatch\.fx-liquid-stardust/);
  assert.match(pickerCss, /\.sg-swatch\.fx-color-static/);
  assert.match(pickerCss, /\.sg-swatch\.fx-last-guest/);
  assert.match(source('public/css/event-owner-editor.css'), /\.owner-theme-liquid-stardust/);
  assert.match(source('public/css/event-owner-editor.css'), /\.owner-theme-color-static/);
  assert.match(source('src/routes/public-hosts.js'), /sg-events\/effects\/liquid-stardust\.jpg/);
  assert.match(source('src/routes/public-hosts.js'), /sg-events\/effects\/color-static\.jpg/);
  assert.match(source('src/routes/public-hosts.js'), /sg-events\/effects\/the-last-guest\.jpg/);
  assert.match(source('src/lib/mailer.js'), /sg-events\/effects\/liquid-stardust\.jpg/);
  assert.match(source('src/lib/mailer.js'), /sg-events\/effects\/color-static\.jpg/);
  assert.match(source('src/lib/mailer.js'), /sg-events\/effects\/halloween\.jpg/);
});

test('new video backgrounds crossfade their end-to-start seam in both live views', () => {
  const seamlessLoop = source('public/js/seamless-video-loop.js');
  const publicClient = source('public/js/public-event.js');
  const ownerClient = source('public/js/event-owner-editor.js');
  const standardTemplate = source('src/views/event-public.html');
  const flyerTemplate = source('src/views/event-public-flyer.html');
  assert.match(seamlessLoop, /cloneNode\(true\)/);
  assert.match(seamlessLoop, /remaining <= leadSeconds/);
  assert.match(seamlessLoop, /is-seamless-active/);
  assert.match(publicClient, /\['liquid-stardust', 'color-static'\][\s\S]*SGSeamlessVideoLoop/);
  assert.match(ownerClient, /new Set\(\['liquid-stardust', 'color-static'\]\)[\s\S]*SGSeamlessVideoLoop/);
  assert.match(standardTemplate, /\/js\/seamless-video-loop\.js[\s\S]*\/js\/public-event\.js/);
  assert.match(flyerTemplate, /\/js\/seamless-video-loop\.js[\s\S]*\/js\/public-event\.js/);
});

test('After Hours Saloon remains accepted and renders from its dedicated asset', () => {
  assert.match(source('src/routes/events.js'), /'fog', 'saloon'/);
  assert.match(source('src/routes/public.js'), /'fog', 'saloon'/);
  const standardView = source('src/views/event-public.html');
  assert.match(standardView, /sg-events\/backgrounds\/after-hours-saloon\.png/);
  assert.match(standardView, /\.event-bg\.fx-saloon/);
  assert.match(source('public/css/brand.css'), /\.sg-swatch\.fx-saloon/);
});

test('After Hours Saloon readability overrides stay isolated to that effect', () => {
  const publicView = source('src/views/event-public.html');
  assert.match(publicView, /\.event-bg\.fx-saloon ~ \.layout \.desc/);
  assert.match(publicView, /\.fx-veil\.fx-veil-warm/);
  assert.match(publicView, /@media \(max-width: 879px\)/);
  assert.doesNotMatch(publicView, /\.event-bg\.fx-(?:fog|disco|paper) ~ \.layout \.desc/);
});

test('TV Static strengthens typography without adding a theme overlay', () => {
  const publicView = source('src/views/event-public.html');
  assert.match(publicView, /\.event-bg\.fx-static ~ \.layout \.event-title/);
  assert.match(publicView, /font-weight: 800/);
  assert.match(publicView, /--static-text-secondary: rgba\(255,255,255,\.8\)/);
  assert.match(publicView, /--static-text-shadow: 0 1px 2px rgba\(0,0,0,\.9\), 0 0 8px rgba\(0,0,0,\.75\)/);
  assert.match(publicView, /-webkit-text-stroke: \.4px rgba\(0,0,0,\.55\)/);
  assert.match(publicView, /\.event-bg\.fx-static ~ \.layout \.sg-event-legal-footer \.sg-legal-link/);
  assert.doesNotMatch(publicView, /\.fx-veil\.fx-veil-static/);
});
