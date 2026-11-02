const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.SESSION_SECRET ||= 'post-event-unit-test-secret';

const {
  PostEventError,
  audienceDigest,
  emailRenderSnapshot,
  eventEndAtSql,
  normalizeDraft,
  renderSnapshotDigest,
  signPreviewToken,
  verifyPreviewToken
} = require('../src/lib/post-event');

const read = relativePath => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

test('post-event storage is private, attributable, retryable, and one batch per event', () => {
  const migration = read('src/db/migrations/072_post_event.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS event_turnout_estimates/);
  assert.match(migration, /event_id\s+INT PRIMARY KEY REFERENCES events\(id\) ON DELETE CASCADE/);
  assert.match(migration, /submitted_by_user_id\s+INT REFERENCES users\(id\) ON DELETE SET NULL/);
  assert.match(migration, /estimated_turnout BETWEEN 0 AND 100000/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS post_event_thank_you_batches/);
  assert.match(migration, /event_id\s+INT NOT NULL UNIQUE REFERENCES events\(id\) ON DELETE CASCADE/);
  assert.match(migration, /render_snapshot\s+JSONB/);
  assert.match(migration, /'post_event_thank_you'/);
  assert.match(migration, /message_log_post_event_thank_you_dedupe_uq/);
});

test('shared event-end SQL handles explicit, overnight, and missing end times in event timezone', () => {
  const expression = eventEndAtSql('night');
  assert.match(expression, /night\.event_date \+ COALESCE\(night\.end_time,night\.start_time\)/);
  assert.match(expression, /night\.end_time IS NULL THEN INTERVAL '2 hours'/);
  assert.match(expression, /night\.end_time <= night\.start_time THEN INTERVAL '1 day'/);
  assert.match(expression, /AT TIME ZONE night\.timezone/);
  assert.throws(() => eventEndAtSql('e; DROP TABLE events'), /Invalid SQL alias/);
});

test('thank-you drafts reject header injection and unsafe sizes', () => {
  assert.deepEqual(normalizeDraft({
    subject: ' Thanks ', message: 'Hello\r\nthere', includeFollow: true
  }), { subject: 'Thanks', message: 'Hello\nthere', includeFollow: true });
  assert.throws(
    () => normalizeDraft({ subject: 'Hello\nBcc: other@example.test', message: 'Hi' }),
    error => error instanceof PostEventError && error.code === 'invalid_subject'
  );
  assert.throws(
    () => normalizeDraft({ subject: 'Hello', message: 'x'.repeat(4001) }),
    error => error instanceof PostEventError && error.code === 'invalid_message'
  );
});

test('email render snapshots contain only allowlisted event and host fields', () => {
  const snapshot = emailRenderSnapshot({
    id: 4,
    title: 'Private Night',
    event_date: '2030-01-01',
    venue_address: 'Never include this',
    slug: 'private-slug',
    access_code: 'secret',
    cover_image_url: 'https://example.test/art.jpg'
  }, {
    id: 2,
    org_name: 'Test Host',
    public_slug: 'test-host',
    email: 'host@example.test',
    sessions_valid_after: 'secret'
  });
  const serialized = JSON.stringify(snapshot);
  assert.match(serialized, /Private Night/);
  assert.match(serialized, /test-host/);
  assert.doesNotMatch(serialized, /Never include this|private-slug|access_code|sessions_valid_after/);
  assert.match(renderSnapshotDigest(snapshot), /^[a-f0-9]{64}$/);
});

test('preview tokens bind draft, audience, and render snapshot and fail closed', () => {
  const values = {
    eventId: 42,
    batchId: 91,
    draftHash: 'a'.repeat(64),
    audienceHash: 'b'.repeat(64),
    renderHash: 'c'.repeat(64),
    now: 1_700_000_000_000
  };
  const token = signPreviewToken(values);
  assert.deepEqual(verifyPreviewToken(token, { now: values.now }), {
    v: 1,
    eventId: 42,
    batchId: '91',
    draftHash: values.draftHash,
    audienceHash: values.audienceHash,
    renderHash: values.renderHash,
    exp: Math.floor(values.now / 1000) + (15 * 60)
  });
  assert.equal(verifyPreviewToken(`${token.slice(0, -1)}0`, { now: values.now }), null);
  const payload = token.split('.')[0];
  assert.doesNotThrow(() => verifyPreviewToken(`${payload}.${'é'.repeat(64)}`, { now: values.now }));
  assert.equal(verifyPreviewToken(`${payload}.${'é'.repeat(64)}`, { now: values.now }), null);
  assert.equal(verifyPreviewToken(token, { now: values.now + (16 * 60 * 1000) }), null);
});

test('audience fingerprints are order-independent and include follow state', () => {
  const first = { rsvpId: 1, userId: 9, email: 'a@example.test', alreadyFollowing: false, consentSource: 'rsvp_host_email' };
  const second = { rsvpId: 2, userId: 10, email: 'b@example.test', alreadyFollowing: true, consentSource: 'host_follow' };
  assert.equal(audienceDigest([first, second]), audienceDigest([second, first]));
  assert.notEqual(
    audienceDigest([first, second]),
    audienceDigest([{ ...first, alreadyFollowing: true }, second])
  );
});

test('post-event routes and worker preserve owner auth, explicit approval, suppression, and idempotency', () => {
  const routes = read('src/routes/post-event.js');
  const worker = read('src/jobs/post-event-thank-yous.js');
  const index = read('src/index.js');
  assert.match(routes, /router\.use\('\/api\/events', requireOrganizer\)/);
  assert.match(routes, /organizerId: req\.organizer\.id/);
  assert.match(routes, /approved_by_user_id=\$4/);
  assert.match(routes, /preview\.draftHash !== currentDraftHash/);
  assert.match(routes, /preview\.audienceHash !== audience\.audienceHash/);
  assert.match(routes, /preview\.renderHash !== renderHash/);
  assert.match(worker, /rsvpId: Number\(delivery\.rsvp_id\)/);
  assert.match(worker, /recipient_suppressed/);
  assert.match(worker, /post-event-thank-you:\$\{batchId\}:\$\{delivery\.log_id\}/);
  assert.match(worker, /created_at < NOW\(\) - INTERVAL '23 hours'/);
  assert.match(worker, /attempt_count=0 OR created_at >= NOW\(\) - INTERVAL '23 hours'/);
  assert.match(worker, /delivery_outcome_unknown/);
  assert.match(worker, /withActiveHostAccount\([\s\S]*eligibleThankYouAudience\(lockedClient \|\| pool/);
  assert.match(worker, /batch\.status='partial_failed' AND batch\.completed_at IS NULL/);
  assert.match(worker, /status <> 'sent' AND COALESCE\(error,''\) <> \$3 AND attempt_count >= \$2/);
  assert.match(worker, /settlePostEventThankYouWork/);
  assert.match(index, /routes\/post-event/);
  assert.match(index, /startPostEventThankYouCron/);
});
