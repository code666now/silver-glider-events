const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET ||= 'draft-reminder-worker-unit-secret';
process.env.APP_URL = 'https://silvergliderevents.com';

const { eligibleDraftReminderSql, createDraftReminderWorker } = require('../src/jobs/draft-reminders');
const { draftRemindersEnabled, eligibleDraftSql, draftNudgeSuppressionSql, recordDraftHostActivity } = require('../src/lib/draft-reminders');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('draft reminder enrollment is prospective with durable publication and host frequency markers', () => {
  const sql = read('src/db/migrations/080_draft_reminders.sql');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS draft_host_activity_at TIMESTAMPTZ/);
  assert.doesNotMatch(sql, /UPDATE\s+events\s+SET\s+draft_host_activity_at/i);
  assert.doesNotMatch(sql, /INSERT INTO event_draft_reminders/i);
  assert.match(sql, /UPDATE events SET first_published_at=created_at\s+WHERE status='published'/);
  assert.match(sql, /NEW.first_published_at := OLD.first_published_at/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS first_draft_reminder_attempt_at/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS last_draft_reminder_attempt_at/);
  assert.match(sql, /event_id INTEGER PRIMARY KEY REFERENCES events/);
  assert.match(sql, /attempt_count BETWEEN 0 AND 3/);
  assert.match(sql, /CHECK \(scope IN \('host_followups','host_drafts'\)\)/);
});

test('draft candidates select latest eligible work before inactivity and enforce bounded scope', () => {
  const sql = eligibleDraftReminderSql();
  for (const fragment of [
    "account.account_status='active'", "identity.verification_scope='account'",
    'identity.verified_at IS NOT NULL', 'identity.revoked_at IS NULL',
    "candidate.status='draft'", 'candidate.archived_at IS NULL', 'candidate.first_published_at IS NULL',
    'candidate.draft_host_activity_at IS NOT NULL', "INTERVAL '24 hours'", "INTERVAL '7 days'",
    "INTERVAL '23 hours'", "INTERVAL '2 minutes'", 'candidate.start_time) AT TIME ZONE candidate.timezone > NOW()',
    "request.status NOT IN ('published','rejected')", "workspace.status='active'", 'workspace.expires_at > NOW()',
    'last_draft_reminder_attempt_at', 'host_profile_nudge_sent_at', 'first_event_nudge_sent_at',
    'followup.first_attempt_at', 'recap.host_recap_delivered_at', "explicit_choice.consent_version='host_drafts_v1'",
    'explicit_choice.updated_at > inherited.updated_at'
  ]) assert.ok(sql.includes(fragment), fragment);
  assert.ok(sql.indexOf('ORDER BY candidate.draft_host_activity_at DESC') < sql.indexOf("INTERVAL '24 hours'"));
  assert.match(eligibleDraftReminderSql({ eventOnly: true }), /AND draft.id=\$1 AND host.id=\$2/);
  assert.doesNotMatch(sql, /draft\.updated_at|host\.email AS/);
});

test('the kill switch and both existing host jobs share draft supersession', () => {
  for (const value of ['false', 'off', '0', ' FALSE ']) assert.equal(draftRemindersEnabled({ DRAFT_REMINDERS_ENABLED: value }), false);
  assert.equal(draftRemindersEnabled({}), true);
  const enabled = draftNudgeSuppressionSql('host', { firstEvent: true, env: {} });
  assert.match(enabled, /first_draft_reminder_attempt_at IS NULL/);
  assert.match(enabled, /last_draft_reminder_attempt_at/);
  assert.match(enabled, /active_draft\.draft_host_activity_at/);
  const disabled = draftNudgeSuppressionSql('host', { env: { DRAFT_REMINDERS_ENABLED: 'false' } });
  assert.doesNotMatch(disabled, /active_draft/);
  assert.match(disabled, /last_draft_reminder_attempt_at/);
  assert.throws(() => eligibleDraftSql('event;DROP'), /Invalid SQL alias/);
  assert.equal((read('src/jobs/host-onboarding.js').match(/draftNudgeSuppressionSql\('host'/g) || []).length, 4);
  assert.match(read('src/jobs/host-follow-ups.js'), /draftNudgeSuppressionSql\('host'\)/);
  assert.match(read('src/index.js'), /require\('\.\/jobs\/draft-reminders'\)\.startDraftReminderCron/);
});

test('activity is explicitly owner-scoped and resumes pending work without resetting one-shot history', async () => {
  const queries = [];
  const db = { query: async (sql, values) => { queries.push({ sql, values }); return { rows: sql.startsWith('UPDATE events') ? [{ id: 8 }] : [] }; } };
  assert.equal(await recordDraftHostActivity(db, 8, 3), true);
  assert.match(queries[0].sql, /id=\$1 AND organizer_id=\$2 AND status='draft'/);
  assert.match(queries[0].sql, /archived_at IS NULL AND first_published_at IS NULL/);
  assert.match(queries[1].sql, /status='suppressed',error='host_resumed'/);
  assert.doesNotMatch(queries[1].sql, /DELETE|attempt_count=0/);
  const before = queries.length;
  assert.equal(await recordDraftHostActivity(db, 'bad', 3), false);
  assert.equal(queries.length, before);
  assert.equal(await recordDraftHostActivity({ query: async () => ({ rows: [] }) }, 8, 99), false);
});

function fixture({ denyAccount = false, revokeOnFinal = false, changedLive = false, changedAddress = false, failSends = 0, failFinalCommit = false } = {}) {
  const candidate = { id: 18, organizer_id: 7, title: 'Saved night', draft_host_activity_at: new Date('2026-11-04T10:00:00Z'), email: 'host@example.test' };
  let current = { ...candidate };
  let stored = null;
  let beforeTransaction = null;
  let transactionOpen = false;
  let firstMarker = null;
  let permissionChecks = 0;
  let committedFailure = false;
  const queries = [];
  const sends = [];
  const db = { async query(sql, values = []) {
    queries.push({ sql, values });
    if (sql.startsWith('SELECT draft.id')) {
      return { rows: current && (!stored || (['pending', 'failed'].includes(stored.status) && stored.attempt_count < 3)) ? [current] : [] };
    }
    if (sql.includes('SELECT 1 FROM email_optouts optout')) {
      permissionChecks += 1;
      return { rows: revokeOnFinal && permissionChecks >= 2 ? [{}] : [] };
    }
    if (sql.includes('INSERT INTO event_draft_reminders')) {
      if (!stored) stored = { event_id: values[0], organizer_id: values[1], recipient: values[2], activity_at: values[3], render_snapshot: JSON.parse(values[4]), status: 'pending', attempt_count: 0 };
      return { rows: [] };
    }
    if (sql.startsWith('SELECT * FROM event_draft_reminders')) return { rows: stored ? [structuredClone(stored)] : [] };
    if (sql.startsWith('WITH claimed AS')) {
      if (!stored || !['pending', 'failed'].includes(stored.status) || stored.attempt_count >= 3) return { rows: [] };
      stored.attempt_count += 1;
      stored.status = 'pending';
      stored.first_attempt_at ||= '2026-11-05T10:00:00.000Z';
      firstMarker ||= stored.first_attempt_at;
      return { rows: [{ event_id: 18 }] };
    }
    if (sql === 'BEGIN') { transactionOpen = true; beforeTransaction = structuredClone(stored); return { rows: [] }; }
    if (sql === 'ROLLBACK') { stored = beforeTransaction; transactionOpen = false; return { rows: [] }; }
    if (sql === 'COMMIT') {
      if (failFinalCommit && stored.status === 'sent' && !committedFailure) { committedFailure = true; throw new Error('synthetic commit failure'); }
      transactionOpen = false;
      return { rows: [] };
    }
    if (sql.startsWith('SELECT event.id')) {
      assert.equal(transactionOpen, true);
      assert.match(sql, /FOR UPDATE OF event/);
      return { rows: changedLive ? [] : [current] };
    }
    if (sql.startsWith('SELECT identity.value AS email')) return { rows: [{ email: changedAddress ? 'other@example.test' : candidate.email }] };
    if (sql.includes("SET status='suppressed'")) { if (stored) stored.status = 'suppressed'; return { rows: [] }; }
    if (sql.includes("SET status='sent'")) { stored.status = 'sent'; return { rows: [] }; }
    if (sql.includes("SET status='failed',error='delivery_failed'")) { if (stored.status === 'pending') stored.status = 'failed'; return { rows: [] }; }
    return { rows: [] };
  } };
  const worker = createDraftReminderWorker({
    db,
    withAccount: async (unused, organizerId, callback) => denyAccount
      ? { allowed: false } : { allowed: true, result: await callback(db) },
    sendEmail: async payload => {
      assert.equal(transactionOpen, true, 'event lock remains held through provider handoff');
      assert.ok(firstMarker, 'host frequency reservation was durable before BEGIN');
      sends.push(payload);
      if (sends.length <= failSends) throw new Error('synthetic ambiguous provider result');
      return { id: 'accepted-test' };
    }
  });
  return { worker, candidate, queries, sends, stored: () => stored, firstMarker: () => firstMarker, setCurrent: value => { current = value; } };
}

test('accepted reminder is one-shot with a durable claim before locked handoff', async () => {
  const f = fixture();
  assert.equal(await f.worker.deliverDraftReminder(f.candidate), true);
  assert.equal(await f.worker.deliverDraftReminder(f.candidate), false);
  assert.equal(f.sends.length, 1);
  assert.equal(f.stored().status, 'sent');
  assert.equal(f.sends[0].idempotencyKey, 'sge-draft-reminder-v1-18');
  assert.ok(f.queries.findIndex(q => q.sql.startsWith('WITH claimed AS')) < f.queries.findIndex(q => q.sql === 'BEGIN'));
  assert.equal(f.queries.filter(q => q.sql === 'COMMIT').length, 1);
});

test('final event, address and opt-out checks suppress before provider handoff', async () => {
  for (const options of [{ changedLive: true }, { changedAddress: true }, { revokeOnFinal: true }]) {
    const f = fixture(options);
    assert.equal(await f.worker.deliverDraftReminder(f.candidate), false);
    assert.equal(f.sends.length, 0);
    assert.equal(f.stored().status, 'suppressed');
    assert.equal(f.stored().attempt_count, 1, 'final rejection does not erase one-shot history');
  }
  const inactive = fixture({ denyAccount: true });
  assert.equal(await inactive.worker.deliverDraftReminder(inactive.candidate), false);
  assert.equal(inactive.sends.length, 0);
  assert.equal(inactive.stored(), null);
});

test('ambiguous delivery reuses frozen payload and stable key with three attempts maximum', async () => {
  const f = fixture({ failSends: 3 });
  for (let attempt = 0; attempt < 4; attempt += 1) assert.equal(await f.worker.deliverDraftReminder(f.candidate), false);
  assert.equal(f.sends.length, 3);
  assert.equal(f.stored().attempt_count, 3);
  assert.deepEqual(f.sends[1], f.sends[0]);
  assert.deepEqual(f.sends[2], f.sends[0]);
  assert.equal(f.queries.filter(q => q.sql === 'ROLLBACK').length, 3);
});

test('accepted-provider bookkeeping failure preserves claim and exact idempotent retry', async () => {
  const f = fixture({ failFinalCommit: true });
  assert.equal(await f.worker.deliverDraftReminder(f.candidate), false);
  assert.equal(f.stored().attempt_count, 1);
  assert.ok(f.firstMarker());
  assert.equal(await f.worker.deliverDraftReminder(f.candidate), true);
  assert.deepEqual(f.sends[0], f.sends[1]);
  assert.equal(f.stored().attempt_count, 2);
});

test('changed activity between retries suppresses rather than reusing an old key for new content', async () => {
  const f = fixture({ failSends: 1 });
  await f.worker.deliverDraftReminder(f.candidate);
  f.setCurrent({ ...f.candidate, title: 'Changed night', draft_host_activity_at: new Date('2026-11-05T11:00:00Z') });
  assert.equal(await f.worker.deliverDraftReminder(f.candidate), false);
  assert.equal(f.sends.length, 1);
  assert.equal(f.stored().status, 'suppressed');
});

test('worker terminalizes attempts beyond the provider horizon and can be disabled', async () => {
  const prior = process.env.DRAFT_REMINDERS_ENABLED;
  try {
    process.env.DRAFT_REMINDERS_ENABLED = 'true';
    const f = fixture();
    f.setCurrent(null);
    assert.equal(await f.worker.runDraftReminderPass(), 0);
    assert.match(f.queries[0].sql, /first_attempt_at < NOW\(\) - INTERVAL '23 hours'/);
    assert.match(f.queries[0].sql, /delivery_outcome_unknown/);
    process.env.DRAFT_REMINDERS_ENABLED = 'false';
    const disabled = fixture();
    assert.equal(await disabled.worker.runDraftReminderPass(), 0);
    assert.equal(await disabled.worker.deliverDraftReminder(disabled.candidate), false);
    assert.equal(disabled.queries.length, 0);
  } finally {
    if (prior === undefined) delete process.env.DRAFT_REMINDERS_ENABLED;
    else process.env.DRAFT_REMINDERS_ENABLED = prior;
  }
});
