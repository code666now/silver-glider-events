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
  const challenges = source('src/lib/sign-in-challenges.js');
  assert.match(auth, /intent === 'follow_host'/);
  assert.match(auth, /findPublicHost\(pool, body\.host_slug\)/);
  assert.match(auth, /await signInIntent\(req\.body\)/);
  assert.match(challenges, /intent, target_organizer_id, return_path/);
  assert.match(challenges, /PENDING_COLUMNS = '[^']*email, intent, target_organizer_id, return_path, phone_auth_challenge_id[^']*'/);
  assert.match(challenges, /RETURNING \$\{PENDING_COLUMNS\}/);
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
  assert.match(view, /id="follow-returning" hidden/);
  assert.match(view, /Continue as \$\{guest\.firstName\}/);
  assert.match(view, /\/api\/public\/guest-session/);
  assert.match(view, /\/api\/auth\/guest-magic-link/);
  assert.match(view, /Use a different email/);
  assert.match(view, /intent: 'follow_host'/);
  assert.match(view, /id="follow-text-toggle" type="checkbox"/);
  assert.match(view, /Email updates included/);
  assert.match(view, /Reply STOP to opt out/);
  assert.match(view, /method: 'DELETE'/);
  assert.match(view, /\/follow\/texts/);
  assert.match(view, /event\.key === 'Escape'/);
  assert.match(route, /Email updates/);
  assert.match(route, /Optional text updates/);
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
  assert.match(view, /id="following-list" aria-busy="true"/);
  assert.equal((view.match(/following-card following-card-skeleton/g) || []).length, 2);
  assert.match(view, /list\.setAttribute\('aria-busy', 'false'\)/);
  assert.doesNotMatch(view, /Create Event/);
  assert.match(routes, /e\.status='published' AND e\.visibility='public'/);
  assert.match(routes, /e\.event_date >= CURRENT_DATE/);
});

test('new-event updates combine legacy consent and explicit Host follows without changing RSVP', () => {
  const events = source('src/routes/events.js');
  const announcements = source('src/lib/follow-announcement.js');
  const migration = source('src/db/migrations/040_unified_follow_notifications.sql');
  const follows = source('src/lib/host-follows.js');
  assert.match(announcements, /r\.organizer_optin=TRUE/);
  assert.match(announcements, /host_follows/);
  assert.match(announcements, /follower_optouts/);
  assert.match(announcements, /MAX\(r\.created_at\) AS consent_at/);
  assert.match(announcements, /candidate\.consent_at DESC/);
  assert.match(announcements, /createFollowerAnnouncementBatch/);
  assert.match(events, /includeTexts/);
  assert.match(events, /SEND_FOLLOWER_UPDATE/);
  assert.match(migration, /Existing rows are intentionally not backfilled/);
  assert.match(migration, /email_opted_in_at TIMESTAMPTZ/);
  assert.match(migration, /sms_opted_in_at TIMESTAMPTZ/);
  assert.match(follows, /DELETE FROM follower_optouts/);
  assert.match(follows, /INSERT INTO follower_optouts/);
  assert.match(follows, /prepareFollowSmsConsent/);
});

test('Host settings expose one shareable Follow link, not a separate text-signup link', () => {
  const view = source('src/views/settings-v2.html');
  const browser = source('public/js/settings.js');
  assert.match(view, /Share your Follow link/);
  assert.match(browser, /\?follow=1/);
  assert.match(browser, /navigator\.share/);
  assert.doesNotMatch(`${view}\n${browser}`, /text-signup|text_signup|signup-for-text/i);
});

test('Follow sharing uses the native mobile sheet and an accessible desktop menu', () => {
  const view = source('src/views/settings-v2.html');
  const browser = source('public/js/settings.js');
  const styles = source('public/css/settings.css');

  assert.match(view, /<dialog class="host-share-dialog" id="host-follow-share-dialog" aria-modal="true" aria-labelledby="host-follow-share-dialog-title">/);
  assert.match(view, /class="host-share-options" role="group" aria-label="Share Follow link"/);
  for (const option of ['Email', 'Pinterest', 'Facebook', 'X', 'Copy link']) {
    assert.match(view, new RegExp(`>${option}<`));
  }
  assert.match(browser, /matchMedia\('\(hover: none\) and \(pointer: coarse\)'\)/);
  assert.match(browser, /hostFollowNativeShareMedia\.matches[\s\S]*typeof navigator\.share === 'function'/);
  assert.match(browser, /function openHostFollowShareDialog\(\)/);
  assert.match(browser, /https:\/\/www\.pinterest\.com\/pin\/create\/button/);
  assert.match(browser, /https:\/\/www\.facebook\.com\/sharer\/sharer\.php/);
  assert.match(browser, /https:\/\/twitter\.com\/intent\/tweet/);
  assert.match(browser, /document\.execCommand\('copy'\)/);
  assert.match(browser, /window\.requestAnimationFrame\(\(\) => \{[\s\S]*host-follow-share-url'[\s\S]*\.select\(\)/);
  assert.match(browser, /event\.target !== hostFollowShareDialog/);
  assert.match(browser, /event\.key !== 'Escape' \|\| !hostFollowShareDialog\.open/);
  assert.match(browser, /hostFollowShareReturnFocus\?\.focus\(\)/);
  assert.doesNotMatch(browser, /Sharing is unavailable/);
  assert.match(styles, /\.host-share-dialog::backdrop/);
  assert.match(styles, /\.host-share-dialog\[open\] \{ display:flex;flex-direction:column; \}/);
  assert.match(styles, /\.host-share-options \{ min-height:0;overflow-y:auto;/);
  assert.match(styles, /\.host-share-option \{[\s\S]*min-height:72px/);
});

test('follower texts reuse paid batches and STOP disables both RSVP and Follow consent', () => {
  const migration = source('src/db/migrations/040_unified_follow_notifications.sql');
  const job = source('src/jobs/sms-notifications.js');
  const webhook = source('src/routes/sms-notifications.js');
  assert.match(migration, /follower_announcement/);
  assert.match(migration, /host_follow_id BIGINT REFERENCES host_follows/);
  assert.match(job, /batch\.kind === 'follower_announcement'/);
  assert.match(job, /sms_opted_out_at=COALESCE/);
  assert.match(webhook, /UPDATE host_follows SET sms_opted_out_at/);
});
