const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('event management and promotion actions remain clearly separated', () => {
  const view = source('src/views/event-manage.html');
  assert.match(view, /class="sg-shell manage-shell"/);
  assert.match(view, /class="manage-overview"/);
  assert.match(view, /class="manage-guest-section"/);
  assert.match(view, /@media \(min-width: 1024px\)[\s\S]*\.manage-shell\s*\{[\s\S]*max-width:1260px/);
  assert.match(view, /grid-template-columns:minmax\(0,1\.25fr\) minmax\(350px,\.75fr\)/);
  assert.match(view, /@media \(max-width: 620px\)/);
  const toolbar = view.slice(view.indexOf('<div class="toolbar"'), view.indexOf('<section class="promotion-card"'));
  const promotion = view.slice(view.indexOf('<section class="promotion-card"'), view.indexOf('<div class="guest-head">'));

  for (const label of ['Copy event link', 'View page', 'Edit', 'Event actions']) {
    assert.match(toolbar, new RegExp(`\\b${label}\\b`));
    assert.doesNotMatch(promotion, new RegExp(`\\b${label}\\b`));
  }
  for (const label of ['Share event', 'Download QR code', 'Submit to The Line']) {
    assert.match(promotion, new RegExp(label));
    assert.doesNotMatch(toolbar, new RegExp(label));
  }
  assert.match(promotion, /id="announce"/);
  assert.match(promotion, /class="promotion-action-list"/);
  assert.match(promotion, /Send or post your event link/);
  assert.match(promotion, /Use it on posters, flyers, and print/);
  assert.match(promotion, /class="line-feature" id="line-feature"/);
  assert.match(promotion, /Editorial opportunity/);
  assert.doesNotMatch(promotion, /class="promotion-actions"/);
  assert.doesNotMatch(view, /Show QR code/);
  assert.ok(promotion.indexOf('share-event') < promotion.indexOf('download-qr'));
  assert.ok(promotion.indexOf('download-qr') < promotion.indexOf('announce'));
  assert.ok(promotion.indexOf('announce') < promotion.indexOf('line-feature'));
  assert.ok(promotion.indexOf('line-feature') < promotion.indexOf('submit-line'));
});

test('promotion actions share the event and download its existing QR endpoint', () => {
  const client = source('public/js/manage.js');
  assert.match(client, /navigator\.share\(shareData\)/);
  assert.match(client, /fetch\(`\/e\/\$\{eventData\.slug\}\/qr\.png`\)/);
  assert.match(client, /link\.download = `\$\{eventData\.slug\}-qr-code\.png`/);
  assert.match(client, /\$\('line-feature'\)\.style\.display = 'none'/);
  const privateBranch = client.match(/else if \(event\.visibility === 'private'\) \{([\s\S]*?)\n  \}/)[1];
  assert.doesNotMatch(privateBranch, /line-card/);
});

test('management metrics follow public and private event visibility', () => {
  const view = source('src/views/event-manage.html');
  const client = source('public/js/manage.js');
  const stats = view.slice(view.indexOf('<div class="stat-row">'), view.indexOf('<div class="toolbar"'));

  assert.match(stats, /<div class="stat">\s*<strong id="stat-rsvps">/);
  assert.equal((stats.match(/data-private-metric/g) || []).length, 3);
  for (const id of ['stat-attendance', 'stat-guests', 'stat-comments']) {
    assert.match(stats, new RegExp(`data-private-metric[\\s\\S]*?id="${id}"`));
    assert.match(client, new RegExp(`\\$\\('${id}'\\)\\.textContent = event\\.`));
  }
  assert.match(client, /card\.hidden = event\.visibility !== 'private'/);
  assert.match(client, /classList\.toggle\('private-metrics', event\.visibility === 'private'\)/);
  assert.match(client, /\$\('manage-hero-placeholder'\)\.hidden = true/);
});
