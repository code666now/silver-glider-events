const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Collect Photos Beta is additive, event-scoped, and disabled by default', () => {
  const migration = read('src/db/migrations/021_collect_photos_beta.sql');
  const shortLinks = read('src/db/migrations/022_short_photo_links.sql');
  assert.match(migration, /collect_photos_enabled BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(migration, /photo_upload_token TEXT/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS event_photos/);
  assert.match(migration, /event_id\s+INT NOT NULL REFERENCES events\(id\) ON DELETE CASCADE/);
  assert.match(migration, /'photo_request'/);
  assert.doesNotMatch(migration, /ALTER TABLE rsvps ADD|ALTER TABLE organizers ADD/);
  assert.match(shortLinks, /photo_short_token TEXT/);
  assert.match(shortLinks, /events_photo_short_token_uq/);
});

test('public recaps require explicit guest consent and host curation', () => {
  const migration = read('src/db/migrations/023_featured_event_photos.sql');
  const route = read('src/routes/event-photos.js');
  const publicRoute = read('src/routes/public.js');
  const uploadView = read('src/views/event-photo-upload.html');
  const manageClient = read('public/js/manage.js');
  for (const column of ['public_feature_consent', 'is_featured', 'featured_at']) {
    assert.match(migration, new RegExp(column));
  }
  assert.match(migration, /DEFAULT FALSE/);
  assert.match(migration, /CHECK \(is_featured=FALSE OR public_feature_consent=TRUE\)/);
  assert.match(route, /MAX_FEATURED_PHOTOS = 8/);
  assert.match(route, /photos\/:photoId\/feature', requireOrganizer/);
  assert.match(route, /did not permit public featuring/);
  assert.match(uploadView, /name="public_feature_consent" value="true"/);
  assert.doesNotMatch(uploadView, /name="public_feature_consent"[^>]*checked/);
  assert.match(uploadView, /Your name will not be shown publicly/);
  assert.match(manageClient, /Feature on page/);
  assert.match(manageClient, /Remove from page/);
  assert.match(publicRoute, /ep\.is_featured=TRUE AND ep\.public_feature_consent=TRUE/);
  assert.match(publicRoute, />Event photos</);
  assert.doesNotMatch(publicRoute.slice(publicRoute.indexOf('function renderFeaturedPhotos'), publicRoute.indexOf('function setAttendeeCookie')), /contributor_name/);
});

test('Super Admin enables Collect Photos only on an individual published past event', () => {
  const route = read('src/routes/admin.js');
  const view = read('src/views/admin-hosts.html');
  assert.match(route, /router\.patch\('\/api\/admin\/events\/:id\/collect-photos'/);
  assert.match(route, /req\.body\.enabled/);
  assert.match(route, /Collect Photos can only be enabled for published past events/);
  assert.match(route, /COALESCE\(photo_upload_token,\$3\)/);
  assert.match(route, /COALESCE\(photo_short_token,\$4\)/);
  assert.match(view, /data-collect-event/);
  assert.match(view, /Collect Photos: \$\{event\.collect_photos_enabled \? 'On' : 'Off'\}/);
  assert.match(view, /event\.is_past && event\.status === 'published'/);
});

test('public photo collection is private-by-default and bounded', () => {
  const route = read('src/routes/event-photos.js');
  const view = read('src/views/event-photo-upload.html');
  const client = read('public/js/photo-upload.js');
  assert.match(route, /LEGACY_TOKEN_RE = \/\^\[a-f0-9\]\{48\}\$\//);
  assert.match(route, /SHORT_TOKEN_RE = \/\^\[A-Za-z0-9_-\]\{22\}\$\//);
  assert.match(route, /crypto\.randomBytes\(16\)\.toString\('base64url'\)/);
  assert.match(route, /router\.get\(\['\/photos\/:token', '\/p\/:token'\]/);
  assert.match(route, /photo_upload_token=\$1 OR e\.photo_short_token=\$1/);
  assert.match(route, /collect_photos_enabled=TRUE/);
  assert.match(route, /event_date < \(CURRENT_TIMESTAMP AT TIME ZONE e\.timezone\)::date/);
  assert.match(route, /limits: \{ fileSize: 5 \* 1024 \* 1024, files: 5 \}/);
  assert.match(route, /createRateLimiter/);
  assert.match(route, /MAX_PHOTOS_PER_EVENT = 500/);
  assert.match(route, /SELECT id FROM events WHERE id=\$1 FOR UPDATE/);
  assert.match(view, /shared privately with/);
  assert.match(view, /No account needed/);
  assert.match(view, /permission to share them/);
  assert.doesNotMatch(view, /Instagram/);
  assert.match(client, /files\.length > 5/);
  assert.match(client, /new FormData\(form\)/);
});

test('past-event management replaces promotion with one focused collection workflow', () => {
  const view = read('src/views/event-manage.html');
  const client = read('public/js/manage.js');
  assert.match(view, /id="collect-photos-card"/);
  for (const label of ['Ask RSVPs', 'Copy photo link', 'View photos', 'Photos received']) {
    assert.match(view, new RegExp(label));
  }
  assert.match(client, /event\.is_past[\s\S]*\$\('line-card'\)\.style\.display = 'none'/);
  assert.match(client, /eventData\.collect_photos_enabled \? \[loadPhotoCollection\(\)\] : \[\]/);
  assert.match(client, /\/api\/events\/\$\{eventId\}\/photo-request/);
  assert.match(client, /\/photos\/\$\{featureButton\.dataset\.featurePhoto\}\/feature/);
  assert.match(client, /data-delete-photo/);
});

test('photo requests honor RSVP update consent and remain one-shot', () => {
  const route = read('src/routes/event-photos.js');
  const mailer = read('src/lib/mailer.js');
  assert.match(route, /status='confirmed' AND wants_reminders=TRUE/);
  assert.match(route, /photo_request_sent_at IS NULL/);
  assert.match(route, /ON CONFLICT \(rsvp_id, message_type, channel\)[\s\S]*DO NOTHING/);
  assert.match(mailer, /async function sendPhotoRequest/);
  assert.match(mailer, /Share your photos from \$\{event\.title\}/);
  assert.match(mailer, /shared privately with/);
});

test('event photos use the existing Cloudinary boundary and owner-only management routes', () => {
  const cloudinary = read('src/lib/cloudinary.js');
  const route = read('src/routes/event-photos.js');
  assert.match(cloudinary, /sg-events\/event-photos/);
  assert.match(cloudinary, /async function uploadEventPhoto/);
  assert.match(cloudinary, /async function deleteEventPhoto/);
  assert.match(route, /router\.get\('\/api\/events\/:id\/photos', requireOrganizer/);
  assert.match(route, /router\.delete\('\/api\/events\/:eventId\/photos\/:photoId', requireOrganizer/);
  assert.match(route, /e\.organizer_id=\$3/);
});
