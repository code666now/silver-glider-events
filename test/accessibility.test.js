const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// WCAG 2.2 AA contrast: luminance ratio of two #rrggbb colours.
function contrast(a, b) {
  const lum = hex => {
    const [r, g, bl] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('faint text reaches 4.5:1 on every dark surface, footer included', () => {
  const brand = read('public/css/brand.css');
  const token = name => brand.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))[1];
  const faint = token('sg-text-faint');
  for (const surface of ['sg-bg', 'sg-surface', 'sg-card']) {
    assert.ok(contrast(faint, token(surface)) >= 4.5, `faint text on --${surface} is below 4.5:1`);
  }
  const footer = brand.slice(brand.indexOf('.sg-global-footer p {'));
  assert.match(footer.slice(0, footer.indexOf('}')), /color:\s*var\(--sg-text-faint\)/);
});

test('signed-in pages and the event page mark their main content', () => {
  for (const view of ['dashboard', 'events', 'event-manage']) {
    const html = read(`src/views/${view}.html`);
    assert.match(html, /<nav id="nav"><\/nav>\s*<main id="main-content" tabindex="-1">/, `${view} needs a main landmark after the nav`);
    assert.equal((html.match(/<main\b/g) || []).length, 1, `${view} has exactly one main`);
    assert.equal((html.match(/<\/main>/g) || []).length, 1);
  }
  const event = read('src/views/event-public.html');
  assert.match(event, /<main class="layout" id="main-content"/);
  assert.match(event, /<\/main><!-- \/layout -->/);

  const shell = read('public/js/api.js');
  assert.match(shell, /function addSkipLink\(\)/);
  assert.match(shell, /el\.className = 'sg-nav';\s*addSkipLink\(\);/);
  assert.match(read('public/css/brand.css'), /\.sg-skip-link:focus \{ transform: none;/);
});

test('form errors are announced to screen readers', () => {
  assert.match(read('src/views/event-public.html'), /<p id="rsvp-error" role="alert"/);
  assert.match(read('src/views/event-public-flyer.html'), /<p id="rsvp-error" role="alert">/);
  assert.match(read('src/views/event-form.html'), /<p id="error" role="alert"/);
  assert.match(read('public/js/api.js'), /id="feedback-error" role="alert"/);
});

test('the feedback form keeps Tab inside itself while open', () => {
  const shell = read('public/js/api.js');
  const keys = shell.slice(shell.indexOf("if (!modal.classList.contains('open')) return;"));
  assert.match(keys, /e\.key === 'Escape'\) return closeFeedback\(\)/);
  assert.match(keys, /e\.shiftKey && document\.activeElement === first\) \{ e\.preventDefault\(\); last\.focus\(\); \}/);
  assert.match(keys, /!e\.shiftKey && document\.activeElement === last\) \{ e\.preventDefault\(\); first\.focus\(\); \}/);
});

test('Familiar Faces keeps keyboard focus and announces the selection', () => {
  const manage = read('public/js/manage.js');
  const render = manage.slice(manage.indexOf('function renderFamiliarFaces()'), manage.indexOf('function familiarFacesSummary'));
  assert.match(render, /const focusedFace = grid\.contains\(document\.activeElement\)/);
  assert.match(render, /card\.dataset\.familiarFace === focusedFace\)\?\.focus\(\)/);
  assert.match(render, /openGroups\.has\(group\.key\) \? ' open' : ''/, 'a folded group the user opened stays open');

  const start = manage.slice(manage.indexOf('function startFamiliarSelection'), manage.indexOf('function stopFamiliarSelection'));
  assert.match(start, /if \(!initialFaceId\) \$\('familiar-faces-grid'\)\.querySelector\('\[data-familiar-face\]'\)\?\.focus\(\)/);
  const stop = manage.slice(manage.indexOf('function stopFamiliarSelection'), manage.indexOf('async function loadGuests'));
  assert.match(stop, /start\.focus\(\)/);

  const html = read('src/views/event-manage.html');
  assert.match(html, /<strong id="familiar-selected-count" role="status">/);
  assert.match(html, /<strong id="familiar-people-count" role="status">/);
});

test('the Accessibility statement is public and linked wherever Terms is', () => {
  assert.match(read('src/index.js'), /app\.get\('\/accessibility', \(req, res\) => res\.type\('html'\)\.send\(renderLegalPage\('accessibility'\)\)\);/);
  const { renderLegalPage } = require('../src/lib/legal-pages');
  const html = renderLegalPage('accessibility');
  assert.match(html, /<h1>Accessibility<\/h1>/);
  assert.match(html, /WCAG\) 2\.2 at level AA/);
  assert.match(html, /<a href="mailto:support@silverglidertickets\.com">support@silverglidertickets\.com<\/a>/);
  assert.match(html, /<h2 id="tell-us-what-is-not-working">/);
  assert.equal((html.match(/<li>/g) || []).length - 6, 7, 'the seven "done so far" items render as a list beside the six contents links');

  // Every place that links Terms also links Accessibility right after it.
  for (const file of ['public/js/legal-footer.js', 'public/js/api.js', 'src/views/index.html', 'src/views/dashboard.html', 'src/views/invitation-unavailable.html', 'src/views/secret-show.html']) {
    const source = read(file);
    const terms = (source.match(/href="\/terms"/g) || []).length;
    assert.ok(terms > 0, `${file} should link Terms`);
    assert.equal((source.match(/href="\/accessibility"/g) || []).length, terms, `${file} links Terms ${terms}× but Accessibility a different number of times`);
  }
});
