const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('After Hours Saloon is offered immediately after TV Static', () => {
  const form = source('public/js/event-form.js');
  assert.match(form, /const EFFECTS = \['disco', 'fog', 'paper', 'static', 'saloon'\]/);
  assert.match(form, /saloon: 'After Hours Saloon'/);
});

test('After Hours Saloon is accepted and renders from its dedicated asset', () => {
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
