const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_ACCENT,
  contrastRatio,
  createEmailTheme,
  paletteForBackground,
  selectAccentColor
} = require('../public/js/artwork-color');

test('artwork accents prefer recognizable color, reject neutrals, and remain accessible', () => {
  const accent = selectAccentColor([
    ['#101014', 0.72],
    ['#E72D88', 0.08],
    ['#C8C8C8', 0.20]
  ]);
  assert.equal(accent, '#E72D88');

  const neutralFallback = selectAccentColor([
    ['#111111', 0.8],
    ['#F2F2F2', 0.2]
  ]);
  assert.equal(neutralFallback, DEFAULT_ACCENT);

  const theme = createEmailTheme(accent);
  assert.equal(theme.accentColor, accent);
  assert.ok(contrastRatio(theme.accentColor, theme.accentTextColor) >= 4.5);
  assert.equal(theme.secondaryAccentColor, '#EB519C');
  assert.ok(contrastRatio(theme.secondaryAccentColor, '#080808') >= 4.5);
  assert.equal(theme.borderColor, '#292929');

  const blueTheme = createEmailTheme('#2F4FC4');
  assert.equal(blueTheme.accentColor, '#2F4FC4');
  assert.notEqual(blueTheme.secondaryAccentColor, blueTheme.accentColor);
  assert.ok(contrastRatio(blueTheme.secondaryAccentColor, '#080808') >= 4.5);

  const invalidTheme = createEmailTheme('not-a-color');
  assert.equal(invalidTheme.accentColor, DEFAULT_ACCENT);
  assert.equal(invalidTheme.secondaryAccentColor, DEFAULT_ACCENT);
  assert.ok(contrastRatio(invalidTheme.accentColor, invalidTheme.accentTextColor) >= 4.5);
});

test('adaptive backgrounds preserve the artwork hue while darkening it for readable pages', () => {
  const colors = paletteForBackground([
    { r: 244, g: 91, b: 22, count: 80 },
    { r: 181, g: 54, b: 13, count: 55 },
    { r: 255, g: 154, b: 54, count: 25 }
  ]);

  assert.equal(colors.length, 3);
  for (const color of colors) {
    assert.ok(color.r > color.g * 1.4, 'orange artwork should keep a strongly red-orange wall');
    assert.ok(color.g > color.b, 'orange artwork should not drift toward purple or blue');
    assert.ok(color.r < 200, 'the page background should be darkened for text contrast');
  }
});
