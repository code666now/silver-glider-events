const welcome = require('../../src/lib/sms-welcome');
const ledger = require('../../src/lib/sms-credit-ledger');
const { SMS_CONSENT_VERSION } = require('../../src/lib/sms-consent');

module.exports = function registerSmsWelcomeCases({
  test, assert, pool, getOrganizerId, createEvent, createRsvp, getBaseUrl, signSession, addVerifiedEmailIdentity
}) {
  const env = { SMS_CREDITS_ENABLED: 'true', STRIPE_SMS_SECRET_KEY: 'sk_live_welcome_test', SMS_WELCOME_ENABLED: 'true' };
  const host = () => ({ id: getOrganizerId(), is_admin: false });

  async function verify(id = getOrganizerId(), email = 'welcome@example.test', phone = '+14155552671') {
    await addVerifiedEmailIdentity(id, email);
    await pool.query(
      `INSERT INTO user_identities(user_id,identity_type,value,normalized_value,verified_at,
        verification_scope,verification_source,is_primary)
       VALUES ($1,'phone',$2,$2,NOW(),'account','welcome_integration',TRUE)`, [id, phone]
    );
  }
  async function claim(organizer = host()) {
    const state = await welcome.welcomeStatus(pool, organizer, { env });
    assert.equal(state.state, 'eligible');
    return welcome.claimWelcomeCredits(pool, organizer, { env, confirm: true, previewFingerprint: state.previewFingerprint });
  }
  async function batch(event, cost) {
    return (await pool.query(
      `INSERT INTO sms_notification_batches(event_id,organizer_id,kind,message_body,segment_count,recipient_count,credit_cost)
       VALUES ($1,$2,'event_tomorrow','Integration fixture only',1,$3,$3) RETURNING id`,
      [event.id, getOrganizerId(), cost]
    )).rows[0];
  }

  test('welcome texts require publication, account-scoped email and phone proofs, active account, and campaign access', async () => {
    assert.equal((await welcome.welcomeStatus(pool, host(), { env })).state, 'needs_event');
    const event = await createEvent({ status: 'draft' });
    assert.equal((await welcome.welcomeStatus(pool, host(), { env })).state, 'needs_event');
    await pool.query("UPDATE events SET status='published' WHERE id=$1", [event.id]);
    let state = await welcome.welcomeStatus(pool, host(), { env });
    assert.equal(state.state, 'needs_verification');
    assert.deepEqual(state.missingVerification, ['email', 'phone']);
    await verify();
    state = await welcome.welcomeStatus(pool, host(), { env });
    assert.equal(state.state, 'eligible');
    assert.equal(state.firstPublishedEventId, String(event.id));
    assert.equal(state.firstEventRecentlyPublished, true);
    assert.equal(state.shareEventUrl, `/e/${event.slug}`);
    assert.equal(state.hostPageUrl, '/h/test-host');
    assert.equal((await welcome.welcomeStatus(pool, host(), { env: { ...env, SMS_WELCOME_ENABLED: 'false' } })).state, 'disabled');
    assert.equal((await welcome.welcomeStatus(pool, host(), { env: { ...env, SMS_WELCOME_CLAIM_CAP: '0' } })).state, 'unavailable');
    await pool.query("UPDATE users SET account_status='suspended',suspended_at=NOW(),suspension_reason='Welcome eligibility test' WHERE id=$1", [getOrganizerId()]);
    assert.equal((await welcome.welcomeStatus(pool, host(), { env })).state, 'unavailable');
  });

  test('welcome claim is explicit, additive, concurrent-idempotent, and creates no notifications', async () => {
    const event = await createEvent({ sms_reminder_enabled: false });
    await verify();
    await pool.query('UPDATE organizers SET sms_credits=7 WHERE id=$1', [getOrganizerId()]);
    const state = await welcome.welcomeStatus(pool, host(), { env });
    await assert.rejects(welcome.claimWelcomeCredits(pool, host(), { env, previewFingerprint: state.previewFingerprint }),
      error => error.code === 'welcome_confirmation_required');
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      welcome.claimWelcomeCredits(pool, host(), { env, confirm: true, previewFingerprint: state.previewFingerprint })));
    assert.equal(results.filter(result => !result.duplicate).length, 1);
    assert.ok(results.every(result => result.balance === 57));
    const summary = await ledger.creditSummary(pool, getOrganizerId());
    assert.equal(summary.balance, 57);
    assert.equal(summary.welcomeBalance, 50);
    assert.equal(summary.transactions.length, 1);
    assert.equal(summary.transactions[0].reason, 'welcome_credit');
    assert.equal((await pool.query('SELECT sms_reminder_enabled FROM events WHERE id=$1', [event.id])).rows[0].sms_reminder_enabled, false);
    assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM sms_notification_batches')).rows[0].count), 0);
  });

  test('welcome claim rejects a stale scheduled-reminder estimate without granting or sending', async () => {
    const event = await createEvent({ sms_reminder_enabled: true });
    await verify();
    const consent = { sms_optin: true, sms_consent_at: new Date(), sms_consent_source: 'event_rsvp',
      sms_consent_text: 'One reminder for this event.', sms_consent_version: SMS_CONSENT_VERSION, status: 'confirmed' };
    await createRsvp(event.id, { ...consent, phone: '+14155552671' });
    const before = await welcome.welcomeStatus(pool, host(), { env });
    assert.equal(before.pendingReminderCredits, 1);
    await createRsvp(event.id, { ...consent, phone: '+12025550123' });
    await assert.rejects(welcome.claimWelcomeCredits(pool, host(), { env, confirm: true, previewFingerprint: before.previewFingerprint }),
      error => error.code === 'welcome_preview_changed' && error.welcome.pendingReminderCredits === 2);
    assert.equal((await ledger.creditSummary(pool, getOrganizerId())).balance, 0);
    const result = await claim();
    assert.equal(result.welcome.pendingReminderCredits, 2);
    assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM sms_notification_batches')).rows[0].count), 0);
  });

  test('welcome grant history survives deletion and blocks reuse of verified identities', async () => {
    await createEvent();
    await verify();
    await claim();
    const oldId = getOrganizerId();
    await pool.query('DELETE FROM events WHERE organizer_id=$1', [oldId]);
    await pool.query('DELETE FROM organizers WHERE id=$1', [oldId]);
    await pool.query('DELETE FROM users WHERE id=$1', [oldId]);
    const other = (await pool.query(
      "INSERT INTO organizers(email,name) VALUES ('replacement@example.test','Replacement') RETURNING id"
    )).rows[0];
    await verify(other.id);
    await pool.query(
      `INSERT INTO events(organizer_id,slug,title,event_date,start_time,venue_name,status)
       VALUES ($1,'replacement-event','Replacement','2030-08-10','19:30','Hall','published')`, [other.id]
    );
    assert.equal((await welcome.welcomeStatus(pool, { id: other.id }, { env })).state, 'unavailable');
    const summary = await welcome.getWelcomeCampaignSummary(pool, { env });
    assert.equal(summary.claims, 1);
    assert.equal(summary.creditsGranted, 50);
    assert.equal(summary.creditsRemaining, 0);
    assert.equal(summary.deletedRemainingCredits, 50);
    const stored = (await pool.query('SELECT * FROM sms_welcome_claims')).rows[0];
    assert.equal(stored.organizer_id, null);
    assert.match(stored.email_key, /^[a-f0-9]{64}$/);
    assert.match(stored.phone_key, /^[a-f0-9]{64}$/);
  });

  test('welcome campaign cap serializes concurrent claims across different accounts', async () => {
    await createEvent();
    await verify();
    const second = (await pool.query(
      "INSERT INTO organizers(email,name) VALUES ('second-welcome@example.test','Second Host') RETURNING id"
    )).rows[0];
    await verify(second.id, 'second-welcome@example.test', '+12025550123');
    await pool.query(
      `INSERT INTO events(organizer_id,slug,title,event_date,start_time,venue_name,status)
       VALUES ($1,'second-welcome-event','Second Event','2030-08-10','19:30','Hall','published')`, [second.id]
    );
    const cappedEnv = { ...env, SMS_WELCOME_CLAIM_CAP: '1' };
    const hosts = [host(), { id: second.id }];
    const states = await Promise.all(hosts.map(organizer => welcome.welcomeStatus(pool, organizer, { env: cappedEnv })));
    assert.ok(states.every(state => state.state === 'eligible'));
    const results = await Promise.allSettled(hosts.map((organizer, index) => welcome.claimWelcomeCredits(pool, organizer, {
      env: cappedEnv, confirm: true, previewFingerprint: states[index].previewFingerprint
    })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'welcome_unavailable');
    const summary = await welcome.getWelcomeCampaignSummary(pool, { env: cappedEnv });
    assert.equal(summary.claims, 1);
    assert.equal(summary.creditsGranted, 50);
    assert.equal(summary.cap, 1);
  });

  test('welcome outstanding-credit totals exclude a deleted canonical-account tombstone', async () => {
    await createEvent();
    await verify();
    await claim();
    await pool.query(
      `UPDATE users SET name=NULL,account_status='deleted',deleted_at=NOW(),
        deletion_reason='Welcome cost test' WHERE id=$1`, [getOrganizerId()]
    );
    const summary = await welcome.getWelcomeCampaignSummary(pool, { env });
    assert.equal(summary.claims, 1);
    assert.equal(summary.creditsGranted, 50);
    assert.equal(summary.creditsRemaining, 0);
    assert.equal(summary.deletedRemainingCredits, 50);
    assert.equal((await welcome.welcomeStatus(pool, host(), { env })).state, 'unavailable');
  });

  test('welcome allocation is US-only, welcome-first, refundable exactly once, and does not erase paid debt', async () => {
    const event = await createEvent();
    await verify();
    await claim();
    const delivery = await batch(event, 4);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(ledger.reserveSendCreditsDetailed(client, {
        organizerId: getOrganizerId(), batchId: delivery.id, credits: 4, maxWelcomeCredits: 3
      }), error => error.code === 'insufficient_sms_credits');
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query('UPDATE organizers SET sms_credits=sms_credits+10 WHERE id=$1', [getOrganizerId()]);
      const reserved = await ledger.reserveSendCreditsDetailed(client, {
        organizerId: getOrganizerId(), batchId: delivery.id, credits: 4, maxWelcomeCredits: 3
      });
      assert.equal(reserved.balance, 56);
      assert.equal(reserved.welcomeCredits, 3);
      const accepted = (await client.query(
        `INSERT INTO sms_notification_recipients(batch_id,recipient,segment_count,welcome_credits,provider_message_sid)
         VALUES ($1,'+14155552671',1,1,'SMwelcomeintegration') RETURNING id`, [delivery.id]
      )).rows[0];
      assert.equal(await ledger.accountWelcomeSmsAccepted(client, accepted.id), true);
      assert.equal(await ledger.accountWelcomeSmsAccepted(client, accepted.id), false);
      assert.equal(await ledger.refundSendCredits(client, {
        organizerId: getOrganizerId(), batchId: delivery.id, credits: 2, welcomeRefundCredits: 1
      }), 58);
      assert.equal(await ledger.refundSendCredits(client, {
        organizerId: getOrganizerId(), batchId: delivery.id, credits: 2, welcomeRefundCredits: 1
      }), 58);
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
    const summary = await welcome.getWelcomeCampaignSummary(pool, { env });
    assert.equal(summary.creditsRemaining, 48);
    assert.equal(summary.creditsReserved, 2);
    assert.equal(summary.acceptedCredits, 1);
    // A purchase reversal can leave debt; the gift must not turn it into paid funds.
    await pool.query('UPDATE organizers SET sms_credits=-1 WHERE id=$1', [getOrganizerId()]);
    const debtor = await pool.connect();
    try {
      await debtor.query('BEGIN');
      await assert.rejects(ledger.reserveSendCreditsDetailed(debtor, {
        organizerId: getOrganizerId(), batchId: delivery.id, credits: 1, maxWelcomeCredits: 1
      }), error => error.code === 'insufficient_sms_credits');
      await debtor.query('ROLLBACK');
    } finally { debtor.release(); }
    assert.equal((await ledger.creditSummary(pool, getOrganizerId())).welcomeBalance, 48);
  });

  test('welcome HTTP claim is owner-scoped, CSRF-protected, and checkout status trusts only confirmed local records', async () => {
    const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    try {
      await createEvent();
      await verify();
      const cookie = `sge_session=${signSession(getOrganizerId())}`;
      const baseUrl = getBaseUrl();
      const signedOutGet = await fetch(`${baseUrl}/api/sms-credits/welcome`);
      assert.equal(signedOutGet.status, 401);
      const signedOutClaim = await fetch(`${baseUrl}/api/sms-credits/welcome/claim`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true, organizerId: getOrganizerId() })
      });
      assert.equal(signedOutClaim.status, 401);
      const initial = await fetch(`${baseUrl}/api/sms-credits/welcome`, { headers: { cookie } });
      assert.equal(initial.status, 200);
      const state = await initial.json();
      assert.equal(state.state, 'eligible');
      const otherHost = (await pool.query(
        "INSERT INTO organizers(email,name) VALUES ('not-the-claimant@example.test','Another Host') RETURNING id"
      )).rows[0];
      const blocked = await fetch(`${baseUrl}/api/sms-credits/welcome/claim`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: 'https://untrusted.example' },
        body: JSON.stringify({ confirm: true, previewFingerprint: state.previewFingerprint })
      });
      assert.equal(blocked.status, 403);
      const claimed = await fetch(`${baseUrl}/api/sms-credits/welcome/claim`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: baseUrl },
        body: JSON.stringify({ confirm: true, previewFingerprint: state.previewFingerprint,
          organizerId: otherHost.id, credits: 5000 })
      });
      assert.equal(claimed.status, 200);
      const claimResult = await claimed.json();
      assert.equal(claimResult.balance, 50);
      assert.equal(claimResult.duplicate, false);
      assert.equal((await ledger.creditSummary(pool, otherHost.id)).balance, 0);
      const repeated = await fetch(`${baseUrl}/api/sms-credits/welcome/claim`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: baseUrl },
        body: JSON.stringify({ confirm: true, previewFingerprint: state.previewFingerprint })
      });
      assert.equal(repeated.status, 200);
      const duplicateResult = await repeated.json();
      assert.equal(duplicateResult.duplicate, true);
      assert.equal(duplicateResult.balance, 50);
      assert.equal((await ledger.creditSummary(pool, getOrganizerId())).transactions.length, 1);
      const purchase = await ledger.createPendingPurchase(pool, getOrganizerId(), ledger.packForKey('starter'), 'stripe');
      const session = 'cs_test_welcome_checkout_status';
      await ledger.attachProviderOrder(pool, purchase.id, getOrganizerId(), session, 'stripe');
      const pending = await fetch(`${baseUrl}/api/sms-credits/checkout-sessions/${session}`, { headers: { cookie } });
      assert.deepEqual(await pending.json(), { status: 'pending', credited: false, balance: 50, credits: 300 });
      const unknown = await fetch(`${baseUrl}/api/sms-credits/checkout-sessions/cs_test_another_owner_session`, { headers: { cookie } });
      assert.equal(unknown.status, 404);
      await ledger.completePurchase(pool, { provider: 'stripe', orderId: session, captureId: 'pi_welcome_test',
        reference: purchase.reference, amountCents: 2000, currency: 'USD' });
      const completed = await fetch(`${baseUrl}/api/sms-credits/checkout-sessions/${session}`, { headers: { cookie } });
      assert.deepEqual(await completed.json(), { status: 'completed', credited: true, balance: 350, credits: 300 });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
};
