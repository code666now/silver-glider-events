const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.SESSION_SECRET ||= 'address-privacy-editor-test-secret';

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const {
  EDITOR_EVENT_FIELDS,
  createEventInTransaction,
  toEditorEventDto,
  validateEventBody
} = require('../src/lib/event-editor');

test('address privacy schema is additive and defaults existing events to visible', () => {
  const migration = read('src/db/migrations/070_private_event_address_privacy.sql');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS hide_address_until_rsvp BOOLEAN NOT NULL DEFAULT FALSE/);
});

test('event editor accepts, compares, and returns the address privacy preference', () => {
  assert.ok(EDITOR_EVENT_FIELDS.includes('hide_address_until_rsvp'));
  assert.equal(validateEventBody({ hide_address_until_rsvp: true }, { partial: true }).out.hide_address_until_rsvp, true);
  assert.equal(validateEventBody({ hide_address_until_rsvp: false }, { partial: true }).out.hide_address_until_rsvp, false);
  assert.equal(validateEventBody({ hide_address_until_rsvp: 'true' }, { partial: true }).out.hide_address_until_rsvp, true);
  assert.equal(toEditorEventDto({ id: 7, hide_address_until_rsvp: true }).hide_address_until_rsvp, true);
});

test('event creation persists the address privacy preference without shifting insert values', async () => {
  let insert;
  const db = {
    async query(sql, params) {
      insert = { sql, params };
      return { rows: [{ id: 7, title: 'Private gathering', hide_address_until_rsvp: true }] };
    }
  };
  const result = await createEventInTransaction(db, {
    organizerId: 4,
    body: {
      title: 'Private gathering',
      event_date: '2032-06-14',
      start_time: '19:00',
      venue_name: 'The Secret Garden',
      visibility: 'private',
      admission_type: 'free_rsvp',
      hide_address_until_rsvp: true
    }
  });
  const columnList = insert.sql.match(/INSERT INTO events \(([\s\S]*?)\)\s+VALUES/)[1]
    .split(',')
    .map(value => value.trim());
  assert.equal(insert.params.length, columnList.length);
  assert.equal(insert.params[columnList.indexOf('hide_address_until_rsvp')], true);
  assert.equal(result.event.hide_address_until_rsvp, true);
});

test('full editor presents location privacy under Visibility and preserves it while inactive', () => {
  const html = read('src/views/event-form.html');
  const client = read('public/js/event-form.js');
  assert.match(html, /id="location-privacy-settings"[^>]+data-mobile-flow-panel="visibility"[^>]+hidden/);
  assert.match(html, /\.location-privacy-settings\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*;?\s*\}/);
  assert.match(html, /Location privacy[\s\S]*Reveal exact location after RSVP/);
  assert.match(html, /Before RSVP, location fields show only the city and state\./);
  assert.match(html, /Artwork and description remain visible, so leave the exact address out of them\./);
  assert.match(html, /id="hide_address_until_rsvp" role="switch"/);
  assert.match(client, /location-privacy-settings'\)\.hidden = !\(visibility === 'private' && admissionType === 'free_rsvp'\)/);
  assert.match(client, /hide_address_until_rsvp: \$\('hide_address_until_rsvp'\)\.checked/);
  assert.match(client, /\$\('hide_address_until_rsvp'\)\.checked = event\.hide_address_until_rsvp === true/);
  assert.doesNotMatch(client, /hide_address_until_rsvp'\)\.checked = false/);
  assert.match(client, /Address after RSVP/);
});

test('owner editor wires the same private free-RSVP control and duplicate keeps the preference', () => {
  const renderer = read('src/lib/event-owner-editor.js');
  const client = read('public/js/event-owner-editor.js');
  const route = read('src/routes/events.js');
  assert.match(renderer, /hideAddressUntilRsvp: event\.hide_address_until_rsvp === true/);
  assert.match(renderer, /id="owner-location-privacy"[\s\S]*Reveal exact location after RSVP/);
  assert.match(renderer, /Artwork and description remain visible, so leave the exact address out of them\./);
  assert.match(renderer, /id="owner-hide-address-until-rsvp"[^>]+role="switch"/);
  assert.match(client, /owner-location-privacy'\)\.hidden = !\(draft\.visibility === 'private' && draft\.admissionType === 'free_rsvp'\)/);
  assert.match(client, /hide_address_until_rsvp: draft\.hideAddressUntilRsvp/);
  assert.doesNotMatch(client, /hideAddressUntilRsvp = false/);
  assert.match(route, /hide_address_until_rsvp, commerce_event_id/);
  assert.match(route, /e\.artwork_accent_color \|\| null, e\.hide_address_until_rsvp === true/);
});
