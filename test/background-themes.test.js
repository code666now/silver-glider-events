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
  assert.match(source('src/routes/public.js'), /sg-events\/backgrounds\/after-hours-saloon\.png/);
  assert.match(source('src/views/event-public.html'), /\.event-bg\.fx-saloon/);
  assert.match(source('public/css/brand.css'), /\.sg-swatch\.fx-saloon/);
});
