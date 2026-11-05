const sms = require('../../src/lib/sms');
const { SMS_CONSENT_VERSION } = require('../../src/lib/sms-consent');
const { createReminderBatch, eventForSms, makePreview } = require('../../src/lib/sms-reminder-fulfillment');
const { processSmsBatch, finalizeSmsBatch } = require('../../src/jobs/sms-notifications');
const { backfillWelcomeSmsCosts, reconcileWelcomeSmsCosts, getWelcomeSmsCostSummary } = require('../../src/lib/sms-costs');

module.exports = function register({ test, assert, pool, createEvent, createRsvp, getOrganizerId, getBaseUrl }) {
  async function prepare({ paidCredits = 0, phones = ['+14155552671'] } = {}) {
    const hostId = getOrganizerId();
    await pool.query("INSERT INTO sms_welcome_campaigns(campaign_key,identity_hmac_key) VALUES ('welcome-texts-v1','mock-secret-only')");
    const claim = (await pool.query(
      `INSERT INTO sms_welcome_claims(campaign_key,organizer_id,account_key,email_key,phone_key)
       VALUES ('welcome-texts-v1',$1,'mock-account-key','mock-email-key','mock-phone-key') RETURNING id`, [hostId]
    )).rows[0];
    await pool.query('UPDATE organizers SET sms_credits=$2,sms_welcome_credits=50 WHERE id=$1', [hostId, 50 + paidCredits]);
    const event = await createEvent({ sms_reminder_enabled: true });
    const guests = [];
    for (const phone of phones) guests.push(await createRsvp(event.id, {
      phone, sms_optin: true, sms_consent_at: new Date(), sms_consent_source: 'event_rsvp',
      sms_consent_text: 'One text reminder for this event.', sms_consent_version: SMS_CONSENT_VERSION
    }));
    const client = await pool.connect();
    let created;
    try {
      await client.query('BEGIN');
      const stored = await eventForSms(client, event.id, hostId, { lock: true });
      const preview = await makePreview(client, stored, { requireTomorrow: false });
      assert.equal(preview.canSend, true);
      assert.equal(preview.creditCost, phones.length);
      created = await createReminderBatch(client, stored, preview);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return { event, guests, claim, batch: created.batch };
  }

  test('provider SMS cost lifecycle keeps accepted charges pending then durable after account deletion', async t => {
    const fixture = await prepare();
    const sid = `SM${'1'.repeat(32)}`;
    let sends = 0;
    t.mock.method(sms, 'sendSms', async ({ body }) => {
      sends++;
      assert.ok(body.length <= 160);
      assert.match(body, /\/t\/[a-f0-9]{32} Reply STOP to opt out\.$/);
      return { sid, status: 'accepted', price: null, priceUnit: null, numSegments: null };
    });
    await processSmsBatch(fixture.batch.id);
    let summary = await getWelcomeSmsCostSummary(pool);
    assert.equal(sends, 1);
    assert.equal(summary.acceptedTexts, 1);
    assert.equal(summary.pendingTexts, 1);
    assert.equal(summary.recordedUsdCost, null);
    assert.equal((await pool.query('SELECT accepted_credits FROM sms_welcome_claims WHERE id=$1', [fixture.claim.id])).rows[0].accepted_credits, 1);
    await pool.query('DELETE FROM events WHERE id=$1', [fixture.event.id]);
    await pool.query('DELETE FROM organizers WHERE id=$1', [getOrganizerId()]);
    await pool.query('DELETE FROM users WHERE id=$1', [getOrganizerId()]);
    let fetched = 0;
    await reconcileWelcomeSmsCosts({ db: pool, fetchBilling: async requested => {
      fetched++;
      assert.equal(requested, sid);
      return { sid, price: '-0.0123', priceUnit: 'usd', numSegments: '1' };
    } });
    summary = await getWelcomeSmsCostSummary(pool);
    assert.equal(fetched, 1);
    assert.equal(sends, 1, 'cost fetching never redelivers a text');
    assert.equal(summary.recordedUsdCost, 0.0123);
    assert.equal(summary.recordedTexts, 1);
    assert.equal(summary.pendingTexts, 0);
    const fact = (await pool.query('SELECT * FROM sms_provider_cost_facts')).rows[0];
    assert.equal(fact.notification_recipient_id, null);
    assert.equal(fact.welcome_claim_id, fixture.claim.id);
    assert.equal(fact.provider_price, '-0.01230000');
    assert.equal(fact.price_unit, 'USD');
    assert.equal(fact.provider_segments, 1);
  });

  test('provider SMS cost backfill handles callback-first acceptance idempotently and preserves known zero', async () => {
    const fixture = await prepare();
    const sid = `SM${'2'.repeat(32)}`;
    await pool.query(
      "UPDATE sms_notification_recipients SET provider_message_sid=$2,status='delivered' WHERE batch_id=$1",
      [fixture.batch.id,sid]
    );
    assert.equal(await backfillWelcomeSmsCosts(pool), 1);
    assert.equal(await backfillWelcomeSmsCosts(pool), 0);
    assert.equal((await pool.query('SELECT accepted_credits FROM sms_welcome_claims WHERE id=$1', [fixture.claim.id])).rows[0].accepted_credits, 1);
    await reconcileWelcomeSmsCosts({ db: pool, fetchBilling: async () => ({ sid, price: '0.0000', priceUnit: 'USD', numSegments: 1 }) });
    const summary = await getWelcomeSmsCostSummary(pool);
    assert.equal(summary.acceptedTexts, 1);
    assert.equal(summary.recordedTexts, 1);
    assert.equal(summary.pendingTexts, 0);
    assert.equal(summary.recordedUsdCost, 0);
    const recipient = (await pool.query('SELECT provider_price,provider_num_segments FROM sms_notification_recipients WHERE batch_id=$1', [fixture.batch.id])).rows[0];
    assert.equal(recipient.provider_price, '0.00000000');
    assert.equal(recipient.provider_num_segments, 1);
  });

  test('provider SMS cost attribution excludes paid destinations and refunds revoked welcome consent once', async t => {
    const fixture = await prepare({ paidCredits: 2, phones: ['+14165551234','+14155552671','+12125552671'] });
    const revoked = fixture.guests.find(guest => guest.phone === '+12125552671');
    await pool.query('UPDATE rsvps SET sms_optin=FALSE,sms_opted_out_at=NOW() WHERE id=$1', [revoked.id]);
    let sends = 0;
    t.mock.method(sms, 'sendSms', async () => ({ sid: `SM${String(++sends).padStart(32, '0')}`, status: 'accepted', price: '-0.0118', priceUnit: 'USD', numSegments: 1 }));
    await processSmsBatch(fixture.batch.id);
    await finalizeSmsBatch(fixture.batch.id);
    assert.equal(sends, 2);
    const wallet = (await pool.query('SELECT sms_credits,sms_welcome_credits FROM organizers WHERE id=$1', [getOrganizerId()])).rows[0];
    assert.deepEqual(wallet, { sms_credits: 50, sms_welcome_credits: 49 });
    const claim = (await pool.query('SELECT funded_credits,accepted_credits FROM sms_welcome_claims WHERE id=$1', [fixture.claim.id])).rows[0];
    assert.deepEqual(claim, { funded_credits: 1, accepted_credits: 1 });
    const summary = await getWelcomeSmsCostSummary(pool);
    assert.equal(summary.acceptedTexts, 1, 'Canadian paid text is not a complimentary text cost');
    assert.equal(summary.recordedUsdCost, 0.0118);
    const batch = (await pool.query('SELECT refunded_credits,welcome_refunded_credits FROM sms_notification_batches WHERE id=$1', [fixture.batch.id])).rows[0];
    assert.deepEqual(batch, { refunded_credits: 1, welcome_refunded_credits: 1 });
  });

  test('provider SMS cost unknown acceptance is held without retry and survives deletion as uncertain', async t => {
    const fixture = await prepare();
    let sends = 0;
    t.mock.method(console, 'error', () => {});
    t.mock.method(sms, 'sendSms', async () => {
      sends++;
      const before = (await pool.query('SELECT acceptance_state,provider_message_sid FROM sms_provider_cost_facts')).rows[0];
      assert.deepEqual(before, { acceptance_state: 'pending', provider_message_sid: null });
      throw Object.assign(new Error('mock timeout after POST'), { code: 'sms_provider_unavailable', acceptance: 'unknown' });
    });
    await processSmsBatch(fixture.batch.id);
    await processSmsBatch(fixture.batch.id);
    assert.equal(sends, 1);
    const recipient = (await pool.query('SELECT status,provider_error_code,attempt_count FROM sms_notification_recipients WHERE batch_id=$1', [fixture.batch.id])).rows[0];
    assert.deepEqual(recipient, { status: 'processing', provider_error_code: 'sms_acceptance_unknown', attempt_count: 3 });
    await pool.query('DELETE FROM events WHERE id=$1', [fixture.event.id]);
    await pool.query('DELETE FROM organizers WHERE id=$1', [getOrganizerId()]);
    const summary = await getWelcomeSmsCostSummary(pool);
    assert.equal(summary.acceptedTexts, 0);
    assert.equal(summary.unknownAcceptanceTexts, 1);
    assert.equal(summary.recordedUsdCost, null);
    let fetched = 0;
    await reconcileWelcomeSmsCosts({ db: pool, fetchBilling: async () => { fetched++; throw new Error('must not fetch without SID'); } });
    assert.equal(fetched, 0);
  });

  test('provider SMS cost known SID survives pricing-write failure then deletion before reconciliation', async t => {
    const fixture = await prepare();
    const sid = `SM${'4'.repeat(32)}`;
    const connect = pool.connect.bind(pool);
    t.mock.method(pool, 'connect', function (callback) {
      if (typeof callback === 'function') return connect(callback);
      return connect().then(client => ({
        query: (sql, params) => {
          if (/^UPDATE sms_provider_cost_facts SET provider_message_sid=\$2/.test(sql)) {
            throw new Error('mock optional pricing transaction failed');
          }
          return client.query(sql, params);
        },
        release: error => client.release(error)
      }));
    });
    t.mock.method(console, 'error', () => {});
    let sends = 0;
    t.mock.method(sms, 'sendSms', async () => { sends++; return { sid, status: 'accepted', price: '-0.0123', priceUnit: 'USD', numSegments: 1 }; });
    await processSmsBatch(fixture.batch.id);
    const fact = (await pool.query('SELECT provider_message_sid,provider_price,acceptance_state FROM sms_provider_cost_facts')).rows[0];
    assert.deepEqual(fact, { provider_message_sid: sid, provider_price: null, acceptance_state: 'accepted' });
    await pool.query('DELETE FROM events WHERE id=$1', [fixture.event.id]);
    await pool.query('DELETE FROM organizers WHERE id=$1', [getOrganizerId()]);
    await reconcileWelcomeSmsCosts({ db: pool, fetchBilling: async requested => {
      assert.equal(requested, sid);
      return { sid, price: '-0.0123', priceUnit: 'USD', numSegments: 1 };
    } });
    const summary = await getWelcomeSmsCostSummary(pool);
    assert.equal(sends, 1);
    assert.equal(summary.acceptedTexts, 1);
    assert.equal(summary.recordedUsdCost, 0.0123);
    assert.equal(summary.pendingTexts, 0);
  });

  test('provider SMS cost definitive rejection can retry without duplicating a cost fact', async t => {
    const fixture = await prepare();
    let sends = 0;
    const sid = `SM${'5'.repeat(32)}`;
    t.mock.method(console, 'error', () => {});
    t.mock.method(sms, 'sendSms', async () => {
      sends++;
      if (sends === 1) throw Object.assign(new Error('mock definite HTTP 429'), {
        code: 'sms_provider_unavailable', acceptance: 'not_sent'
      });
      return { sid, status: 'accepted', price: '-0.01', priceUnit: 'USD', numSegments: 1 };
    });
    await processSmsBatch(fixture.batch.id);
    let summary = await getWelcomeSmsCostSummary(pool);
    assert.equal(summary.acceptedTexts, 0);
    assert.equal(summary.unknownAcceptanceTexts, 0);
    assert.equal((await pool.query('SELECT acceptance_state FROM sms_provider_cost_facts')).rows[0].acceptance_state, 'not_sent');
    await pool.query("UPDATE sms_notification_recipients SET last_attempt_at=NOW()-INTERVAL '3 minutes' WHERE batch_id=$1", [fixture.batch.id]);
    await processSmsBatch(fixture.batch.id);
    summary = await getWelcomeSmsCostSummary(pool);
    assert.equal(sends, 2);
    assert.equal(summary.acceptedTexts, 1);
    assert.equal(summary.recordedUsdCost, 0.01);
    assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM sms_provider_cost_facts')).rows[0].count), 1);
  });

  test('provider SMS cost signed callback resolves an unknown attempt atomically before deletion', async t => {
    const fixture = await prepare();
    const sid = `SM${'6'.repeat(32)}`;
    let sends = 0;
    t.mock.method(console, 'error', () => {});
    t.mock.method(sms, 'sendSms', async () => {
      sends++;
      throw Object.assign(new Error('mock unknown POST outcome'), { code: 'sms_provider_unavailable', acceptance: 'unknown' });
    });
    await processSmsBatch(fixture.batch.id);
    const recipient = (await pool.query('SELECT status_token FROM sms_notification_recipients WHERE batch_id=$1', [fixture.batch.id])).rows[0];
    // The test server disables signature validation; production keeps the
    // existing Twilio signature-verification middleware on this same route.
    const callback = await fetch(`${getBaseUrl()}/api/webhooks/twilio/status/${recipient.status_token}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ MessageSid: sid, MessageStatus: 'delivered' })
    });
    assert.equal(callback.status, 204);
    const fact = (await pool.query('SELECT provider_message_sid,acceptance_state FROM sms_provider_cost_facts')).rows[0];
    assert.deepEqual(fact, { provider_message_sid: sid, acceptance_state: 'accepted' });
    await pool.query('DELETE FROM events WHERE id=$1', [fixture.event.id]);
    const summary = await getWelcomeSmsCostSummary(pool);
    assert.equal(summary.acceptedTexts, 1);
    assert.equal(summary.unknownAcceptanceTexts, 0);
    assert.equal(summary.pendingTexts, 1);
    assert.equal(sends, 1);
  });
};
