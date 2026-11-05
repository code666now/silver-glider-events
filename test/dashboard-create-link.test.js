const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('Home empty-state creation stays a native, accessible link on phones and desktop', () => {
  const view = read('src/views/dashboard.html');
  assert.match(view, /<a class="dashboard-empty" href="\/events\/new" aria-label="Create your next event">/);
  assert.doesNotMatch(view, /card\.removeAttribute\(['"]href['"]\)/);
  assert.doesNotMatch(view, /card\.removeAttribute\(['"]aria-label['"]\)/);
  assert.doesNotMatch(view, /syncDashboardEmptyCardAction/);
  assert.match(view, /\.dashboard-empty:focus-visible/);
});

test('phone Create tab and desktop create action use the same new-event destination', () => {
  const nav = read('public/js/api.js');
  const view = read('src/views/dashboard.html');
  assert.match(nav, /\['create', '\/events\/new', 'Create'/);
  assert.match(view, /id="dashboard-create"[^>]*href="\/events\/new"/);
});
