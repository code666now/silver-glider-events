const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET ||= 'host-follow-up-unit-secret';
process.env.APP_URL = 'https://silvergliderevents.com';

const {
  EMAIL_PREFERENCE_SCOPES, emailOptedOut, setEmailPreference, signEmailPreference, verifyEmailPreference
} = require('../src/lib/email-preferences');
const { followUpSnapshot, buildHostFollowUpEmail } = require('../src/lib/host-follow-up');
const { createHostFollowUpWorker, eligibleFollowUpSql } = require('../src/jobs/host-follow-ups');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('host follow-up storage is prospective and does not turn old recap claims into delivery or consent', () => {
  const migration = read('src/db/migrations/074_host_follow_ups.sql');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS host_recap_delivered_at TIMESTAMPTZ/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS email_optins/);
  assert.match(migration, /consent_version TEXT NOT NULL/);
  assert.match(migration, /event_id INT PRIMARY KEY REFERENCES events\(id\) ON DELETE CASCADE/);
  assert.match(migration, /render_snapshot JSONB NOT NULL/);
  assert.doesNotMatch(migration, /UPDATE\s+events\s+SET\s+host_recap_delivered_at/i);
  assert.doesNotMatch(migration, /INSERT INTO email_optins/i);
  const recap = read('src/jobs/host-recap.js');
  assert.ok(recap.indexOf('host_recap_delivered_at=COALESCE') > recap.indexOf('if (!delivery.allowed)'));
  assert.match(read('src/index.js'), /require\('\.\/jobs\/host-follow-ups'\)\.startHostFollowUpCron/);
});

test('next-event nudges are default-off, explicitly granted, independently signed, and reversible', async () => {
  const queries = [];
  let permission = false;
  const db = { async query(sql, values) {
    queries.push({ sql, values });
    if (sql.includes('INSERT INTO email_optins')) permission = true;
    if (sql.startsWith('DELETE FROM email_optins')) permission = false;
    return { rows: sql.includes('SELECT 1 FROM email_optins') && permission ? [{}] : [] };
  } };
  assert.equal(await emailOptedOut(db, 'HOST@example.test', 'host_followups'), true);
  await setEmailPreference(db, 'HOST@example.test', 'host_followups', true);
  assert.equal(await emailOptedOut(db, 'host@example.test', 'host_followups'), false);
  await setEmailPreference(db, 'host@example.test', 'host_followups', false);
  assert.equal(await emailOptedOut(db, 'host@example.test', 'host_followups'), true);
  assert.ok(queries.some(query => query.values.includes('host_followups_v1')));
  assert.match(EMAIL_PREFERENCE_SCOPES.host_followups.description, /Off until you turn it on/);
  assert.match(EMAIL_PREFERENCE_SCOPES.host_recaps.description, /not verified attendance/);
  const token = signEmailPreference('HOST@example.test', 'host_followups');
  assert.deepEqual(verifyEmailPreference(token), { email: 'host@example.test', scope: 'host_followups' });
  const routes = read('src/routes/email-preferences.js');
  assert.match(routes, /data.scope === 'host_recaps'/);
  assert.match(routes, /id="host-followups-enabled" type="checkbox"/);
  assert.match(routes, /followupsEnabled \? 'checked' : ''/);
});

test('follow-up templates give one relevant action without implying anyone attended or sending invitations', () => {
  const links = { unsubscribeUrl: 'https://silvergliderevents.com/unsubscribe-email?token=test', manageUrl: 'https://silvergliderevents.com/email-settings?token=test' };
  const draft = buildHostFollowUpEmail({
    snapshot: followUpSnapshot({ title: 'Night', draft_event_id: 41, draft_event_title: '<Another night>' }), ...links
  });
  assert.equal(draft.subject, 'Your next event is taking shape');
  assert.match(draft.html, /&lt;Another night&gt;/);
  assert.match(draft.html, /login\?next=%2Fevents%2F41%2Fedit/);
  assert.match(draft.html, />Continue your event<\/a>/);
  assert.match(draft.text, /review the people and the message before anything is sent/);
  const noDraft = buildHostFollowUpEmail({ snapshot: followUpSnapshot({ title: 'Night' }), ...links });
  assert.equal(noDraft.subject, 'Got another one in mind?');
  assert.match(noDraft.html, /login\?next=%2Fevents%2Fnew/);
  assert.match(noDraft.html, />Create your next event<\/a>/);
  assert.doesNotMatch(noDraft.html, /came through|people attended|venue_address|access_code/i);
  assert.match(noDraft.text, /at most one every 30 days/);
});

test('send-time query bounds the cohort, hours, recent mail, frequency, upcoming events, and verified host permission', () => {
  const sql = eligibleFollowUpSql({ eventOnly: true });
  for (const required of [
    "filename='074_host_follow_ups.sql'", "INTERVAL '3 days'", "INTERVAL '7 days'",
    "INTERVAL '30 days'", "INTERVAL '24 hours'", "INTERVAL '23 hours'",
    "identity.verification_scope='account'", 'identity.verified_at IS NOT NULL',
    'identity.revoked_at IS NULL', "account.account_status='active'",
    "optin.consent_version='host_followups_v1'", "upcoming.status='published'",
    "d.status='draft'", 'd.archived_at IS NULL', 'flyer_request.event_id=d.id',
    "flyer_request.status NOT IN ('published','rejected')", 'ANY($1::int[])', 'AND e.id=$2'
  ]) assert.ok(sql.includes(required), required);
  assert.doesNotMatch(sql, /host_recap_sent_at|want_reminders|host\.email AS/);
});

function fakeWorker({ rejected = false, failFirst = false, revokeDuringPreparation = false } = {}) {
  const candidate = { id: 42, organizer_id: 7, title: 'Last night', email: 'host@example.test', draft_event_id: 51, draft_event_title: 'Next night' };
  let current = candidate;
  let stored = null;
  const deliveries = [];
  const queries = [];
  let permissionChecks = 0;
  const db = { async query(sql, values = []) {
    queries.push({ sql, values });
    if (sql.startsWith('SELECT e.id')) return { rows: current ? [current] : [] };
    if (sql.includes('SELECT 1 FROM email_optins')) {
      permissionChecks += 1;
      return { rows: rejected || (revokeDuringPreparation && permissionChecks > 1) ? [] : [{}] };
    }
    if (sql.includes('INSERT INTO host_event_follow_ups')) {
      if (!stored) stored = { recipient: values[2], render_snapshot: JSON.parse(values[3]), status: 'pending', attempt_count: 0 };
      return { rows: [] };
    }
    if (sql.startsWith('SELECT * FROM host_event_follow_ups')) {
      // PostgreSQL JSONB may reorder keys; the worker must compare fields, not serialization order.
      return { rows: stored ? [{ ...stored, render_snapshot: Object.fromEntries(Object.entries(stored.render_snapshot).reverse()) }] : [] };
    }
    if (sql.includes('RETURNING event_id')) {
      if (!stored || !['pending', 'failed'].includes(stored.status) || stored.attempt_count >= 3) return { rows: [] };
      stored.attempt_count += 1;
      return { rows: [{ event_id: 42 }] };
    }
    if (sql.includes("status='sent'")) stored.status = 'sent';
    if (sql.includes("error='delivery_failed'")) stored.status = 'failed';
    if (sql.includes("error='context_changed'")) stored.status = 'suppressed';
    if (sql.includes("error='permission_revoked'")) stored.status = 'suppressed';
    return { rows: [] };
  } };
  const worker = createHostFollowUpWorker({
    db,
    withAccount: async (unused, id, callback) => ({ allowed: true, result: await callback(db) }),
    sendEmail: async payload => {
      deliveries.push(payload);
      if (failFirst && deliveries.length === 1) throw new Error('synthetic provider failure');
      return { id: 'test-provider' };
    }
  });
  return { worker, candidate, deliveries, queries, setCurrent: value => { current = value; }, stored: () => stored };
}

test('the host account gate and current permission are checked before recording or delivering', async () => {
  const fixture = fakeWorker({ rejected: true });
  assert.equal(await fixture.worker.deliverHostFollowUp(fixture.candidate), false);
  assert.equal(fixture.deliveries.length, 0);
  assert.equal(fixture.stored(), null);
  const acted = fakeWorker();
  acted.setCurrent(null);
  assert.equal(await acted.worker.deliverHostFollowUp(acted.candidate), false);
  assert.equal(acted.deliveries.length, 0);
});

test('accepted follow-ups are one per event, preserve provider idempotency, and mark after handoff', async () => {
  const fixture = fakeWorker();
  assert.equal(await fixture.worker.deliverHostFollowUp(fixture.candidate), true);
  assert.equal(await fixture.worker.deliverHostFollowUp(fixture.candidate), false);
  assert.equal(fixture.deliveries.length, 1);
  assert.equal(fixture.deliveries[0].idempotencyKey, 'sge-host-follow-up-v1-42');
  assert.equal(fixture.stored().status, 'sent');
});

test('an opt-out during snapshot preparation is honored immediately before provider handoff', async () => {
  const fixture = fakeWorker({ revokeDuringPreparation: true });
  assert.equal(await fixture.worker.deliverHostFollowUp(fixture.candidate), false);
  assert.equal(fixture.deliveries.length, 0);
  assert.equal(fixture.stored().status, 'suppressed');
});

test('retry reuses the frozen exact email and suppresses a changed draft destination', async () => {
  const fixture = fakeWorker({ failFirst: true });
  assert.equal(await fixture.worker.deliverHostFollowUp(fixture.candidate), false);
  assert.equal(await fixture.worker.deliverHostFollowUp(fixture.candidate), true);
  assert.deepEqual(fixture.deliveries[0], fixture.deliveries[1]);
  const changed = fakeWorker({ failFirst: true });
  await changed.worker.deliverHostFollowUp(changed.candidate);
  changed.setCurrent({ ...changed.candidate, draft_event_id: 99 });
  assert.equal(await changed.worker.deliverHostFollowUp(changed.candidate), false);
  assert.equal(changed.deliveries.length, 1);
  assert.equal(changed.stored().status, 'suppressed');
});

test('Do this again reuses draft duplication and dates-first editing with no automatic invitation call', () => {
  const manage = read('public/js/manage.js');
  assert.match(manage, /lifecycle-next-event'\)\.addEventListener\('click',[^\n]*repeat: true/);
  assert.match(manage, /api\(`\/api\/events\/\$\{eventId\}\/duplicate`, \{ method: 'POST' \}\)/);
  assert.match(manage, /repeat \? 'details&repeat=1' : 'appearance'/);
  assert.match(manage, /Your past guests are here to choose from\. Nothing has been sent\./);
  assert.match(read('src/views/event-manage.html'), /Do this again/);
  const duplicateBody = manage.slice(manage.indexOf('async function duplicateEvent'), manage.indexOf("$('duplicate').addEventListener"));
  assert.doesNotMatch(duplicateBody, /invitations|announce|\/send/);
});

test('a failed follow-up timestamp write never releases a provider-accepted recap claim', async () => {
  const pool = require('../src/config/db');
  const mailer = require('../src/lib/mailer');
  const postEvent = require('../src/lib/post-event');
  const outbound = require('../src/lib/outbound-account-status');
  const originals = {
    query: pool.query,
    sendHostRecap: mailer.sendHostRecap,
    loadPostEventContext: postEvent.loadPostEventContext,
    withActiveHostAccount: outbound.withActiveHostAccount
  };
  const jobPath = require.resolve('../src/jobs/host-recap');
  const previousJob = require.cache[jobPath];
  const queries = [];
  let sends = 0;
  try {
    pool.query = async (sql, values) => {
      queries.push({ sql, values });
      if (sql.includes('host_recap_delivered_at=COALESCE')) throw new Error('synthetic bookkeeping failure');
      if (sql.includes('SELECT e.id, e.organizer_id')) return { rows: [{ id: 42, organizer_id: 7 }] };
      if (sql.includes('SELECT identity.value AS email')) return { rows: [{ email: 'host@example.test' }] };
      if (sql.includes('UPDATE events SET host_recap_sent_at=NOW()')) return { rows: [{ id: 42 }] };
      return { rows: [] };
    };
    mailer.sendHostRecap = async () => { sends += 1; return { id: 'test-accepted' }; };
    postEvent.loadPostEventContext = async () => ({ ended: true, event: { id: 42, title: 'Test night' }, host: {}, stats: {} });
    outbound.withActiveHostAccount = async (db, organizerId, callback) => ({ allowed: true, result: await callback(db) });
    delete require.cache[jobPath];
    const { runHostRecapPass } = require('../src/jobs/host-recap');
    assert.equal(await runHostRecapPass({ hours: [10] }), 1);
    assert.equal(sends, 1);
    assert.ok(queries.some(query => query.sql.includes('host_recap_delivered_at=COALESCE')));
    assert.equal(queries.some(query => query.sql.includes('SET host_recap_sent_at=NULL')), false);
  } finally {
    pool.query = originals.query;
    mailer.sendHostRecap = originals.sendHostRecap;
    postEvent.loadPostEventContext = originals.loadPostEventContext;
    outbound.withActiveHostAccount = originals.withActiveHostAccount;
    delete require.cache[jobPath];
    if (previousJob) require.cache[jobPath] = previousJob;
  }
});
