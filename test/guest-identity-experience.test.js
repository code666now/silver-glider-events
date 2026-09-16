const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('large guest photos are resized without stretching before the bounded avatar upload', () => {
  const optimizer = read('public/js/image-optimizer.js');
  const addPhoto = read('public/js/add-photo.js');
  const settings = read('public/js/settings.js');
  const uploads = read('src/routes/uploads.js');

  assert.match(optimizer, /MAX_SOURCE_BYTES = 20 \* 1024 \* 1024/);
  assert.match(optimizer, /Math\.min\(1, MAX_AVATAR_DIMENSION \/ Math\.max\(loaded\.width, loaded\.height\)\)/);
  assert.match(optimizer, /imageSmoothingQuality = 'high'/);
  assert.match(optimizer, /canvasBlob\(canvas, 'image\/webp', 0\.88\)/);
  assert.match(addPhoto, /SGImageOptimizer\.optimizeAvatar\(file\)/);
  assert.match(settings, /SGImageOptimizer\.optimizeAvatar\(file\)/);
  assert.match(uploads, /handleAvatarUpload/);
  assert.match(uploads, /max 20 MB/);
});

test('photo return context is derived from an RSVP-owned identity, not an arbitrary URL', () => {
  const index = read('src/index.js');
  const page = read('src/views/add-photo.html');

  assert.match(index, /JOIN rsvps r ON r\.event_id=e\.id/);
  assert.match(index, /e\.slug=\$1 AND r\.account_id=\$2/);
  assert.match(index, /\[requestedSlug, req\.organizer\.id\]/);
  assert.match(index, /event \? `\/e\/\$\{encodeURIComponent\(event\.slug\)\}`/);
  assert.match(page, /id="add-photo-back" href="\{\{RETURN_URL\}\}"/);
  assert.match(page, /id="add-photo-success" hidden/);
  assert.match(page, /Returning you automatically/);
});

test('My Events defaults to Going and preserves the complete Hosting workspace', () => {
  const routes = read('src/routes/events.js');
  const page = read('src/views/events.html');

  assert.match(routes, /router\.get\('\/api\/events\/going'/);
  assert.match(routes, /r\.account_id=\$1 AND r\.status='confirmed'/);
  assert.match(routes, /e\.status IN \('published','cancelled'\)/);
  assert.doesNotMatch(routes, /LOWER\(r\.email\).*api\/events\/going/s);
  assert.match(page, /data-view="going">Going</);
  assert.match(page, /data-view="hosting">Hosting</);
  assert.match(page, /activeView = new URLSearchParams[\s\S]*\? 'hosting' : 'going'/);
  assert.match(page, /api\('\/api\/events\/going'\)/);
  assert.match(page, /api\('\/api\/events\?archived=1'\)/);
  assert.match(page, /Events you RSVP to will appear here/);
});

test('only a signed-in matching identity receives the public avatar edit affordance', () => {
  const routes = read('src/routes/public.js');
  const identities = read('src/lib/private-events.js');

  assert.match(routes, /SELECT r\.id, r\.account_id, r\.first_name/);
  assert.match(identities, /identityId: row\.account_id \|\| null/);
  assert.match(routes, /Number\(entry\.identityId\) === Number\(viewerIdentityId\) && viewerIdentityId/);
  assert.match(routes, /class="guest-avatar guest-avatar-edit" href="\/add-photo\?event=/);
  assert.match(routes, /viewerIdentityId: req\.sessionAccount\?\.id/);
});
