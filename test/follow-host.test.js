const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('Follow Host migration extends the shared identity and magic-link models safely', () => {
  const migration = source('src/db/migrations/020_follow_host_v1.sql');
  assert.match(migration, /ALTER TABLE magic_link_tokens/);
  assert.match(migration, /intent TEXT NOT NULL DEFAULT 'sign_in'/);
  assert.match(migration, /target_organizer_id INT REFERENCES organizers\(id\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS host_follows/);
  assert.match(migration, /UNIQUE \(follower_organizer_id, host_organizer_id\)/);
  assert.match(migration, /host_follows_not_self/);
  assert.match(migration, /unsubscribed_at\s+TIMESTAMPTZ/);
  assert.match(migration, /source_event_id\s+INT REFERENCES events\(id\) ON DELETE SET NULL/);
  assert.doesNotMatch(migration, /CREATE TABLE (?:users|fans|hosts)/i);
});

test('follow intent is stored server-side and verification completes it transactionally', () => {
  const auth = source('src/routes/auth.js');
  assert.match(auth, /intent === 'follow_host'/);
  assert.match(auth, /findPublicHost\(pool, req\.body\.host_slug\)/);
  assert.match(auth, /target_organizer_id, return_path/);
  assert.match(auth, /RETURNING email, intent, target_organizer_id, return_path/);
  assert.match(auth, /await client\.query\('BEGIN'\)/);
  assert.match(auth, /await followHost\(client, organizer\.id, pending\.target_organizer_id\)/);
  assert.match(auth, /await client\.query\('COMMIT'\)/);
  assert.doesNotMatch(auth, /intent=\$\{|host_id=\$\{/);
});

test('public Host Page offers an explicit accessible follow flow without replacing event actions', () => {
  const view = source('src/views/host-public.html');
  const route = source('src/routes/public-hosts.js');
  assert.match(view, /data-host-follow/);
  assert.match(view, /id="follow-modal" role="dialog" aria-modal="true"/);
  assert.match(view, /Enter your email to follow\./);
  assert.match(view, /intent: 'follow_host'/);
  assert.match(view, /method: following \? 'DELETE' : 'POST'/);
  assert.match(view, /event\.key === 'Escape'/);
  assert.match(route, /Save this host and see their upcoming shows in Following\./);
  assert.match(route, /: 'Follow'/);
  assert.match(route, /Following <span aria-hidden="true">✓<\/span>/);
  assert.match(view, /Upcoming Events/);
  assert.match(view, /Past Events/);
});

test('Following is a lightweight authenticated list in the shared navigation', () => {
  const view = source('src/views/following.html');
  const nav = source('public/js/api.js');
  const routes = source('src/routes/follows.js');
  assert.match(nav, /\['following', '\/following', 'Following'\]/);
  assert.match(view, /renderNav\('following'\)/);
  assert.match(view, /Hosts you follow will appear here\./);
  assert.match(view, /upcoming.*show/);
  assert.doesNotMatch(view, /Create Event/);
  assert.match(routes, /e\.status='published' AND e\.visibility='public'/);
  assert.match(routes, /e\.event_date >= CURRENT_DATE/);
});

test('legacy RSVP follower announcements remain separate from authenticated Host follows', () => {
  const events = source('src/routes/events.js');
  assert.match(events, /r\.organizer_optin = TRUE/);
  assert.match(events, /follower_optouts/);
  assert.doesNotMatch(events.slice(events.indexOf("router.get('/api/events/:id/followers'")), /host_follows/);
});
