const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  canonicalRelationshipReport,
  relationshipReportHasDrift
} = require('../src/lib/canonical-relationships');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const migration = read('src/db/migrations/044_canonical_user_relationship_bridge.sql');
const messageConflictMigration = read('src/db/migrations/045_canonical_message_relationship_conflicts.sql');

test('canonical relationship bridge is additive, nullable, and keeps profile ownership distinct', () => {
  const expected = [
    ['rsvps', 'user_id'],
    ['guest_sessions', 'user_id'],
    ['guest_invitation_tokens', 'user_id'],
    ['message_log', 'recipient_user_id'],
    ['host_follows', 'follower_user_id'],
    ['event_photos', 'uploader_user_id']
  ];
  for (const [table, column] of expected) {
    assert.match(migration, new RegExp(
      `ALTER TABLE ${table}[\\s\\S]*?ADD COLUMN IF NOT EXISTS ${column} INTEGER REFERENCES users\\(id\\) ON DELETE SET NULL`
    ));
    assert.doesNotMatch(migration, new RegExp(`${column} INTEGER NOT NULL`));
  }
  assert.doesNotMatch(migration, /DROP (?:TABLE|COLUMN)|ALTER COLUMN .* SET NOT NULL/i);
  assert.doesNotMatch(migration, /host_user_id/,
    'the followed Host Page remains an organizer/profile property, not a person relationship');
  assert.match(migration, /host_organizer_id intentionally remains the followed Host Page\/profile/);
});

test('historical links use exact legacy owners and quarantine RSVP disagreement', () => {
  const backfill = migration.slice(
    migration.indexOf('UPDATE guest_sessions'),
    migration.indexOf('CREATE INDEX IF NOT EXISTS rsvps_event_user_idx')
  );
  assert.match(migration, /organizer\.id = session\.identity_id/);
  assert.match(migration, /organizer\.id = invitation\.identity_id/);
  assert.match(migration, /organizer\.id = follow\.follower_organizer_id/);
  assert.match(migration, /account\.user_id AS account_user_id/);
  assert.match(migration, /session\.user_id AS session_user_id/);
  assert.match(migration, /account_user_id <> session_user_id/);
  assert.match(migration, /canonical_user_link_conflicts/);
  assert.match(migration, /legacy_owner_mismatch/);
  assert.match(migration, /candidate\.account_user_id IS NULL[\s\S]*candidate\.session_user_id IS NULL[\s\S]*candidate\.account_user_id = candidate\.session_user_id/);
  assert.doesNotMatch(backfill, /LOWER\(|BTRIM\(|contributor_name|guest_email|phone/,
    'migration must not infer a person from changeable identifiers');
  assert.doesNotMatch(migration, /UPDATE event_photos[\s\S]*SET uploader_user_id/,
    'historical photo ownership is unknowable');
});

test('message ownership disagreements are quarantined instead of guessed', () => {
  assert.match(messageConflictMigration, /relationship_type IN \('rsvp','message_log'\)/);
  assert.match(messageConflictMigration, /message\.recipient_user_id[\s\S]*rsvp\.user_id[\s\S]*invitation\.user_id/);
  assert.match(messageConflictMigration, /CARDINALITY\(user_ids\)>1/);
  assert.match(messageConflictMigration, /WHEN CARDINALITY\(candidate\.user_ids\)=1 THEN candidate\.user_ids\[1\]/);
  assert.match(messageConflictMigration, /ELSE NULL/);
  assert.doesNotMatch(messageConflictMigration, /LOWER\(|BTRIM\(|recipient\s*=/,
    'delivery ownership must come only from exact linked records, never address inference');
});

test('new RSVP, remembered guest, invitation, follow, and photo writes dual-write canonical owners', () => {
  const publicRoutes = read('src/routes/public.js');
  const guestSessions = read('src/lib/guest-session.js');
  const invitations = read('src/lib/guest-invitations.js');
  const follows = read('src/lib/host-follows.js');
  const photos = read('src/routes/event-photos.js');

  assert.match(guestSessions, /INSERT INTO guest_sessions[\s\S]*\(identity_id,user_id,token_hash/);
  assert.match(publicRoutes, /user_id[\s\S]*relationshipUserId/);
  assert.match(invitations, /guest_invitation_tokens[\s\S]*identity_id,user_id/);
  assert.match(invitations, /INSERT INTO canonical_user_link_conflicts[\s\S]*'message_log'/);
  assert.match(invitations, /UPDATE message_log[\s\S]*conflict\.resolved_at IS NULL[\s\S]*THEN NULL/);
  assert.match(follows, /follower_organizer_id, follower_user_id, host_organizer_id/);
  assert.match(photos, /canonicalPhotoUploader/);
  assert.match(photos, /req\.sessionAccount\?\.user_id/);
  assert.match(photos, /attendeeCookieName\(eventId\)/);
  assert.match(photos, /guestVerifiedFor\(guest, eventId\)/);
  assert.match(photos, /uploader_user_id/);
  assert.doesNotMatch(photos, /uploaderUserId\s*=.*contributorName|user_id\s*=\s*contributorName/,
    'a display name must never establish photo ownership');
});

test('canonical relationships improve reads without becoming authentication proof', () => {
  const events = read('src/routes/events.js');
  const auth = read('src/routes/auth.js');
  const index = read('src/index.js');
  const invitations = read('src/lib/guest-invitations.js');

  for (const source of [events, auth, index]) {
    assert.match(source, /r\.user_id=\$\d+ OR \(r\.user_id IS NULL AND r\.account_id=\$\d+\)/);
  }
  assert.match(invitations, /\(\$3::int IS NULL OR user_id IS NULL\) AND LOWER\(email\)=LOWER\(\$5\)/);
  assert.match(events, /\(recipientUserId && rowUserId\) return recipientUserId === rowUserId/);
  assert.match(events, /userIdExpression} IS NULL OR target_rsvp\.user_id IS NULL/);
  assert.match(events, /userIdExpression} IS NULL OR ml\.recipient_user_id IS NULL/);
  assert.doesNotMatch(migration, /Authorization .*user_id IS NOT NULL/i);
  assert.match(migration, /Authorization still requires account, invitation, or RSVP-token proof/);
});

test('relationship reconciliation reports exact drift while tolerating quarantined ambiguity', async () => {
  const db = {
    async query(sql) {
      assert.match(sql, /rsvp_candidates/);
      assert.match(sql, /message_candidates/);
      assert.match(sql, /canonical_user_link_conflicts/);
      assert.match(sql, /CARDINALITY\(candidate_user_ids\)>1[\s\S]*NOT user_id=ANY/);
      return { rows: [
        { relationship: 'rsvps', total: '3', linked: '1', exact_unlinked: '1', mismatched: '0', ambiguous: '1', quarantined: '1' },
        { relationship: 'guest_sessions', total: '1', linked: '1', exact_unlinked: '0', mismatched: '0', ambiguous: '0', quarantined: '0' }
      ] };
    }
  };
  const report = await canonicalRelationshipReport(db);
  assert.deepEqual(report[0], {
    relationship: 'rsvps', total: 3, linked: 1, exactUnlinked: 1, mismatched: 0, ambiguous: 1, quarantined: 1
  });
  assert.equal(relationshipReportHasDrift(report), false,
    'an explicitly ambiguous RSVP remains quarantined rather than silently assigned');
  assert.equal(relationshipReportHasDrift([{ ...report[1], exactUnlinked: 1 }]), true);
  assert.equal(relationshipReportHasDrift([{ ...report[0], quarantined: 0 }]), true,
    'an unaudited ambiguity is drift even when two exact candidates are visible');
  assert.equal(relationshipReportHasDrift([{ ...report[1], mismatched: 1 }]), true);
});
