const test = require('node:test');
const assert = require('node:assert/strict');
const { makePreview, createReminderBatch } = require('../src/lib/sms-reminder-fulfillment');
const { makeFollowerAnnouncementPreview, createFollowerAnnouncementBatch } = require('../src/lib/follow-announcement');
const { smsSegments } = require('../src/lib/sms-lifecycle');

const recipients = [
  { id: 1, phone: '+14165551234', first_name: 'Canada', name: 'Canada', email: 'a@example.test' },
  { id: 2, phone: '+14155552671', first_name: 'US', name: 'US', email: 'b@example.test' },
  { id: 3, phone: '+12125552671', first_name: 'US', name: 'US', email: 'c@example.test' }
];
function fixture({ balance = 50, welcome = 50, audience = recipients } = {}) {
  const event = { id: 42, organizer_id: 1, organizer_label: 'Call Me A Taxi Booking', sms_credits: balance,
    sms_welcome_credits: welcome, sms_reminder_enabled: true, status: 'published', visibility: 'public',
    is_tomorrow: true, secret_show_enabled: false, slug: 'x'.repeat(1000) };
  const calls = [];
  let currentBalance = balance;
  const db = { query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (/WITH candidates/.test(sql)) return { rows: [] };
    if (/SELECT DISTINCT ON/.test(sql)) return { rows: audience };
    if (/SELECT \* FROM sms_notification_batches/.test(sql)) return { rows: [] };
    if (/INSERT INTO sms_notification_batches/.test(sql)) return { rows: [{ id: 4 }] };
    if (/SELECT sms_credits,sms_welcome_credits/.test(sql)) return { rows: [{ sms_credits: currentBalance, sms_welcome_credits: welcome }] };
    if (/UPDATE organizers/.test(sql)) { currentBalance -= params[1]; return { rows: [{ sms_credits: currentBalance }] }; }
    if (/UPDATE sms_welcome_claims/.test(sql)) return { rows: [{ id: 5 }] };
    return { rows: [] };
  } };
  return { db, event, calls };
}

test('reminder and follower previews price one credit per recipient, with US-only welcome coverage', async () => {
  for (const previewFor of [makePreview, makeFollowerAnnouncementPreview]) {
    const { db, event } = fixture();
    const preview = await previewFor(db, event);
    assert.equal(preview.segmentCount, 1);
    assert.equal(preview.creditCost, 3);
    assert.equal(preview.welcomeBalance, 50);
    assert.equal(preview.welcomeEligibleCredits, 2);
    assert.equal(preview.usableBalance, 2);
    assert.equal(preview.creditsNeeded, 1);
    assert.equal(preview.needsFunds, true);
    assert.equal(preview.canSend ?? preview.canIncludeTexts, false, 'Canadian +1 number needs paid funds');
  }
});

test('both batch builders reserve one credit each and allocate welcome credits only to eligible recipients', async () => {
  for (const [previewFor, create] of [[makePreview, createReminderBatch], [makeFollowerAnnouncementPreview, createFollowerAnnouncementBatch]]) {
    const { db, event, calls } = fixture({ balance: 52, welcome: 50 });
    const preview = await previewFor(db, event);
    assert.equal(preview.canSend ?? preview.canIncludeTexts, true);
    const result = await create(db, event, preview);
    assert.equal(result.balance, 49);
    const batchInsert = calls.find(call => /INSERT INTO sms_notification_batches/.test(call.sql));
    assert.equal(batchInsert.params.at(-1), 'single_segment_v1');
    const allocations = calls.filter(call => /INSERT INTO sms_notification_recipients/.test(call.sql));
    assert.deepEqual(allocations.map(call => call.params.at(-1)), [0, 1, 1]);
    for (const call of allocations) assert.equal(smsSegments(call.params[5]).segments, 1);
    const balanceChange = calls.find(call => /UPDATE organizers/.test(call.sql));
    assert.deepEqual(balanceChange.params, [1, 3, 2]);
  }
});

test('unsafe APP_URL configurations produce clean blocked previews rather than a two-credit bill', async () => {
  const prior = process.env.APP_URL;
  process.env.APP_URL = `https://example.com/${'x'.repeat(200)}`;
  try {
    for (const previewFor of [makePreview, makeFollowerAnnouncementPreview]) {
      const { db, event } = fixture();
      const preview = await previewFor(db, event);
      assert.equal(preview.canSend ?? preview.canIncludeTexts, false);
      assert.equal(preview.creditCost, 0);
      assert.equal(preview.needsFunds, false);
      assert.match(preview.reason || preview.textReason, /cannot safely fit in one credit/);
    }
  } finally {
    if (prior == null) delete process.env.APP_URL;
    else process.env.APP_URL = prior;
  }
});

test('tampered previews cannot queue a different message or reserve a different cost', async () => {
  for (const [previewFor, create] of [[makePreview, createReminderBatch], [makeFollowerAnnouncementPreview, createFollowerAnnouncementBatch]]) {
    const { db, event, calls } = fixture({ balance: 52 });
    const preview = await previewFor(db, event);
    preview.messageBody = 'Different message. Reply STOP to opt out.';
    await assert.rejects(create(db, event, preview), { code: 'sms_cost_changed' });
    assert.equal(calls.some(call => /INSERT INTO sms_notification_batches/.test(call.sql)), false);
  }
});
