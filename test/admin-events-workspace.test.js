const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Admin Events is a protected read-only workspace with the requested filters', () => {
  const index = read('src/index.js');
  const route = read('src/routes/admin.js');
  const html = read('src/views/admin-events.html');

  assert.match(index, /app\.get\('\/admin\/events', requireAdmin, view\('admin-events\.html'\)\)/);
  assert.match(route, /router\.get\('\/api\/admin\/events'/);
  assert.match(route, /router\.use\('\/api\/admin', requireAdmin\)/);
  assert.match(route, /Cache-Control', 'private, no-store'/);
  for (const field of ['event-search', 'event-host', 'event-status', 'event-timing',
    'event-visibility', 'event-admission', 'event-archived']) {
    assert.match(html, new RegExp(`id="${field}"`));
  }
  assert.match(html, /data-admin-section="events"/);
  assert.match(html, /id="events-list" aria-busy="true"/);
  assert.match(html, /id="events-loading"/);
  assert.match(html, /id="events-error"[^>]*hidden/);
  assert.match(html, /id="events-empty"[^>]*hidden/);
  assert.match(html, /<details class="admin-events-more" id="event-more-filters" open>/);
  assert.match(html, /\/css\/admin-events\.css/);
  assert.match(html, /\/js\/admin-events\.js/);
});

test('Admin Events API exposes operational fields without secrets or attendee PII', () => {
  const route = read('src/routes/admin.js');
  const endpoint = route.slice(route.indexOf("router.get('/api/admin/events'"), route.indexOf('// PATCH /api/admin/events/:id/collect-photos'));

  assert.match(endpoint, /e\.id,e\.title,e\.slug,e\.event_date,e\.start_time,e\.timezone/);
  assert.match(endpoint, /r\.status='confirmed'/);
  assert.match(endpoint, /o\.user_id AS owner_user_id/);
  assert.match(endpoint, /admin_done_for_you_clients marker/);
  assert.match(endpoint, /e\.admission_type IN \('external_tickets','paid','donation','door','vip'\)/);
  assert.match(endpoint, /CURRENT_TIMESTAMP AT TIME ZONE e\.timezone/);
  assert.match(endpoint, /ORDER BY e\.event_date DESC,e\.start_time DESC,e\.id DESC/);
  assert.doesNotMatch(endpoint, /SELECT\s+e\.\*/);
  assert.doesNotMatch(endpoint, /photo_upload_token|photo_short_token|secret_show_code|r\.email|r\.phone/);
});

test('Admin Events reuses only the audited Done For You editor and safe destinations', () => {
  const script = read('public/js/admin-events.js');

  assert.match(script, /api\(`\/api\/admin\/events/);
  assert.match(script, /event\.status === 'draft' && event\.done_for_you_client_id && adminEventState\.canManageDoneForYou/);
  assert.match(script, /\/api\/admin\/done-for-you\/\$\{encodeURIComponent\(event\.done_for_you_client_id\)\}\/editor-workspaces/);
  assert.match(script, /body: \{ eventId: event\.id \}/);
  assert.match(script, /href="\/e\/\$\{encodeURIComponent\(event\.slug\)\}"[^>]*target="_blank" rel="noopener"/);
  assert.match(script, /href="\/h\/\$\{encodeURIComponent\(event\.host_slug\)\}"[^>]*target="_blank" rel="noopener"/);
  assert.match(script, /\/admin\/accounts\?q=\$\{encodeURIComponent\(event\.owner_user_id\)\}/);
  assert.match(script, /sgEscapeHtml/);
  assert.doesNotMatch(script, /\/events\/\$\{[^}]+\}\/edit|\?edit=|impersonat|setSessionCookie/i);
});

test('Admin Events mobile cards, detail screen, and loading states stay usable', () => {
  const css = read('public/css/admin-events.css');
  const script = read('public/js/admin-events.js');

  assert.match(css, /\.admin-events-loading\[hidden\][\s\S]*display:none/);
  assert.match(css, /@media \(max-width:960px\)[\s\S]*grid-template-areas/);
  assert.match(css, /@media \(max-width:680px\)[\s\S]*height:100dvh/);
  assert.match(css, /\.admin-events-more:not\(\[open\]\) \.admin-events-more-grid \{ display:none; \}/);
  assert.match(css, /\.admin-event-detail-actions \.sg-btn \{ width:100%;min-height:52px/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)/);
  assert.match(script, /aria-label="Open \$\{adminEventEsc\(event\.title\)\} details"/);
  assert.match(script, /showModal\(\)/);
  assert.match(script, /adminEventState\.trigger\?\.focus/);
  assert.match(script, /event\.key === 'Escape'|addEventListener\('cancel'/);
});
