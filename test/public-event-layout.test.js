const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('public event sections follow the guest-first vertical hierarchy', () => {
  const view = source('src/views/event-public.html');
  const layout = view.slice(view.indexOf('<div class="layout">'));
  const markers = [
    '{{HERO}}',
    '{{CATEGORY}}',
    '{{TITLE}}',
    '{{DATE_STR}}',
    '{{VENUE_NAME}}',
    '{{TICKET_HTML}}',
    '{{DESCRIPTION_HTML}}',
    '{{VIBE_HTML}}',
    '<div class="rsvp-zone">',
    '{{GUEST_LIST_HTML}}',
    '{{COMMENTS_HTML}}',
    'id="share-btn"',
    '{{PRESENTER_HTML}}',
    'Powered by <a href="/">Silver Glider</a>'
  ];

  for (let index = 1; index < markers.length; index += 1) {
    assert.ok(layout.indexOf(markers[index - 1]) < layout.indexOf(markers[index]), `${markers[index - 1]} should precede ${markers[index]}`);
  }
  assert.match(view, /legal-footer\.js/);
});

test('QR stays available to hosts but is removed from the public event page', () => {
  const view = source('src/views/event-public.html');
  const client = source('public/js/public-event.js');
  const publicRoutes = source('src/routes/public.js');
  const manager = source('public/js/manage.js');

  assert.doesNotMatch(view, /qr-footer|qr-img|Scan to share/);
  assert.doesNotMatch(client, /qr-img|\/qr\.png/);
  assert.match(publicRoutes, /\/e\/:slug\/qr\.png/);
  assert.match(manager, /fetch\(`\/e\/\$\{eventData\.slug\}\/qr\.png`\)/);
});

test('share and calendar remain available after RSVP confirmation', () => {
  const view = source('src/views/event-public.html');
  const client = source('public/js/public-event.js');

  assert.equal((view.match(/id="share-btn"/g) || []).length, 1);
  assert.equal((view.match(/id="cal-btn"/g) || []).length, 1);
  assert.doesNotMatch(view, /success-share|success-cal/);
  assert.match(client, /\$\('cal-btn'\)\.href = icsUrl/);
  assert.match(client, /\$\('share-btn'\)\.addEventListener\('click', share\)/);
});
