const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.SESSION_SECRET ||= 'flyer-admin-notification-unit-secret';
delete process.env.RESEND_API_KEY;

const root = path.join(__dirname, '..');
const mailer = require('../src/lib/mailer');
const {
  RETRY_BASE_SECONDS,
  RETRY_MAX_SECONDS,
  enqueueFlyerAdminNotifications,
  retryDelaySeconds
} = require('../src/jobs/flyer-admin-notifications');

test('flyer operational emails notify staff about submissions and requested fixes, never approval', async () => {
  const adminUrl = 'https://silvergliderevents.com/admin/done-for-you/flyer-requests/42';

  await mailer.sendAdminFlyerNotification({
    to: 'owner@example.test',
    kind: 'submitted',
    adminUrl,
    requestId: 42,
    submitterName: 'Ada <Promoter>',
    hostName: 'Night & Day',
    idempotencyKey: 'dfy-flyer-admin-42-submitted-7-v1'
  });
  const submitted = mailer.devOutbox.at(-1);
  assert.equal(submitted.to, 'owner@example.test');
  assert.equal(submitted.subject, 'New Done For You flyer submission');
  assert.match(submitted.html, /A new flyer is waiting\./);
  assert.match(submitted.html, /Ada &lt;Promoter&gt; submitted a flyer for Night &amp; Day\./);
  assert.match(submitted.html, new RegExp(adminUrl));
  assert.match(submitted.html, /Open flyer request/);
  assert.equal(submitted.idempotencyKey, 'dfy-flyer-admin-42-submitted-7-v1');

  await mailer.sendAdminFlyerNotification({
    to: 'owner@example.test',
    kind: 'fix_requested',
    adminUrl,
    requestId: 42,
    eventTitle: 'Friday <Live>',
    fixRequest: 'Please move doors to 7:30 & add all-ages.'
  });
  const requestedFix = mailer.devOutbox.at(-1);
  assert.match(requestedFix.subject, /changes requested|fix requested/i);
  assert.match(requestedFix.html, /requested (?:a change|changes)/i);
  assert.match(requestedFix.html, /Please move doors to 7:30 &amp; add all-ages\./);
  assert.match(requestedFix.html, /Friday &lt;Live&gt;/);
  assert.match(requestedFix.html, new RegExp(adminUrl));
  assert.match(requestedFix.html, /Open flyer request|Review requested change/);

  const outboxLength = mailer.devOutbox.length;
  await assert.rejects(
    mailer.sendAdminFlyerNotification({
      to: 'owner@example.test',
      kind: 'approved',
      adminUrl,
      requestId: 42,
      eventTitle: 'Friday Live'
    }),
    /Unknown flyer admin notification kind/
  );
  assert.equal(mailer.devOutbox.length, outboxLength, 'approval does not emit an email');
});

test('durable enqueue snapshots every active Super Admin inside the caller transaction', async () => {
  const queries = [];
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      return sql.includes('INSERT INTO admin_flyer_request_notifications')
        ? { rows: [{ id: '81' }, { id: '82' }] }
        : { rows: [] };
    }
  };
  const ids = await enqueueFlyerAdminNotifications(db, {
    kind: 'fix_requested',
    requestId: 73
  });

  assert.deepEqual(ids, [81, 82]);
  assert.equal(queries.length, 2);
  assert.match(queries[0].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(queries[0].params, ['silver-glider-admin-operator-roster']);
  const { sql: enqueueSql, params: enqueueParams } = queries[1];
  assert.deepEqual(enqueueParams, [73, 'fix_requested']);
  assert.match(enqueueSql, /INSERT INTO admin_flyer_request_notifications/);
  assert.match(enqueueSql, /FROM admin_operators operator/);
  assert.match(enqueueSql, /operator\.role='super_admin' AND operator\.status='active'/);
  assert.match(enqueueSql, /dfy-flyer-admin-/);
  assert.match(
    enqueueSql,
    /ON CONFLICT \(flyer_request_id,notification_kind,(?:notification_revision,)?recipient\) DO NOTHING/
  );
  const queryCount = queries.length;
  await assert.rejects(
    enqueueFlyerAdminNotifications(db, { kind: 'approved', requestId: 73 }),
    /Unknown flyer admin notification kind/
  );
  assert.equal(queries.length, queryCount, 'approval is rejected before touching the database');
});

test('submission and fix requests enqueue before commit, while approval sends no admin email', () => {
  const source = fs.readFileSync(path.join(root, 'src/routes/flyer-intake.js'), 'utf8');
  const submission = source.slice(
    source.indexOf("router.post('/api/flyer-intake'"),
    source.indexOf('// The raw high-entropy token')
  );
  assert.match(submission, /RETURNING id,created_at/);
  assert.ok(submission.indexOf('INSERT INTO admin_flyer_requests') < submission.indexOf('enqueueFlyerAdminNotifications'));
  assert.ok(submission.indexOf('enqueueFlyerAdminNotifications') < submission.indexOf("connection.query('COMMIT')"));
  assert.ok(submission.indexOf("connection.query('COMMIT')") < submission.indexOf('queueFlyerAdminNotifications(notificationIds)'));
  assert.ok(submission.indexOf('queueFlyerAdminNotifications(notificationIds)') < submission.indexOf('res.status(201)'));

  const requestedFix = source.slice(
    source.indexOf("router.post('/api/flyer-preview/fix'"),
    source.indexOf("router.post('/api/flyer-preview/approve/start'")
  );
  assert.ok(requestedFix.indexOf("SET status='changes_requested'") < requestedFix.indexOf('enqueueFlyerAdminNotifications'));
  assert.match(requestedFix, /kind:\s*'fix_requested'/);
  assert.ok(requestedFix.indexOf('enqueueFlyerAdminNotifications') < requestedFix.indexOf("client.query('COMMIT')"));
  assert.ok(requestedFix.indexOf("client.query('COMMIT')") < requestedFix.indexOf('queueFlyerAdminNotifications(notificationIds)'));
  assert.ok(requestedFix.indexOf('queueFlyerAdminNotifications(notificationIds)') < requestedFix.indexOf("status: 'changes_requested'"));
  assert.doesNotMatch(requestedFix, /sendSms|sendText|message_kind/);

  const approval = source.slice(
    source.indexOf("router.post('/api/flyer-preview/approve/verify'"),
    source.indexOf("router.use('/api/admin/done-for-you/flyer-intake'")
  );
  assert.doesNotMatch(approval, /kind:\s*'approved'/);
  assert.doesNotMatch(approval, /enqueueFlyerAdminNotifications/);
  assert.doesNotMatch(approval, /queueFlyerAdminNotifications\(notificationIds\)/);
});

test('notification ledger and worker keep retrying with capped backoff, leases, and provider idempotency', () => {
  const migrationRoot = path.join(root, 'src/db/migrations');
  const migration = fs.readdirSync(migrationRoot)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(file => fs.readFileSync(path.join(migrationRoot, file), 'utf8'))
    .join('\n');
  const job = fs.readFileSync(path.join(root, 'src/jobs/flyer-admin-notifications.js'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'src/index.js'), 'utf8');

  assert.match(migration, /UNIQUE \(flyer_request_id,notification_kind,recipient\)/);
  assert.match(migration, /idempotency_key\s+TEXT NOT NULL UNIQUE/);
  assert.match(migration, /status IN \('pending','sending','sent','failed','skipped'\)/);
  assert.match(migration, /next_attempt_at\s+TIMESTAMPTZ/);
  assert.match(migration, /fix_requested/);
  assert.match(job, /new Set\(\[[^\]]*'submitted'[^\]]*'fix_requested'/);
  assert.doesNotMatch(job, /new Set\(\[[^\]]*'approved'/);
  assert.match(job, /latest_fix_request/);
  assert.match(job, /fixRequest:\s*notification\.latest_fix_request/);
  assert.match(job, /attempt_count=attempt_count\+1/);
  assert.doesNotMatch(job, /attempt_count\s*</);
  assert.match(job, /status='sending'/);
  assert.match(job, /SENDING_LEASE_MINUTES = 5/);
  assert.match(job, /next_attempt_at=NOW\(\) \+ \(\$4::int \* INTERVAL '1 second'\)/);
  assert.match(job, /recipient_active/);
  assert.match(job, /idempotencyKey: notification\.idempotency_key/);
  assert.match(job, /cron\.schedule\('\* \* \* \* \*'/);
  assert.match(index, /startFlyerAdminNotificationCron/);

  assert.equal(RETRY_BASE_SECONDS, 60);
  assert.equal(retryDelaySeconds(1), 60);
  assert.equal(retryDelaySeconds(2), 120);
  assert.equal(retryDelaySeconds(3), 240);
  assert.equal(retryDelaySeconds(100), RETRY_MAX_SECONDS);
  assert.equal(RETRY_MAX_SECONDS, 6 * 60 * 60);
});

test('production misconfiguration rejects an operational email so the ledger can retry it', async t => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });

  await assert.rejects(
    mailer.sendAdminFlyerNotification({
      to: 'owner@example.test',
      kind: 'submitted',
      adminUrl: 'https://silvergliderevents.com/admin/done-for-you/flyer-requests/91',
      requestId: 91,
      submitterName: 'Ada',
      hostName: 'The Room',
      idempotencyKey: 'dfy-flyer-admin-91-submitted-1-v1'
    }),
    /delivery is unavailable/
  );
});
