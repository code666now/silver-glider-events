const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('the morning-after recap is sent once per event and only when someone came', () => {
  const job = read('src/jobs/host-recap.js');
  const mailer = read('src/lib/mailer.js');
  const index = read('src/index.js');
  const migration = read('src/db/migrations/059_host_recap.sql');

  // Claim-then-send: two passes can never both send.
  assert.match(job, /UPDATE events SET host_recap_sent_at=NOW\(\)\s*\n\s*WHERE id=\$1 AND host_recap_sent_at IS NULL/);
  assert.match(job, /releaseRecap\(event\.id\)/, 'a failed send is retried');
  assert.match(job, /EXISTS \(SELECT 1 FROM rsvps WHERE event_id=e\.id AND status='confirmed'\)/);
  assert.match(job, /e\.event_date = \(\(NOW\(\) AT TIME ZONE e\.timezone\)::date - 1\)/);
  assert.match(job, /REMINDERS_ENABLED === 'false'/);
  assert.match(job, /withActiveHostAccount/, 'a suspended host is never emailed');
  assert.match(job, /FROM user_identities identity/);
  assert.match(job, /identity\.verification_scope='account'/, 'the recipient email is account-verified');
  assert.match(job, /prior_event\.start_time < e\.start_time/, 'same-day earlier events count as prior visits');
  assert.doesNotMatch(job, /o\.email AS host_email/, 'legacy contact email is not a delivery credential');

  // The recap carries the proof number and one way into the next event.
  assert.match(mailer, /async function sendHostRecap\(/);
  assert.match(mailer, /had been to one of your events before/);
  assert.match(mailer, /cta: 'Create your next event'/);
  assert.doesNotMatch(mailer.match(/async function sendHostRecap[\s\S]*?\n}\n/)[0], /See your guest list/,
    'the recap has only the promised next-event action');
  assert.match(index, /require\('\.\/jobs\/host-recap'\)\.startHostRecapCron\(\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS host_recap_sent_at TIMESTAMPTZ/);
});
