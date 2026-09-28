const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  outboundDeliveryLockKey,
  withActiveHostAccount
} = require('../src/lib/outbound-account-status');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

function fakePool({ userId = 71, accountStatus = 'active' } = {}) {
  const calls = [];
  const client = {
    async query(sql, params) {
      if (/SELECT user_id FROM organizers/.test(sql)) {
        calls.push(['canonical-host', params]);
        return { rows: userId == null ? [] : [{ user_id: userId }] };
      }
      if (/pg_advisory_unlock/.test(sql)) {
        calls.push(['unlock', params]);
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      if (/pg_advisory_lock/.test(sql)) {
        calls.push(['lock', params]);
        return { rows: [{ pg_advisory_lock: true }] };
      }
      if (/canonical_host\.account_status/.test(sql)) {
        calls.push(['status', params]);
        return { rows: accountStatus == null ? [] : [{ account_status: accountStatus }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release(error) {
      calls.push(['release', error || null]);
    }
  };
  return {
    calls,
    async connect() {
      calls.push(['connect']);
      return client;
    }
  };
}

test('active host delivery holds the canonical account advisory lock across the provider send', async () => {
  const pool = fakePool();
  const result = await withActiveHostAccount(pool, 19, async () => {
    pool.calls.push(['provider-send']);
    return { id: 'provider-1' };
  });

  assert.equal(result.allowed, true);
  assert.equal(result.accountStatus, 'active');
  assert.equal(result.userId, 71);
  assert.equal(result.result.id, 'provider-1');
  assert.deepEqual(pool.calls.map(call => call[0]), [
    'connect', 'canonical-host', 'lock', 'status', 'provider-send', 'unlock', 'release'
  ]);
  assert.equal(pool.calls.find(call => call[0] === 'lock')[1][0], outboundDeliveryLockKey(71));
});

test('inactive or missing canonical hosts are cancelled without calling the provider', async () => {
  for (const accountStatus of ['suspended', 'deleted', null]) {
    const pool = fakePool({ accountStatus });
    let providerCalled = false;
    const result = await withActiveHostAccount(pool, 19, async () => {
      providerCalled = true;
    });
    assert.equal(result.allowed, false);
    assert.equal(result.accountStatus, accountStatus);
    assert.equal(providerCalled, false);
    assert.deepEqual(pool.calls.map(call => call[0]), [
      'connect', 'canonical-host', 'lock', 'status', 'unlock', 'release'
    ]);
  }
});

test('provider failures still release the account delivery lock', async () => {
  const pool = fakePool();
  await assert.rejects(
    withActiveHostAccount(pool, 19, async () => {
      pool.calls.push(['provider-send']);
      throw new Error('provider unavailable');
    }),
    /provider unavailable/
  );
  assert.deepEqual(pool.calls.slice(-2).map(call => call[0]), ['unlock', 'release']);
});

test('queued workers and event-owned direct sends use the final active-host delivery gate', () => {
  const eventNotifications = read('src/jobs/event-notifications.js');
  const reminders = read('src/jobs/reminders.js');
  const invitations = read('src/jobs/previous-guest-invitations.js');
  const sms = read('src/jobs/sms-notifications.js');
  const events = read('src/routes/events.js');
  const photos = read('src/routes/event-photos.js');
  const publicRoutes = read('src/routes/public.js');
  const gate = /withActiveHostAccount\(\s*pool,\s*(?:event|batch)\.organizer_id/;

  assert.match(eventNotifications, gate);
  assert.ok((reminders.match(/withActiveHostAccount\(/g) || []).length >= 2);
  assert.match(invitations, gate);
  assert.match(sms, gate);
  assert.match(eventNotifications, /attempt_count=\$2, error=\$3/);
  assert.match(invitations, /attempt_count=\$2, error=\$3/);
  assert.match(reminders, /cancelled: \$\{HOST_ACCOUNT_INACTIVE\}/);
  assert.match(sms, /attempt_count=\$2,provider_error_code=\$3/);
  assert.match(sms, /provider_error_code <> ALL\(\$4::text\[\]\)/);
  assert.match(sms, /HOST_ACCOUNT_DELETED/);
  assert.match(sms, /HOST_ACCOUNT_INACTIVE/);
  assert.match(events, /withActiveHostAccount\(pool, event\.organizer_id,[\s\S]*sendEventAnnouncement/);
  assert.match(photos, /withActiveHostAccount\(pool, event\.organizer_id,[\s\S]*sendPhotoRequest/);
  assert.match(publicRoutes, /withActiveHostAccount\(pool, event\.organizer_id,[\s\S]*sendRsvpConfirmation/);
});
