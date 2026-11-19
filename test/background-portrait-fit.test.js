const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const portraitThemes = ['snow-day', 'midnight-toast'];
const otherSeasonalThemes = ['rain-on-glass', 'gather-and-glow', 'candlelit-christmas', 'starlit-celebration'];
const publicViews = [
  { name: 'Standard', file: 'src/views/event-public.html', layout: '.layout', details: '.col-details .wrap', credit: '.photo-credit' },
  { name: 'Flyer', file: 'public/css/event-public-flyer.css', layout: '.flyer-layout', details: '.flyer-details', credit: '.flyer-design-credit' }
];

function rules(file) {
  let css = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  if (file.endsWith('.html')) css = [...css.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectorText, body]) => ({
    selectors: selectorText.split(',').map(selector => selector.trim()),
    declarations: Object.fromEntries(body.split(';').map(declaration => {
      const colon = declaration.indexOf(':');
      return colon < 0 ? [] : [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
    }).filter(declaration => declaration.length === 2))
  }));
}

// Merge rules for an exact selector in source order, including grouped selectors.
// Browser QA separately checks the cascade against generic and responsive rules.
function declarations(cssRules, selector) {
  return Object.assign({}, ...cssRules.filter(rule => rule.selectors.includes(selector)).map(rule => rule.declarations));
}

function luminance(gray) {
  const value = gray / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

for (const view of publicViews) {
  test(`${view.name} preserves the full Snow Day and Midnight Toast frames in video and still fallbacks`, () => {
    const cssRules = rules(view.file);
    for (const theme of portraitThemes) {
      const background = declarations(cssRules, `.event-bg.fx-${theme}`);
      assert.equal(background['background-size'], 'contain', `${theme} poster fit`);
      assert.equal(background['background-position'], 'center', `${theme} poster position`);
      assert.equal(background['background-repeat'], 'no-repeat', `${theme} poster does not tile`);
      assert.ok(background['background-image'].includes(`/sg-events/effects/${theme}-v1.jpg`));
      const video = declarations(cssRules, `.event-bg.fx-${theme} .fx-video-media`);
      assert.equal(video['object-fit'], 'contain', `${theme} video fit`);
      assert.equal(video['object-position'], 'center', `${theme} video position`);
    }
  });

  test(`${view.name} lightens only the portrait artwork while backing event text and credits`, () => {
    const cssRules = rules(view.file);
    for (const theme of portraitThemes) {
      const prefix = `.event-bg.fx-${theme}`;
      assert.equal(declarations(cssRules, `${prefix} ~ .fx-veil`).background,
        'linear-gradient(rgba(5,9,12,.18), rgba(5,9,12,.24))');
      const details = declarations(cssRules, `${prefix} ~ ${view.layout} ${view.details}`);
      assert.equal(details.background, 'rgba(14,14,14,.9)');
      assert.equal(details.padding, '24px');
      assert.equal(details['border-radius'], '22px');
      const credit = declarations(cssRules, `${prefix} ~ ${view.layout} ${view.credit}`);
      assert.equal(credit.background, 'rgba(14,14,14,.9)');
      assert.equal(credit.padding, '8px 12px');
      assert.equal(credit['border-radius'], '12px');
      if (view.name === 'Standard') {
        // Switching Standard to Flyer in the live editor creates this caption
        // before the page reloads into the dedicated Flyer template.
        assert.deepEqual(declarations(rules('public/css/event-owner-editor.css'), `${prefix} ~ .layout .flyer-design-credit`), credit);
      }
      const colors = declarations(cssRules, `${prefix} ~ ${view.layout}`);
      assert.equal(colors['--sg-text-dim'], '#b4b4b4');
      assert.equal(colors['--sg-text-faint'], '#b4b4b4');
      // Even white footage behind the panel leaves muted text above 4.5:1.
      const lightestPanel = 14 * 0.9 + 255 * 0.1;
      assert.ok((luminance(180) + 0.05) / (luminance(lightestPanel) + 0.05) >= 4.5);
    }
  });
}

test('full event form portrait swatches show complete, lightly shaded still images', () => {
  const cssRules = rules('public/css/brand.css');
  for (const theme of portraitThemes) {
    const swatch = declarations(cssRules, `.sg-swatch.fx-${theme}`);
    assert.equal(swatch['background-size'], '100% 100%, contain');
    assert.equal(swatch['background-position'], 'center');
    assert.equal(swatch['background-repeat'], 'no-repeat');
    assert.ok(swatch['background-image'].includes('linear-gradient(rgba(5,9,12,.06), rgba(5,9,12,.12))'));
    assert.ok(swatch['background-image'].includes(`/sg-events/effects/${theme}-v1.jpg`));
  }
});

test('owner editor portrait thumbnails retain centered, non-repeating full-frame previews', () => {
  const cssRules = rules('public/css/event-owner-editor.css');
  assert.equal(declarations(cssRules, '.owner-theme-preview').background, '#151515 center/cover no-repeat');
  for (const theme of portraitThemes) {
    const preview = declarations(cssRules, `.owner-theme-${theme}`);
    assert.equal(preview['background-size'], 'contain');
    assert.ok(preview['background-image'].includes(`/sg-events/effects/${theme}-v1.jpg`));
  }
});

test('Background Manager portrait thumbnails contain the whole scene without changing other thumbnails', () => {
  const cssRules = rules('public/css/admin-backgrounds.css');
  assert.equal(declarations(cssRules, '.background-thumbnail img')['object-fit'], 'cover');
  for (const theme of portraitThemes) {
    const thumbnail = declarations(cssRules, `.background-thumbnail[data-theme="${theme}"] img`);
    assert.equal(thumbnail['object-fit'], 'contain');
    assert.equal(thumbnail['object-position'], 'center');
  }
  for (const theme of otherSeasonalThemes) {
    assert.deepEqual(declarations(cssRules, `.background-thumbnail[data-theme="${theme}"] img`), {});
  }
});

test('other seasonal backgrounds keep their cover fit and existing dimming on every picker and public layout', () => {
  const brand = rules('public/css/brand.css');
  const owner = rules('public/css/event-owner-editor.css');
  for (const theme of otherSeasonalThemes) {
    const swatch = declarations(brand, `.sg-swatch.fx-${theme}`);
    assert.equal(swatch['background-size'], 'cover');
    assert.ok(swatch['background-image'].includes('linear-gradient(rgba(5,9,12,.1), rgba(5,9,12,.28))'));
    assert.equal(declarations(owner, `.owner-theme-${theme}`)['background-size'], undefined);
  }
  for (const view of publicViews) {
    const cssRules = rules(view.file);
    assert.equal(declarations(cssRules, '.fx-video-media')['object-fit'], 'cover');
    for (const theme of otherSeasonalThemes) {
      const prefix = `.event-bg.fx-${theme}`;
      assert.equal(declarations(cssRules, prefix)['background-size'], 'cover');
      assert.equal(declarations(cssRules, `${prefix} ~ .fx-veil`).background,
        'linear-gradient(rgba(5,9,12,.82), rgba(5,9,12,.9))');
      assert.deepEqual(declarations(cssRules, `${prefix} .fx-video-media`), {});
      assert.deepEqual(declarations(cssRules, `${prefix} ~ ${view.layout} ${view.details}`), {});
      assert.deepEqual(declarations(cssRules, `${prefix} ~ ${view.layout} ${view.credit}`), {});
    }
    assert.equal(declarations(cssRules, '.event-bg.fx-golden-tide ~ .fx-veil').background,
      'linear-gradient(rgba(5,19,20,.72), rgba(5,19,20,.82))');
  }
});

test('Standard portrait details keep phone gutters and space above the bottom actions', () => {
  const cssRules = rules('src/views/event-public.html');
  for (const theme of portraitThemes) {
    assert.equal(declarations(cssRules, `.event-bg.fx-${theme} ~ .layout .col-details`).padding, '16px 16px 96px');
  }
});
