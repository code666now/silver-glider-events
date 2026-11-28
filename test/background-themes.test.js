const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const seasonalVideos = [
  'rain-on-glass', 'gather-and-glow', 'candlelit-christmas',
  'snow-day', 'midnight-toast', 'starlit-celebration'
];

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('all editors use one ordered background catalog with contextual artwork matching', () => {
  const form = source('public/js/event-form.js');
  const ownerRenderer = source('src/lib/event-owner-editor.js');
  const catalog = require('../public/js/event-backgrounds');
  assert.deepEqual(catalog.backgroundKeys, ['adaptive', 'midnight', 'aurora', 'sunset', 'ocean', 'plaster']);
  assert.deepEqual(catalog.effectKeys, ['halloween', 'last-guest', 'disco', 'fog', 'paper', 'static', 'liquid-stardust', 'color-static', 'saloon', 'golden-tide', ...seasonalVideos]);
  assert.equal(catalog.label('adaptive', 'standard'), 'Match Photo');
  assert.equal(catalog.label('adaptive', 'flyer'), 'Match Flyer');
  assert.match(form, /const EventBackgrounds = window\.SGEventBackgrounds/);
  assert.match(ownerRenderer, /EventBackgrounds\.options\.filter/);
  assert.match(ownerRenderer, /data-standard-label="\$\{label\}" data-flyer-label="\$\{flyerLabel \|\| label\}"/);
});

test('curated background thumbnails are still images, not autoplay media', () => {
  const catalog = require('../public/js/event-backgrounds');
  for (const option of catalog.options) {
    if (['adaptive', 'midnight', 'aurora', 'sunset', 'ocean', 'static'].includes(option.key)) continue;
    assert.ok(option.thumbnail, `${option.key} has a thumbnail`);
    assert.match(option.thumbnail, /\.(?:jpg|png|webp)$/);
    assert.doesNotMatch(option.thumbnail, /\.mp4|\.gif/);
    assert.ok(Object.isFrozen(option));
  }
});

test('Match Photo reuses the artwork palette as an explicit adaptive background', () => {
  const form = source('public/js/event-form.js');
  const ownerRenderer = source('src/lib/event-owner-editor.js');
  const ownerClient = source('public/js/event-owner-editor.js');
  const publicClient = source('public/js/public-event.js');
  const publicRoute = source('src/routes/public.js');
  const eventEditor = source('src/lib/event-editor.js');
  const brand = source('public/css/brand.css');

  assert.match(form, /function updateAdaptiveThemeSwatch\(colors\)/);
  assert.match(form, /updateAdaptiveThemeSwatch\(ArtworkColor\.paletteForBackground\(candidates\)\)/);
  assert.match(ownerRenderer, /EventBackgrounds\.options\.filter/);
  assert.match(ownerClient, /if \(pageBackground && draft\.backgroundTheme === 'adaptive'\)/);
  assert.match(ownerClient, /background\.classList\.add\('image-palette'\)/);
  assert.match(publicClient, /if \(EVENT\.adaptiveBackground\)/);
  assert.match(publicClient, /background\.classList\.add\('image-palette'\)/);
  assert.match(publicRoute, /adaptiveBackground: theme === 'adaptive'/);
  assert.match(eventEditor, /const THEMES = EventBackgrounds\.keys/);
  assert.match(brand, /\.sg-swatch\.bg-adaptive/);
  assert.match(brand, /\.bg-adaptive/);
  const paletteSource = publicClient.slice(publicClient.indexOf('async function applyCoverPalette'), publicClient.indexOf('function applyStandardMobileCoverFit'));
  assert.doesNotMatch(paletteSource, /flyer-public-page'\)\) return/);
});

test('seasonal video effects are accepted and render from dedicated assets', () => {
  const catalog = require('../public/js/event-backgrounds');
  for (const effect of ['halloween', 'liquid-stardust', 'color-static', 'last-guest']) assert.ok(catalog.effectKeys.includes(effect));
  const publicRoute = source('src/lib/event-background-render.js');
  assert.match(publicRoute, /halloween: 'sg-events\/effects\/halloween'/);
  assert.match(publicRoute, /'liquid-stardust': 'sg-events\/effects\/liquid-stardust'/);
  assert.match(publicRoute, /'color-static': 'sg-events\/effects\/color-static'/);
  assert.match(publicRoute, /'last-guest': 'sg-events\/effects\/the-last-guest'/);
  assert.match(source('public/js/public-event.js'), /\['halloween', 'liquid-stardust', 'color-static', 'last-guest', 'disco', 'fog', 'golden-tide',/);

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

test('the shared renderer supplies the preview and live backgrounds for every catalog choice', () => {
  const { renderEventBackground } = require('../src/lib/event-background-render');
  const { options } = require('../public/js/event-backgrounds');
  for (const option of options) {
    const appearance = renderEventBackground(option.key);
    const hasVideo = option.thumbnail?.includes('/video/upload/') === true;
    assert.equal(appearance.fxMedia.includes('<video '), hasVideo, option.key);
    assert.equal(appearance.bgClass, `${option.group === 'effect' ? 'fx' : 'bg'}-${option.key}`);
    assert.equal(appearance.bgEffect, option.group === 'effect' ? option.key : null);
    if (hasVideo) {
      assert.ok(appearance.fxMedia.includes(option.thumbnail.split('/').at(-1).replace('.jpg', '.mp4')));
      assert.match(appearance.fxMedia, /preload="auto"[^>]+poster="https:\/\/res\.cloudinary\.com/);
    }
    assert.equal(appearance.fxVeil.includes(' hidden>'), option.group !== 'effect');
  }
  assert.equal(renderEventBackground('unknown').bgClass, 'bg-midnight');
  assert.equal(renderEventBackground('violet').bgClass, 'bg-violet');
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
  assert.match(publicClient, /\['liquid-stardust', 'color-static', 'golden-tide',[\s\S]*SGSeamlessVideoLoop/);
  assert.match(ownerClient, /new Set\(\['liquid-stardust', 'color-static', 'golden-tide',[\s\S]*SGSeamlessVideoLoop/);
  assert.match(standardTemplate, /\/js\/seamless-video-loop\.js[\s\S]*\/js\/public-event\.js/);
  assert.match(flyerTemplate, /\/js\/seamless-video-loop\.js[\s\S]*\/js\/public-event\.js/);
});

test('After Hours Saloon remains accepted and renders from its dedicated asset', () => {
  const catalog = require('../public/js/event-backgrounds');
  assert.ok(catalog.effectKeys.includes('saloon'));
  assert.match(source('src/lib/event-editor.js'), /const THEMES = EventBackgrounds\.keys/);
  assert.match(source('src/lib/event-background-render.js'), /const EFFECTS = EventBackgrounds\.effectKeys/);
  const standardView = source('src/views/event-public.html');
  assert.match(standardView, /sg-events\/backgrounds\/after-hours-saloon\.png/);
  assert.match(standardView, /\.event-bg\.fx-saloon/);
  assert.match(source('public/css/brand.css'), /\.sg-swatch\.fx-saloon/);
});

test('Golden Tide is selectable with video, poster and isolated readability treatment everywhere', () => {
  const catalog = require('../public/js/event-backgrounds');
  assert.equal(catalog.label('golden-tide'), 'Golden Tide');
  assert.ok(catalog.effectKeys.includes('golden-tide'));
  for (const file of ['src/lib/event-background-render.js', 'public/js/event-owner-editor.js']) {
    assert.match(source(file), /'golden-tide': 'sg-events\/effects\/golden-tide'/);
  }
  for (const file of ['src/views/event-public.html', 'public/css/event-public-flyer.css']) {
    assert.match(source(file), /\.event-bg\.fx-golden-tide/);
    assert.match(source(file), /\.event-bg\.fx-golden-tide ~ \.fx-veil/);
    assert.match(source(file), /sg-events\/effects\/golden-tide\.jpg/);
    assert.match(source(file), /prefers-reduced-motion: reduce/);
  }
  assert.match(source('public/css/brand.css'), /\.sg-swatch\.fx-golden-tide/);
  assert.match(source('public/css/event-owner-editor.css'), /\.owner-theme-golden-tide/);
  assert.match(source('src/lib/event-background-render.js'), /\['golden-tide',[^\]]+\]\.includes\(theme\) \? 'du_20,' : ''/);
  assert.match(source('public/js/event-owner-editor.js'), /seamlessVideoEffects\.has\(theme\) && !constrainedAmbientVideo/);
  for (const file of ['src/routes/public-hosts.js', 'src/lib/mailer.js']) {
    assert.match(source(file), /sg-events\/effects\/golden-tide\.jpg/);
  }
});

test('After Hours Saloon readability overrides stay isolated to that effect', () => {
  const publicView = source('src/views/event-public.html');
  assert.match(publicView, /\.event-bg\.fx-saloon ~ \.layout \.desc/);
  assert.match(publicView, /\.fx-veil\.fx-veil-warm/);
  assert.match(publicView, /@media \(max-width: 879px\)/);
  assert.doesNotMatch(publicView, /\.event-bg\.fx-(?:fog|disco|paper) ~ \.layout \.desc/);
});

test('six curated videos have versioned assets, mobile playback and still fallbacks in every surface', () => {
  const catalog = require('../public/js/event-backgrounds');
  const labels = ['Rain on Glass', 'Gather & Glow', 'Candlelit Christmas', 'Snow Day', 'Midnight Toast', 'Starlit Celebration'];
  for (const [index, key] of seasonalVideos.entries()) {
    assert.equal(catalog.label(key), labels[index]);
    assert.ok(catalog.effectKeys.includes(key));
    for (const file of ['src/lib/event-background-render.js', 'public/js/event-owner-editor.js']) {
      assert.ok(source(file).includes(`'${key}': 'sg-events/effects/${key}-v1'`));
    }
    for (const file of ['src/views/event-public.html', 'public/css/event-public-flyer.css']) {
      const css = source(file);
      assert.ok(css.includes(`.event-bg.fx-${key} {`));
      assert.ok(css.includes(`.event-bg.fx-${key} ~ .fx-veil`));
      assert.ok(css.includes(`sg-events/effects/${key}-v1.jpg`));
      assert.match(css, /linear-gradient\(rgba\(5,9,12,\.82\), rgba\(5,9,12,\.9\)\)/);
      assert.match(css, /--sg-text-faint: #b4b4b4/);
    }
    assert.ok(source('public/css/brand.css').includes(`.sg-swatch.fx-${key}`));
    assert.ok(source('public/css/event-owner-editor.css').includes(`.owner-theme-${key}`));
    for (const file of ['src/routes/public-hosts.js', 'src/lib/mailer.js']) {
      assert.ok(source(file).includes(`sg-events/effects/${key}-v1.jpg`));
    }
  }
  assert.match(source('src/lib/event-background-render.js'), /w_800,c_limit,fl_progressive/);
  assert.match(source('src/lib/event-background-render.js'), /w_1280,c_limit,fl_progressive/);
  assert.match(source('public/js/event-owner-editor.js'), /compactAmbientVideo && matchMedia\('\(max-width: 900px\)'\)\.matches \? 800 : 1280/);
  assert.match(source('public/js/event-owner-editor.js'), /compactAmbientVideo \? 'du_20,' : ''/);
});

test('new background fallback email artwork never embeds video and respects uploaded artwork', () => {
  const { renderRsvpConfirmationEmail } = require('../src/lib/mailer');
  const rsvp = { name: 'Sample Guest', manage_token: 'sample-guest-list-link', wants_reminders: true };
  for (const key of seasonalVideos) {
    const event = { title: 'A sample evening', slug: 'sample-evening', background_theme: key, event_date: '2026-12-20', start_time: '19:00', timezone: 'America/Los_Angeles' };
    const html = renderRsvpConfirmationEmail({ event, rsvp });
    assert.ok(html.includes(`sg-events/effects/${key}-v1.jpg`));
    assert.doesNotMatch(html, /<video|\.mp4|\.gif/);
    const withArtwork = renderRsvpConfirmationEmail({ event: { ...event, cover_image_url: 'https://example.com/sample-art.jpg' }, rsvp });
    assert.match(withArtwork, /https:\/\/example\.com\/sample-art\.jpg/);
    assert.ok(!withArtwork.includes(`sg-events/effects/${key}-v1.jpg`));
  }
});

function mountVideoFixture(theme, { mobile = false, reducedMotion = false, saveData = false } = {}) {
  const js = source('public/js/public-event.js');
  const start = js.indexOf('function mountVideoEffect() {');
  const end = js.indexOf('\nmountVideoEffect();', start);
  const state = { plays: 0, pauses: 0, crossfades: 0, removedAutoplay: false };
  const video = {
    paused: true, readyState: 0, loop: true,
    classList: { add() {} },
    addEventListener() {},
    removeAttribute(name) { if (name === 'autoplay') state.removedAutoplay = true; },
    play() { state.plays += 1; return Promise.resolve(); },
    pause() { state.pauses += 1; }
  };
  const context = {
    EVENT: { bgEffect: theme },
    navigator: { connection: { saveData }, hardwareConcurrency: 8 },
    matchMedia(query) { return { matches: query.includes('prefers-reduced-motion') ? reducedMotion : mobile, addEventListener() {} }; },
    document: { hidden: false, querySelector() { return video; }, addEventListener() {}, removeEventListener() {} },
    window: { SGSeamlessVideoLoop: { attach() { state.crossfades += 1; return { play: () => video.play(), pause: () => video.pause() }; } } }
  };
  vm.runInNewContext(`${js.slice(start, end)}\nmountVideoEffect();`, context);
  return { state, video };
}

test('new seasonal videos use desktop crossfade, single-decoder mobile loops and motion/data-saving posters', () => {
  for (const key of seasonalVideos) {
    const desktop = mountVideoFixture(key);
    assert.equal(desktop.state.plays, 1, `${key} desktop plays`);
    assert.equal(desktop.state.crossfades, 1);
    assert.equal(desktop.video.muted, true);
    const phone = mountVideoFixture(key, { mobile: true });
    assert.equal(phone.state.plays, 1, `${key} mobile plays`);
    assert.equal(phone.state.crossfades, 0);
    assert.equal(phone.video.loop, true);
    for (const preference of [{ reducedMotion: true }, { saveData: true }]) {
      const still = mountVideoFixture(key, preference);
      assert.equal(still.state.plays, 0, `${key} preference keeps poster`);
      assert.equal(still.state.pauses, 1);
      assert.equal(still.state.crossfades, 0);
      assert.equal(still.state.removedAutoplay, true);
    }
  }
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
