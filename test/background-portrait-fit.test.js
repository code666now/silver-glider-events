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
  const result = [];
  function collect(source, media = []) {
    let start = 0;
    while (start < source.length) {
      const open = source.indexOf('{', start);
      if (open < 0) break;
      let end = open + 1;
      let depth = 1;
      for (; end < source.length && depth; end += 1) {
        if (source[end] === '{') depth += 1;
        if (source[end] === '}') depth -= 1;
      }
      assert.equal(depth, 0, `balanced CSS in ${file}`);
      const selectorText = source.slice(start, open).trim();
      const body = source.slice(open + 1, end - 1);
      if (body.includes('{')) {
        collect(body, selectorText.startsWith('@media') ? [...media, selectorText] : media);
      } else {
        result.push({
          selectors: selectorText.split(',').map(selector => selector.trim()),
          media,
          declarations: Object.fromEntries(body.split(';').map(declaration => {
            const colon = declaration.indexOf(':');
            return colon < 0 ? [] : [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
          }).filter(declaration => declaration.length === 2))
        });
      }
      start = end;
    }
  }
  collect(css);
  return result;
}

// Merge exact selectors in source order at the requested viewport. Browser QA
// separately checks generic-selector specificity and real media/rendering state.
function declarations(cssRules, selector, width = 1440) {
  return Object.assign({}, ...cssRules.filter(rule => rule.selectors.includes(selector) && rule.media.every(query => {
    const min = query.match(/min-width:\s*(\d+)px/);
    const max = query.match(/max-width:\s*(\d+)px/);
    return (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
  })).map(rule => rule.declarations));
}

function luminance(gray) {
  const value = gray / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

for (const view of publicViews) {
  test(`${view.name} keeps Starlit Celebration visible without sacrificing event-detail contrast`, () => {
    const cssRules = rules(view.file);
    const prefix = '.event-bg.fx-starlit-celebration';
    for (const width of [390, 1440]) {
      const veil = declarations(cssRules, `${prefix} ~ .fx-veil`, width).background;
      const opacities = [...veil.matchAll(/rgba\(5,9,12,([\d.]+)\)/g)].map(match => Number(match[1]));
      assert.equal(opacities.length, 2);
      assert.ok(opacities.every(opacity => opacity <= 0.25), 'at least 75% of the fireworks show through');
      const details = declarations(cssRules, `${prefix} ~ ${view.layout} ${view.details}`, width);
      const [, alpha] = details['background-color'].match(/^rgba\(5,9,12,([\d.]+)\)$/);
      const lightestBacking = 12 * Number(alpha) + 255 * (1 - Number(alpha));
      assert.ok((luminance(180) + 0.05) / (luminance(lightestBacking) + 0.05) >= 4.5);
      assert.equal(details.padding, undefined, 'the theme does not change the details layout');
      assert.ok(declarations(cssRules, `${prefix} ~ ${view.layout} ${view.credit}`, width)['text-shadow']);
      const artwork = declarations(cssRules, prefix, width);
      assert.ok(artwork['background-image'].includes('/sg-events/effects/starlit-celebration-v1.jpg'));
      assert.equal(artwork['background-size'], 'cover');
      assert.deepEqual(declarations(cssRules, `${prefix} .fx-video-media`, width), {});
    }
  });

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
      assert.equal(details.background, 'rgba(14,14,14,.82)');
      assert.equal(details.padding, '24px');
      assert.equal(details['border-radius'], '22px');
      assert.equal(details['backdrop-filter'], 'blur(20px)');
      assert.equal(details['-webkit-backdrop-filter'], 'blur(20px)');
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
      const lightestPanel = 14 * 0.82 + 255 * 0.18;
      assert.ok((luminance(180) + 0.05) / (luminance(lightestPanel) + 0.05) >= 4.5);
    }
  });

  test(`${view.name} fills desktop side gutters with the existing still poster, not another video`, () => {
    const cssRules = rules(view.file);
    for (const theme of portraitThemes) {
      const prefix = `.event-bg.fx-${theme}`;
      const ambient = declarations(cssRules, `${prefix}::before`);
      assert.equal(ambient.content, "''");
      assert.equal(ambient.position, 'absolute');
      assert.equal(ambient.inset, '-48px');
      assert.equal(ambient['background-image'], 'inherit');
      assert.equal(ambient['background-size'], 'cover');
      assert.equal(ambient['background-position'], 'center');
      assert.equal(ambient.filter, 'blur(36px)');
      assert.equal(ambient.animation, undefined);
      assert.equal(ambient.transition, undefined);
      assert.equal(declarations(cssRules, prefix).animation, 'none');
      assert.equal(declarations(cssRules, prefix).overflow, 'hidden');
      for (const rule of cssRules.filter(rule => rule.selectors.includes(`${prefix}::before`))) {
        assert.ok(rule.media.includes('@media (min-width: 880px)'), 'ambient extension is desktop-only');
      }
    }
  });

  test(`${view.name} aligns and softly blends the full sharp fallback and every video frame on desktop`, () => {
    const cssRules = rules(view.file);
    const frameWidths = { 'snow-day': 'min(100%, 56.25vh)', 'midnight-toast': 'min(100%, 52.65625vh)' };
    const geometry = {
      position: 'absolute', inset: '0 auto 0 50%', width: 'var(--portrait-frame-width)',
      height: '100%', transform: 'translateX(-50%)',
      '-webkit-mask-image': 'linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent)',
      'mask-image': 'linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent)'
    };
    for (const theme of portraitThemes) {
      const prefix = `.event-bg.fx-${theme}`;
      assert.equal(declarations(cssRules, prefix)['--portrait-frame-width'], frameWidths[theme]);
      const still = declarations(cssRules, `${prefix}::after`);
      const video = declarations(cssRules, `${prefix} .fx-video-media`);
      assert.equal(still.content, "''");
      assert.equal(still['background-image'], 'inherit');
      assert.equal(still['background-size'], 'contain');
      assert.equal(still['background-position'], 'center');
      assert.equal(still['background-repeat'], 'no-repeat');
      assert.equal(video['z-index'], '1', 'the existing playing and crossfade videos sit over the still');
      for (const [property, value] of Object.entries(geometry)) {
        assert.equal(still[property], value, `${theme} still ${property}`);
        assert.equal(video[property], value, `${theme} video ${property}`);
      }
      assert.equal(still.filter, undefined, 'only the surround is blurred');
      assert.equal(video.filter, undefined, 'the full original video remains sharp');
      for (const rule of cssRules.filter(rule => rule.selectors.includes(`${prefix}::after`))) {
        assert.ok(rule.media.includes('@media (min-width: 880px)'), 'sharp blend is desktop-only');
      }
    }
  });

  test(`${view.name} keeps phone and tablet portrait framing and text surfaces unchanged`, () => {
    const cssRules = rules(view.file);
    for (const width of [320, 390, 879]) {
      for (const theme of portraitThemes) {
        const prefix = `.event-bg.fx-${theme}`;
        assert.deepEqual(declarations(cssRules, `${prefix}::before`, width), {});
        assert.deepEqual(declarations(cssRules, `${prefix}::after`, width), {});
        assert.equal(declarations(cssRules, prefix, width)['--portrait-frame-width'], undefined);
        assert.deepEqual(declarations(cssRules, `${prefix} .fx-video-media`, width), {
          'object-fit': 'contain', 'object-position': 'center'
        });
        const panel = declarations(cssRules, `${prefix} ~ ${view.layout} ${view.details}`, width);
        assert.equal(panel.background, 'rgba(14,14,14,.9)');
        assert.equal(panel.padding, '24px');
        assert.equal(panel['backdrop-filter'], undefined);
        assert.equal(panel.border, undefined);
      }
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

test('seasonal pickers keep their cover fit, and other seasonal backgrounds keep their existing public dimming', () => {
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
      assert.deepEqual(declarations(cssRules, `${prefix} .fx-video-media`), {});
      assert.deepEqual(declarations(cssRules, `${prefix}::before`), {});
      assert.deepEqual(declarations(cssRules, `${prefix}::after`), {});
      if (theme !== 'starlit-celebration') {
        assert.equal(declarations(cssRules, `${prefix} ~ .fx-veil`).background,
          'linear-gradient(rgba(5,9,12,.82), rgba(5,9,12,.9))');
        assert.deepEqual(declarations(cssRules, `${prefix} ~ ${view.layout} ${view.details}`), {});
        assert.deepEqual(declarations(cssRules, `${prefix} ~ ${view.layout} ${view.credit}`), {});
      }
    }
    assert.equal(declarations(cssRules, '.event-bg.fx-golden-tide ~ .fx-veil').background,
      'linear-gradient(rgba(5,19,20,.72), rgba(5,19,20,.82))');
  }
});

test('Standard portrait details keep phone gutters and space above the bottom actions', () => {
  const cssRules = rules('src/views/event-public.html');
  for (const theme of portraitThemes) {
    assert.equal(declarations(cssRules, `.event-bg.fx-${theme} ~ .layout .col-details`, 390).padding, '16px 16px 96px');
    assert.equal(declarations(cssRules, `.event-bg.fx-${theme} ~ .layout .col-details`).padding, undefined);
  }
});

test('desktop owner preview centers only the two portrait scenes and their veils beside the editor rail', () => {
  const cssRules = rules('public/css/event-owner-editor.css');
  const expected = { right: 'var(--owner-panel-width)' };
  assert.equal(declarations(cssRules, 'body.owner-editor-open')['padding-right'], expected.right);
  for (const theme of portraitThemes) {
    const prefix = `body.owner-editor-open .event-bg.fx-${theme}`;
    assert.deepEqual(declarations(cssRules, prefix), expected);
    assert.deepEqual(declarations(cssRules, `${prefix} ~ .fx-veil`), expected);
    for (const width of [320, 390, 879]) {
      assert.deepEqual(declarations(cssRules, prefix, width), {});
      assert.deepEqual(declarations(cssRules, `${prefix} ~ .fx-veil`, width), {});
    }
  }
  const scopedRules = cssRules.filter(rule => rule.declarations.right === expected.right && rule.selectors.some(selector => selector.includes('.event-bg')));
  assert.equal(scopedRules.length, 1);
  assert.equal(scopedRules[0].selectors.length, 4);
  assert.deepEqual(scopedRules[0].media, ['@media (min-width: 880px)']);
  for (const theme of [...otherSeasonalThemes, 'golden-tide']) {
    assert.deepEqual(declarations(cssRules, `body.owner-editor-open .event-bg.fx-${theme}`), {});
    assert.deepEqual(declarations(cssRules, `body.owner-editor-open .event-bg.fx-${theme} ~ .fx-veil`), {});
  }
});

test('empty Standard desktop artwork blends into portrait scenes without erasing Flyer upload targets', () => {
  const cssRules = rules('src/views/event-public.html');
  const ownerRules = rules('public/css/event-owner-editor.css');
  const flyerRules = rules('public/css/event-public-flyer.css');
  const expected = { background: 'transparent', border: '0', 'box-shadow': 'none' };
  const expectedStandardSelectors = [];
  const expectedOwnerSelectors = [];
  for (const theme of portraitThemes) {
    const prefix = `.event-bg.fx-${theme} ~ .layout`;
    const standardSelector = `${prefix} .hero.no-image:not(.flyer-hero)`;
    expectedStandardSelectors.push(standardSelector);
    assert.deepEqual(declarations(cssRules, standardSelector), expected);
    assert.deepEqual(declarations(cssRules, standardSelector, 390), {});
    assert.deepEqual(declarations(cssRules, `${prefix} .hero.no-image`), {}, 'Standard-to-Flyer preview retains its empty upload target');
    assert.deepEqual(declarations(cssRules, `${prefix} .hero`), {}, 'uploaded artwork is untouched');
    assert.deepEqual(declarations(cssRules, `${prefix} .hero img`), {}, 'uploaded artwork fitting is untouched');

    const flyerPrefix = `.event-bg.fx-${theme} ~ .flyer-layout`;
    const ownerSelector = `body.flyer-public-page.owner-preview-standard ${flyerPrefix} .hero.standard-hero.no-image`;
    expectedOwnerSelectors.push(ownerSelector);
    assert.deepEqual(declarations(ownerRules, ownerSelector), expected, 'Flyer-to-Standard preview receives the same treatment');
    assert.deepEqual(declarations(ownerRules, ownerSelector, 390), {});
    assert.deepEqual(declarations(ownerRules, `${flyerPrefix} .hero.no-image`), {}, 'ordinary Flyer editor remains unchanged');
    assert.deepEqual(declarations(flyerRules, `${flyerPrefix} .hero.no-image`), {}, 'true Flyer placeholder remains unchanged');
    assert.deepEqual(declarations(flyerRules, `${flyerPrefix} .flyer-hero.no-image`), {});
  }
  const themedHeroSelectors = entries => entries.flatMap(rule => rule.selectors.filter(selector =>
    selector.includes('.event-bg.fx-') && selector.includes('.hero')));
  assert.deepEqual(themedHeroSelectors(cssRules), expectedStandardSelectors, 'only non-Flyer Standard placeholders are targeted');
  assert.deepEqual(themedHeroSelectors(ownerRules), expectedOwnerSelectors, 'reverse preview styling requires explicit Standard state');
  assert.deepEqual(themedHeroSelectors(flyerRules), [], 'true Flyer placeholders have no theme-specific override');
  for (const theme of [...otherSeasonalThemes, 'golden-tide']) {
    assert.deepEqual(declarations(cssRules, `.event-bg.fx-${theme} ~ .layout .hero.no-image:not(.flyer-hero)`), {});
  }
});
