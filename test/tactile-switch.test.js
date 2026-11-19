const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = relativePath => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

function switchLabel(html, id) {
  const labels = html.match(/<label\b[^>]*>[\s\S]*?<\/label>/g) || [];
  const label = labels.find(item => item.includes(`id="${id}"`));
  assert.ok(label, `${id} must keep its native clickable label`);
  const input = label.match(new RegExp(`<input\\b[^>]*id="${id}"[^>]*>`))?.[0];
  assert.ok(input, `${id} must remain an input`);
  assert.match(input, /type="checkbox"/);
  assert.match(input, /role="switch"/);
  assert.doesNotMatch(input, /(?:tabindex="-1"|aria-hidden="true"|aria-checked=)/);
  assert.match(label, /^<label\b[^>]*class="[^"]*\bsg-switch-field\b/);
  assert.match(label, /<span class="[^"]*\bsg-switch-track\b[^"]*" aria-hidden="true"><\/span>/);
  assert.match(label, /<strong>[^<]+<\/strong>/);
}

test('event creation uses the shared visual while retaining native labeled switch state', () => {
  const html = read('src/views/event-form.html');
  for (const id of ['hide_address_until_rsvp', 'show_guest_list', 'allow_guests', 'comments_enabled', 'sms_reminder_enabled', 'secret_show_enabled']) {
    switchLabel(html, id);
  }
});

test('owner editor uses the shared visual without replacing its native field contract', () => {
  const renderer = read('src/lib/event-owner-editor.js');
  for (const id of ['owner-hide-address-until-rsvp', 'owner-show-guests', 'owner-allow-guests', 'owner-comments']) {
    switchLabel(renderer, id);
  }
});

test('all four switch contexts load the shared brand stylesheet', () => {
  for (const file of ['src/views/event-form.html', 'src/views/event-public.html', 'src/views/event-public-flyer.html', 'src/views/admin-backgrounds.html', 'src/views/admin-done-for-you.html']) {
    assert.match(read(file), /<link\b[^>]*rel="stylesheet"[^>]*href="\/css\/brand\.css"/);
  }
});

function sharedStyles() {
  const css = read('public/css/brand.css');
  return css.slice(css.indexOf('/* Shared tactile switches.'));
}

function rule(css, selector) {
  const match = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find(item => item[1].split(',').some(part => part.trim() === selector));
  assert.ok(match, `missing shared rule: ${selector}`);
  return Object.fromEntries(match[2].split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const colon = part.indexOf(':');
    return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
  }));
}

test('tactile switch has a fixed track and the approved small, checked, and pressed thumb sizes', () => {
  const css = sharedStyles().split('@media')[0];
  const track = rule(css, '.sg-switch-track');
  const thumb = rule(css, '.sg-switch-track::before');
  const checked = rule(css, '.sg-switch-field input:checked ~ .sg-switch-track');
  const pressed = rule(css, '.sg-switch-field input:enabled:active ~ .sg-switch-track');
  assert.equal(track.width, '52px');
  assert.equal(track.height, '32px');
  assert.equal(track['--sg-switch-thumb-size'], '16px');
  assert.equal(checked['--sg-switch-thumb-size'], '24px');
  assert.equal(pressed['--sg-switch-thumb-size'], '28px');
  assert.equal(thumb.width, 'var(--sg-switch-thumb-size)');
  assert.equal(thumb.height, 'var(--sg-switch-thumb-size)');
  assert.equal(thumb.left, 'var(--sg-switch-thumb-x)');
  assert.equal(thumb.position, 'absolute');
  assert.equal(thumb.transform, 'translate(-50%, -50%)');
  assert.equal(checked.width, undefined, 'checked state must not resize the track');
  assert.equal(pressed.width, undefined, 'pressed state must not resize the track');
  for (const [center, size] of [[16, 16], [36, 24], [16, 28], [36, 28]]) {
    assert.ok(center - size / 2 >= 0 && center + size / 2 <= 52, 'thumb stays inside the stable track');
  }
  assert.equal(track['--sg-switch-thumb-x'], '16px');
  assert.equal(checked['--sg-switch-thumb-x'], '36px');
  assert.deepEqual(checked, rule(css, '.sg-switch-button[aria-checked="true"] .sg-switch-track'));
});

test('checked state reveals a checkmark while keyboard focus and generous button targets remain separate', () => {
  const css = sharedStyles().split('@media')[0];
  assert.equal(rule(css, '.sg-switch-track')['--sg-switch-check-opacity'], '0');
  const checked = rule(css, '.sg-switch-button[aria-checked="true"] .sg-switch-track');
  assert.equal(checked['--sg-switch-check-opacity'], '1');
  assert.equal(checked.background, 'var(--sg-accent)');
  const check = rule(css, '.sg-switch-track::after');
  assert.equal(check.opacity, 'var(--sg-switch-check-opacity)');
  assert.match(check['border-width'], /0 \d+px \d+px 0/);
  assert.match(check.transform, /rotate\(45deg\)/);
  for (const selector of ['.sg-switch-field input:focus-visible ~ .sg-switch-track', '.sg-switch-button:focus-visible']) {
    const focused = rule(css, selector);
    assert.match(focused.outline, /2px solid/);
    assert.equal(focused['outline-offset'], '3px');
  }
  assert.equal(rule(css, '.sg-switch-button')['min-height'], '44px');
});

test('disabled and pending switches cannot show the interactive press expansion', () => {
  const css = sharedStyles().split('@media')[0];
  const enabledPress = '.sg-switch-button:not(:disabled):not([aria-disabled="true"]):active .sg-switch-track';
  assert.equal(rule(css, enabledPress)['--sg-switch-thumb-size'], '28px');
  for (const selector of ['.sg-switch-field input:disabled ~ .sg-switch-track', '.sg-switch-button:disabled .sg-switch-track', '.sg-switch-button[aria-disabled="true"] .sg-switch-track']) {
    assert.equal(rule(css, selector).opacity, '.6');
  }
  assert.equal(rule(css, '.sg-switch-button[aria-disabled="true"]').cursor, 'wait');
});

test('reduced motion removes transitions and press-only growth without hiding checked or focus states', () => {
  const css = sharedStyles();
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?(?=\n@media|$)/)?.[0];
  assert.ok(reduced);
  for (const selector of ['.sg-switch-track', '.sg-switch-track::before', '.sg-switch-track::after']) {
    assert.equal(rule(reduced, selector).transition, 'none');
  }
  assert.equal(rule(reduced, '.sg-switch-field input:enabled:active ~ .sg-switch-track')['--sg-switch-thumb-size'], '16px');
  assert.equal(rule(reduced, '.sg-switch-field input:checked:enabled:active ~ .sg-switch-track')['--sg-switch-thumb-size'], '24px');
  assert.equal(rule(reduced, '.sg-switch-button:not(:disabled):not([aria-disabled="true"]):active .sg-switch-track')['--sg-switch-thumb-size'], '16px');
  assert.equal(rule(reduced, '.sg-switch-button[aria-checked="true"]:not(:disabled):not([aria-disabled="true"]):active .sg-switch-track')['--sg-switch-thumb-size'], '24px');
  assert.doesNotMatch(reduced, /(?:opacity:\s*0|outline:\s*none)/);
});
