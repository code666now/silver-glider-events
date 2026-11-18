const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const EventBackgrounds = require('../public/js/event-backgrounds');
const {
  ALWAYS_AVAILABLE_KEYS, backgroundSelectionAllowed, listBackgroundAvailability
} = require('../src/lib/background-availability');

test('background availability keeps the complete rendering catalogue separate from selectable state', async () => {
  const db = { query: async () => ({ rows: [{ background_key: 'disco', active: true }, { background_key: 'halloween', active: false }] }) };
  const result = await listBackgroundAvailability(db);
  assert.deepEqual(result.backgrounds.map(item => item.key), EventBackgrounds.keys);
  assert.ok(result.activeKeys.includes('disco'));
  assert.ok(!result.activeKeys.includes('halloween'));
  assert.ok(!result.activeKeys.includes('fog'), 'unseeded non-default backgrounds fail closed');
  for (const key of ALWAYS_AVAILABLE_KEYS) {
    assert.equal(result.backgrounds.find(item => item.key === key).alwaysAvailable, true);
    assert.ok(result.activeKeys.includes(key));
  }
  assert.ok(EventBackgrounds.keys.includes('halloween'), 'rendering still knows the inactive theme');
});

test('background selection only grandfathers the exact saved key and locks new availability reads', async () => {
  const calls = [];
  const db = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [{ active: false }] }; } };
  assert.equal(await backgroundSelectionAllowed(db, 'halloween', 'halloween'), true);
  assert.equal(await backgroundSelectionAllowed(db, 'midnight'), true);
  assert.equal(await backgroundSelectionAllowed(db, 'invented', 'invented'), false);
  assert.equal(calls.length, 0);
  assert.equal(await backgroundSelectionAllowed(db, 'halloween', 'disco'), false);
  assert.match(calls[0].sql, /FOR SHARE/);
  assert.deepEqual(calls[0].values, ['halloween']);
  assert.equal(await backgroundSelectionAllowed({ query: async () => ({ rows: [{ active: true }] }) }, 'disco'), true);
  assert.equal(await backgroundSelectionAllowed({ query: async () => ({ rows: [] }) }, 'disco'), false);
});

test('background migration seeds every curated key active without rewriting events or assets', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../src/db/migrations/085_background_availability.sql'), 'utf8');
  for (const key of EventBackgrounds.keys) assert.ok(sql.includes(`('${key}')`), `${key} has an active seed`);
  assert.match(sql, /active BOOLEAN NOT NULL DEFAULT TRUE/);
  assert.match(sql, /ON CONFLICT \(background_key\) DO NOTHING/);
  assert.match(sql, /event_background_defaults_active_check/);
  assert.doesNotMatch(sql, /UPDATE\s+events|DELETE\s+FROM|DROP\s+TABLE/i);
});
