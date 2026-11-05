const test = require('node:test');
const assert = require('node:assert/strict');
const { createSmsService, providerBillingFields } = require('../src/lib/sms');
const { recordWelcomeSmsCost, reconcileWelcomeSmsCosts, getWelcomeSmsCostSummary } = require('../src/lib/sms-costs');

const sid = `SM${'a'.repeat(32)}`;

test('provider billing distinguishes pending, zero, signed charges, currency and actual segments', () => {
  assert.deepEqual(providerBillingFields({ price: null, priceUnit: null, numSegments: '0' }), {
    price: null, priceUnit: null, numSegments: null
  });
  assert.deepEqual(providerBillingFields({ price: '-0.011800', priceUnit: 'usd', numSegments: '1' }), {
    price: '-0.011800', priceUnit: 'USD', numSegments: 1
  });
  assert.deepEqual(providerBillingFields({ price: '0', priceUnit: 'USD', numSegments: 1 }), {
    price: '0', priceUnit: 'USD', numSegments: 1
  });
  assert.equal(providerBillingFields({ price: 'NaN', priceUnit: 'USD secret', numSegments: -1 }).price, null);
});

test('billing retrieval uses a known provider SID and GET/fetch only', async () => {
  let lookups = 0;
  let sends = 0;
  const messages = value => {
    assert.equal(value, sid);
    return { fetch: async () => { lookups++; return { sid, price: '-0.01', priceUnit: 'usd', numSegments: '1', body: 'private' }; } };
  };
  messages.create = async () => { sends++; throw new Error('must not send'); };
  const service = createSmsService({
    env: { TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'mock-only', TWILIO_MESSAGING_SERVICE_SID: `MG${'b'.repeat(32)}` },
    clientFactory: () => ({ messages })
  });
  assert.deepEqual(await service.fetchMessageBilling(sid), { sid, price: '-0.01', priceUnit: 'USD', numSegments: 1 });
  assert.equal(lookups, 1);
  assert.equal(sends, 0);
  await assert.rejects(service.fetchMessageBilling('invalid'), { code: 'invalid_sms_reference' });
  assert.equal(lookups, 1);
});

test('durable cost facts are idempotent by provider SID and never coerce missing costs to zero', async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  assert.equal(await recordWelcomeSmsCost(db, { recipientId: 3, welcomeClaimId: 8, welcomeCredits: 0, result: { sid } }), false);
  assert.equal(calls.length, 0);
  await recordWelcomeSmsCost(db, { recipientId: 3, welcomeClaimId: 8, welcomeCredits: 1, result: { sid } });
  const initialInsert = calls.find(call => /INSERT INTO sms_provider_cost_facts/.test(call.sql));
  assert.deepEqual(initialInsert.params, [sid, 3, 8, 1, null, null, null]);
  assert.match(initialInsert.sql, /ON CONFLICT \(provider_message_sid\)/);
  await recordWelcomeSmsCost(db, { recipientId: 3, welcomeClaimId: 8, welcomeCredits: 1,
    result: { sid, price: '-0.013', priceUnit: 'usd', numSegments: '1' } });
  assert.deepEqual(calls.at(-1).params.slice(4), ['-0.013', 'USD', 1]);
});

test('cost reconciliation is bounded, leased, and keeps unavailable charges pending', async () => {
  const calls = [];
  let fetched = 0;
  const db = { query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (/SELECT r.id,r.provider_message_sid/.test(sql)) return { rows: [] };
    if (/SELECT id,provider_message_sid/.test(sql)) {
      assert.equal(params[0], 25);
      assert.match(sql, /INTERVAL '10 minutes'/);
      return { rows: [{ id: 1, provider_message_sid: sid }, { id: 2, provider_message_sid: `SM${'b'.repeat(32)}` }] };
    }
    if (/RETURNING id/.test(sql)) return { rows: [{ id: params[0] }] };
    return { rows: [] };
  } };
  const result = await reconcileWelcomeSmsCosts({ db, limit: 10000, fetchBilling: async () => {
    fetched++;
    if (fetched === 2) throw Object.assign(new Error('private provider details'), { code: 'sms_provider_unavailable' });
    return { sid, price: null, priceUnit: 'USD', numSegments: 1 };
  } });
  assert.equal(result.checked, 2);
  assert.equal(fetched, 2);
  assert.ok(calls.some(call => /provider_price=COALESCE/.test(call.sql) && call.params[1] === null));
  assert.ok(calls.some(call => /price_error_code=\$2/.test(call.sql) && call.params[1] === 'sms_provider_unavailable'));
  assert.equal(JSON.stringify(calls).includes('private provider details'), false);
  assert.equal(calls.some(call => /status='pending'|attempt_count|\.create/.test(call.sql)), false);
});

test('super-admin summary reports only actual USD charges and flags pending/other currencies', async () => {
  const db = { query: async sql => {
    assert.match(sql, /SUM\(ABS\(provider_price\)\) FILTER \(WHERE price_unit='USD'\)/);
    return { rows: [{ accepted_texts: '4', welcome_credits_used: '4', recorded_texts: '2', pending_texts: '1',
      non_usd_texts: '1', recorded_usd_cost: '0.02360000', provider_segments: '4', last_checked_at: '2030-01-01', as_of: '2030-01-02' }] };
  } };
  const summary = await getWelcomeSmsCostSummary(db);
  assert.equal(summary.recordedUsdCost, 0.0236);
  assert.equal(summary.pendingTexts, 1);
  assert.equal(summary.nonUsdTexts, 1);
  assert.equal(summary.welcomeCreditsUsed, 4);
  assert.match(summary.scope, /excludes Verify/);
  const pending = await getWelcomeSmsCostSummary({ query: async () => ({ rows: [{ accepted_texts: 1, pending_texts: 1, recorded_usd_cost: null }] }) });
  assert.equal(pending.recordedUsdCost, null);
});

test('new template send guard leaves old batches untouched and cost-write failures cannot retry an accepted text', async t => {
  const pool = require('../src/config/db');
  const sms = require('../src/lib/sms');
  const outbound = require('../src/lib/outbound-account-status');
  const { buildTomorrowMessage } = require('../src/lib/sms-lifecycle');
  const calls = [];
  let sent = 0;
  let failCosts = false;
  let batch = {};
  let delivery = {};
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (/SELECT b\.\*/.test(sql) || /SELECT \* FROM sms_notification_batches/.test(sql)) return { rows: [batch] };
    if (/SELECT sr.id/.test(sql)) return { rows: [delivery] };
    if (/RETURNING attempt_count/.test(sql)) return { rows: [{ attempt_count: 1 }] };
    if (/SELECT 1 FROM rsvps/.test(sql)) return { rows: [{}] };
    if (/INSERT INTO sms_provider_cost_facts/.test(sql) && /acceptance_state/.test(sql)) return { rows: [{ id: 1 }] };
    if (/^UPDATE sms_provider_cost_facts SET provider_message_sid/.test(sql) && failCosts) throw new Error('mock cost write unavailable');
    if (/AS accepted/.test(sql)) return { rows: [{ accepted: sent, delivered: 0, failed: 0, outstanding: 0, refundable: 0, welcome_refundable: 0 }] };
    return { rows: [] };
  };
  const client = { query, release() {} };
  t.mock.method(pool, 'query', query);
  t.mock.method(pool, 'connect', async () => client);
  t.mock.method(sms, 'sendSms', async () => { sent++; return { sid, status: 'accepted', price: null, priceUnit: null, numSegments: null }; });
  t.mock.method(outbound, 'withActiveHostAccount', async (_pool, _id, send) => ({ allowed: true, result: await send(client) }));
  t.mock.method(console, 'error', () => {});
  const { processSmsBatch } = require('../src/jobs/sms-notifications');
  const reset = (templateVersion, body, welcomeCredits = 0) => {
    calls.length = 0; sent = 0;
    batch = { id: 10, organizer_id: 1, event_id: 2, kind: 'event_tomorrow', template_version: templateVersion,
      message_body: body, refunded_credits: 0, welcome_claim_id: 8 };
    delivery = { id: 11, rsvp_id: 12, recipient: '+14155552671', status_token: 'mock', message_body: body, welcome_credits: welcomeCredits };
  };
  reset(null, '☃'.repeat(150));
  await processSmsBatch(10);
  assert.equal(sent, 1, 'legacy batches keep their reviewed message');
  reset('single_segment_v1', '☃'.repeat(150));
  await processSmsBatch(10);
  assert.equal(sent, 0, 'new oversized/Unicode payloads never reach Twilio');
  assert.ok(calls.some(call => call.params.includes('sms_single_segment_required')));
  reset('single_segment_v1', buildTomorrowMessage({ organizer_label: 'Host' }, undefined, 'a'.repeat(32)), 1);
  failCosts = true;
  await processSmsBatch(10);
  assert.equal(sent, 1);
  const persisted = calls.findIndex(call => /provider_message_sid=COALESCE/.test(call.sql));
  const cost = calls.findIndex(call => /^UPDATE sms_provider_cost_facts SET provider_message_sid/.test(call.sql));
  assert.ok(persisted >= 0 && cost > persisted, 'provider acceptance is committed before optional accounting');
  assert.equal(calls.some(call => /status='failed',attempt_count=CASE/.test(call.sql)), false);
});
