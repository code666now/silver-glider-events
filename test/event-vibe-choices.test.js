const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Event Vibe choices extend the existing link without breaking single-link events', () => {
  const migration = read('src/db/migrations/019_event_vibe_choices.sql');
  const events = read('src/routes/events.js');
  const form = read('src/views/event-form.html');
  const formClient = read('public/js/event-form.js');

  assert.match(migration, /ADD COLUMN IF NOT EXISTS event_vibe_label TEXT/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS event_vibe_url_2 TEXT/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS event_vibe_label_2 TEXT/);
  assert.match(events, /event_vibe_label: cleanVibeLabel/);
  assert.match(events, /event_vibe_url_2: cleanVibeUrl/);
  assert.match(events, /e\.event_vibe_label \|\| null, e\.event_vibe_url_2 \|\| null, e\.event_vibe_label_2 \|\| null/);
  assert.match(form, /id="add-vibe-choice"[^>]*>\+ Add another artist</);
  assert.match(form, /id="event_vibe_label" maxlength="80"/);
  assert.match(form, /id="event_vibe_label_2" maxlength="80"/);
  assert.match(formClient, /function setSecondVibeVisible\(visible\)/);
  assert.match(formClient, /event_vibe_url_2: hasSecondVibe/);
  assert.match(formClient, /if \(event\.event_vibe_url_2\)/);
});

test('public Event Vibe switches between labeled artists while loading only one player', () => {
  const route = read('src/routes/public.js');
  const client = read('public/js/public-event.js');
  const standard = read('src/views/event-public.html');
  const flyer = read('public/css/event-public-flyer.css');

  assert.match(route, /function renderVibe\(event\)/);
  assert.match(route, /role="tablist" aria-label="Choose an artist"/);
  assert.equal((route.match(/data-vibe-player/g) || []).length, 1);
  assert.equal((route.match(/data-vibe-template=/g) || []).length, 2);
  assert.match(route, /if \(!secondEmbed \|\| !firstLabel \|\| !secondLabel\)/);
  assert.match(client, /function mountVibeSwitchers\(\)/);
  assert.match(client, /player\.innerHTML = template\.innerHTML/);
  assert.match(client, /choice\.setAttribute\('aria-selected', String\(selected\)\)/);
  assert.doesNotMatch(client, /cloneNode/);
  for (const styles of [standard, flyer]) {
    assert.match(styles, /\.vibe-choice-tabs/);
    assert.match(styles, /\.vibe-choice-tab\.is-active/);
    assert.match(styles, /min-height: 44px/);
  }
});
