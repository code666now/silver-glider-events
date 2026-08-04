const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_ACCENT,
  contrastRatio,
  createEmailTheme,
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
  assert.equal(theme.borderColor, '#292929');

  const invalidTheme = createEmailTheme('not-a-color');
  assert.equal(invalidTheme.accentColor, DEFAULT_ACCENT);
  assert.ok(contrastRatio(invalidTheme.accentColor, invalidTheme.accentTextColor) >= 4.5);
});
