const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('event management and promotion actions remain clearly separated', () => {
  const view = source('src/views/event-manage.html');
  const toolbar = view.slice(view.indexOf('<div class="toolbar"'), view.indexOf('<section class="promotion-card"'));
  const promotion = view.slice(view.indexOf('<section class="promotion-card"'), view.indexOf('<div class="guest-head">'));

  for (const label of ['Copy event link', 'View page', 'Edit', 'Event actions']) {
    assert.match(toolbar, new RegExp(label));
    assert.doesNotMatch(promotion, new RegExp(label));
  }
  for (const label of ['Share Event', 'Download QR Code', 'Submit to The Line']) {
    assert.match(promotion, new RegExp(label));
    assert.doesNotMatch(toolbar, new RegExp(label));
  }
  assert.match(promotion, /id="announce"/);
  assert.doesNotMatch(view, /Show QR code/);
  assert.ok(promotion.indexOf('share-event') < promotion.indexOf('download-qr'));
  assert.ok(promotion.indexOf('download-qr') < promotion.indexOf('announce'));
  assert.ok(promotion.indexOf('announce') < promotion.indexOf('submit-line'));
});

test('promotion actions share the event and download its existing QR endpoint', () => {
  const client = source('public/js/manage.js');
  assert.match(client, /navigator\.share\(shareData\)/);
  assert.match(client, /fetch\(`\/e\/\$\{eventData\.slug\}\/qr\.png`\)/);
  assert.match(client, /link\.download = `\$\{eventData\.slug\}-qr-code\.png`/);
  assert.match(client, /\$\('submit-line'\)\.style\.display = 'none'/);
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
});
