const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.SESSION_SECRET ||= 'secret-show-test-session-secret';
const {
  hasUnlockCookie,
  hashCode,
  setUnlockCookie,
  validateCode,
  verifyCode
} = require('../src/lib/secret-show');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('Secret Show codes are exactly six letters or numbers', () => {
  assert.deepEqual(validateCode('ab12cd'), { code: 'AB12CD' });
  assert.ok(validateCode('short').error);
  assert.ok(validateCode('ABC-12').error);
  assert.ok(validateCode('TOO-LONG').error);
});

test('raw Secret Show code is never stored and incorrect codes fail', async () => {
  const hash = await hashCode('AB12CD');
  assert.match(hash, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.equal(hash.includes('AB12CD'), false);
  assert.equal(await verifyCode('ab12cd', hash), true);
  assert.equal(await verifyCode('ZZ99ZZ', hash), false);
});

test('signed unlock persists only for the matching event and code version', () => {
  const headers = [];
  const res = { append(name, value) { headers.push([name, value]); } };
  const event = { id: 41, secret_show_version: 3 };
  setUnlockCookie(res, event);
  const cookie = headers[0][1].split(';')[0];
  const req = { headers: { cookie } };

  assert.equal(hasUnlockCookie(req, event), true);
  assert.equal(hasUnlockCookie(req, { ...event, id: 42 }), false);
  assert.equal(hasUnlockCookie(req, { ...event, secret_show_version: 4 }), false);
});

test('migration keeps Secret Show off by default and credentials separate', () => {
  const migration = source('src/db/migrations/013_secret_show.sql');
  assert.match(migration, /secret_show_enabled BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS event_secret_codes/);
  assert.match(migration, /CHECK \(secret_show_enabled = FALSE OR visibility = 'private'\)/);
  assert.doesNotMatch(migration, /ADD COLUMN IF NOT EXISTS secret_code_hash/);
});

test('server prevents Secret Show on public events and never returns a code hash', () => {
  const eventsRoute = source('src/routes/events.js');
  assert.match(eventsRoute, /secretShowEnabled && out\.visibility !== 'private'/);
  assert.match(eventsRoute, /secretShowEnabled && effectiveVisibility !== 'private'/);
  assert.match(eventsRoute, /INSERT INTO event_secret_codes/);
  assert.match(eventsRoute, /DELETE FROM event_secret_codes WHERE event_id=\$1/);
  assert.doesNotMatch(eventsRoute, /res\.json\([^\n]*code_hash/);
});

test('locked Secret Shows render no private event details before unlock', () => {
  const publicRoute = source('src/routes/public.js');
  const getEvent = publicRoute.slice(publicRoute.indexOf("router.get('/e/:slug'"), publicRoute.indexOf('// GET /api/public/events/:slug/comments'));
  assert.ok(getEvent.indexOf('loadEventAccessEnvelope') < getEvent.indexOf('loadEventBySlug'));
  assert.ok(getEvent.indexOf('secretShowTemplate') < getEvent.indexOf('loadEventBySlug'));
  assert.match(getEvent, /Cache-Control', 'private, no-store'/);

  const template = source('src/views/secret-show.html');
  for (const privateDetail of ['{{TITLE}}', '{{VENUE_NAME}}', '{{DATE_STR}}', '{{EVENT_JSON}}', '{{OG_DESCRIPTION}}']) {
    assert.equal(template.includes(privateDetail), false);
  }
  assert.equal((template.match(/class="code-slot"/g) || []).length, 6);
  assert.match(template, /aria-label="Six-character access code"/);
});

test('unlock is rate-limited and all private social routes require access', () => {
  const publicRoute = source('src/routes/public.js');
  assert.match(publicRoute, /name: 'secret-session-event', max: 6/);
  assert.match(publicRoute, /name: 'secret-ip-event', max: 30/);
  assert.match(publicRoute, /router\.post\('\/api\/public\/events\/:slug\/unlock'/);
  assert.match(publicRoute, /setUnlockCookie\(res, event\)/);

  const guards = publicRoute.match(/secretShowLocked\(req, event\)/g) || [];
  assert.ok(guards.length >= 7, `expected route guards, found ${guards.length}`);
});

test('existing private features remain on the normal event page after unlock', () => {
  const publicRoute = source('src/routes/public.js');
  const getEvent = publicRoute.slice(publicRoute.indexOf("router.get('/e/:slug'"), publicRoute.indexOf('// GET /api/public/events/:slug/comments'));
  for (const feature of ['renderGuestFields(event, { ownerPreview })', 'renderGuestList(event, publicGuestRows, { ownerPreview })', 'renderComments(event, { ownerPreview })', 'data-open-rsvp']) {
    assert.match(getEvent, new RegExp(feature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const eventsRoute = source('src/routes/events.js');
  assert.match(eventsRoute, /secretShowEnabled = req\.body\.secret_show_enabled === undefined/);
  assert.match(eventsRoute, /else if \(!secretShowEnabled\)|else if \(!secretShowEnabled\)/);
});
