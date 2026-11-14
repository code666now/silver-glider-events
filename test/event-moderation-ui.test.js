const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Admin → Events shows a Safety section with confirmed, reasoned, reversible actions', () => {
  const view = read('src/views/admin-events.html');
  assert.match(view, /<section class="admin-event-safety" id="event-safety" aria-labelledby="admin-safety-title" hidden>/);
  assert.match(view, /<option value="hidden">/i);
  assert.ok(view.indexOf('/js/admin-event-safety.js') < view.indexOf('/js/admin-events.js'));

  const safety = read('public/js/admin-event-safety.js');
  for (const path of ['/images/remove', '/hide', '/unhide', '/restore', '/retry']) assert.ok(safety.includes(path), path);
  assert.match(safety, /confirm: true/);
  assert.match(safety, /required minlength="3"/);
  assert.match(safety, /role="alert"/);
  assert.match(safety, /Only Super Admins can remove images or hide events\./);

  const events = read('public/js/admin-events.js');
  assert.match(events, /moderateEvents/);
  assert.match(events, /params\.get\('event'\)/);
});

test('organizers see a short notice, never the reason', () => {
  assert.match(read('src/views/event-manage.html'), /id="moderation-notice" role="status" hidden/);
  const manage = read('public/js/manage.js');
  assert.match(manage, /Silver Glider has hidden this event/);
  assert.match(manage, /An image on this event was removed by Silver Glider/);
  assert.doesNotMatch(manage, /hidden_reason|hiddenReason/);
});

test('an admin already signed in passes straight through the sign-in page from an email link', () => {
  const login = read('src/views/admin-login.html');
  assert.match(login, /fetch\('\/api\/admin\/auth\/me'[^)]*\)\s*\.then\(response => \{ if \(response\.ok\) location\.replace\(next\); \}\)/);
});
