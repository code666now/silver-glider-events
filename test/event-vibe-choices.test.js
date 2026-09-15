const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Event Vibe progressively supports three artists with optional managed photos', () => {
  const migration = read('src/db/migrations/019_event_vibe_choices.sql');
  const photoMigration = read('src/db/migrations/038_event_vibe_artist_photos.sql');
  const events = read('src/routes/events.js');
  const form = read('src/views/event-form.html');
  const formClient = read('public/js/event-form.js');
  const uploads = read('src/routes/uploads.js');
  const cloudinary = read('src/lib/cloudinary.js');

  assert.match(migration, /ADD COLUMN IF NOT EXISTS event_vibe_label TEXT/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS event_vibe_url_2 TEXT/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS event_vibe_label_2 TEXT/);
  assert.match(photoMigration, /ADD COLUMN IF NOT EXISTS event_vibe_image_url TEXT/);
  assert.match(photoMigration, /ADD COLUMN IF NOT EXISTS event_vibe_image_url_2 TEXT/);
  assert.match(photoMigration, /ADD COLUMN IF NOT EXISTS event_vibe_url_3 TEXT/);
  assert.match(photoMigration, /ADD COLUMN IF NOT EXISTS event_vibe_label_3 TEXT/);
  assert.match(photoMigration, /ADD COLUMN IF NOT EXISTS event_vibe_image_url_3 TEXT/);
  assert.match(events, /event_vibe_label: cleanVibeLabel/);
  assert.match(events, /event_vibe_url_2: cleanVibeUrl/);
  assert.match(events, /event_vibe_url_3: cleanVibeUrl/);
  assert.match(events, /event_vibe_image_url_3: cleanVibeImageUrl/);
  assert.match(events, /e\.event_vibe_url_3 \|\| null, e\.event_vibe_label_3 \|\| null, e\.event_vibe_image_url_3 \|\| null/);
  assert.match(form, /id="add-vibe-choice"[^>]*>\+ Add another artist</);
  assert.match(form, /id="add-third-vibe-choice"[^>]*>\+ Add a third artist</);
  assert.match(form, /id="event_vibe_label" maxlength="80"/);
  assert.match(form, /id="event_vibe_label_2" maxlength="80"/);
  assert.match(form, /id="event_vibe_label_3" maxlength="80"/);
  assert.match(form, /\.vibe-choice-fields\s*\{[\s\S]*?grid-template-columns:\s*1fr/);
  assert.equal((form.match(/Add a photo, a music link, or both\./g) || []).length, 3);
  assert.equal((form.match(/data-vibe-photo-dropzone=/g) || []).length, 3);
  assert.equal((form.match(/Drop an artist photo here/g) || []).length, 3);
  assert.equal((form.match(/The complete image will be shown\./g) || []).length, 3);
  assert.equal((form.match(/event-vibe-photo-replace-/g) || []).length, 3);
  assert.match(formClient, /function setSecondVibeVisible\(visible\)/);
  assert.match(formClient, /function setThirdVibeVisible\(visible\)/);
  assert.match(formClient, /event_vibe_url_3: hasThirdVibe/);
  assert.match(formClient, /fetch\('\/api\/uploads\/vibe-photo'/);
  assert.match(formClient, /VIBE_PHOTO_MAX_BYTES = 5 \* 1024 \* 1024/);
  assert.match(formClient, /dropzone\.addEventListener\('dragover'/);
  assert.match(formClient, /dropzone\.addEventListener\('drop'/);
  assert.match(formClient, /event\.dataTransfer\?\.files\?\.\[0\]/);
  assert.match(formClient, /if \(event\.event_vibe_url_3 \|\| event\.event_vibe_label_3 \|\| event\.event_vibe_image_url_3\)/);
  assert.match(uploads, /router\.post\('\/api\/uploads\/vibe-photo', requireOrganizer/);
  assert.match(cloudinary, /sg-events\/vibes/);
  assert.match(cloudinary, /function isManagedVibePhotoUrl\(value\)/);
});

test('public Event Vibe switches complete artist units and uses photos as YouTube posters', () => {
  const route = read('src/routes/public.js');
  const client = read('public/js/public-event.js');
  const standard = read('src/views/event-public.html');
  const flyer = read('public/css/event-public-flyer.css');

  assert.match(route, /function renderVibe\(event\)/);
  assert.match(route, /function renderVibeEntry\(entry/);
  assert.match(route, /role="tablist" aria-label="Choose an artist"/);
  assert.equal((route.match(/data-vibe-player/g) || []).length, 1);
  assert.match(route, /event\.event_vibe_image_url_3/);
  assert.match(route, /data-vibe-video-play/);
  assert.match(route, /class="vibe-photo-stage"/);
  assert.equal((route.match(/class="vibe-photo-backdrop"/g) || []).length, 2);
  assert.match(route, /class="vibe-video-poster-image"/);
  assert.match(route, /vibeMedia\(entry\.url, \{ autoplay: true \}\)/);
  assert.match(client, /function mountVibeSwitchers\(\)/);
  assert.match(client, /player\.innerHTML = template\.innerHTML/);
  assert.match(client, /closest\('\[data-vibe-video-play\]'\)/);
  assert.match(client, /choice\.setAttribute\('aria-selected', String\(selected\)\)/);
  assert.doesNotMatch(client, /cloneNode/);
  for (const styles of [standard, flyer]) {
    assert.match(styles, /\.vibe-choice-tabs/);
    assert.match(styles, /\.vibe-choice-tab\.is-active/);
    assert.match(styles, /\.vibe-artist-photo/);
    assert.match(styles, /\.vibe-photo-backdrop/);
    assert.match(styles, /\.vibe-video-poster-image/);
    assert.match(styles, /object-fit:\s*contain/);
    assert.match(styles, /filter:\s*blur\(22px\)/);
    assert.match(styles, /\.vibe-video-play-icon/);
    assert.match(styles, /min-height: 44px/);
  }
});
