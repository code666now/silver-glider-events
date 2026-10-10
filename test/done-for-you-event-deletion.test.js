const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('deleting a Done For You event detaches its durable flyer submission', () => {
  const migration = read('src/db/migrations/069_done_for_you_event_deletion.sql');

  assert.match(migration, /DROP CONSTRAINT IF EXISTS admin_flyer_requests_event_id_fkey/);
  assert.match(
    migration,
    /FOREIGN KEY \(event_id\) REFERENCES events\(id\) ON DELETE SET NULL/
  );
  assert.doesNotMatch(
    migration,
    /FOREIGN KEY \(event_id\) REFERENCES events\(id\) ON DELETE CASCADE/
  );
});
