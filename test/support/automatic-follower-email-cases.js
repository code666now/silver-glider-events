// HTTP and isolated-Postgres coverage. Every worker pass uses an injected
// provider; the app's background cron is not started by the test harness.
module.exports = function registerAutomaticFollowerEmailCases({
  test, assert, pool, createEvent, createRsvp, getOrganizerId, getBaseUrl, signSession
}) {
  const { runAutomaticFollowerEmailPass } = require('../../src/jobs/automatic-follower-email');
  const { recordLegalAcceptance } = require('../../src/lib/legal-acceptance');
  const dueTime = new Date('2099-08-01T18:00:00.000Z');
  const offset = (minutes, from = dueTime) => new Date(from.getTime() + minutes * 60_000);
  let serial = 0;

  function featureCase(name, work) {
    test(`automatic follower email ${name}`, async () => {
      const previous = process.env.AUTO_FOLLOWER_EMAIL_ENABLED;
      process.env.AUTO_FOLLOWER_EMAIL_ENABLED = 'true';
      try { await work(); }
      finally {
        if (previous === undefined) delete process.env.AUTO_FOLLOWER_EMAIL_ENABLED;
        else process.env.AUTO_FOLLOWER_EMAIL_ENABLED = previous;
      }
    });
  }
  function request(path, { method = 'GET', body, organizerId = getOrganizerId() } = {}) {
    return fetch(`${getBaseUrl()}${path}`, {
      method,
      redirect: 'manual',
      headers: { cookie: `sge_session=${signSession(organizerId)}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  }
  async function json(path, options, expected = 200) {
    const response = await request(path, options);
    const body = await response.json();
    assert.equal(response.status, expected, JSON.stringify(body));
    return body;
  }
  async function postEvent(overrides = {}) {
    const body = { title: `Automatic night ${++serial}`, status: 'published', visibility: 'public',
      event_date: '2099-08-10', start_time: '19:30', venue_name: 'Test Hall',
      venue_address: '10 Test Way', ...overrides };
    return (await json('/api/events', { method: 'POST', body }, 201)).event;
  }
  const publish = (event, body = {}) => json(`/api/events/${event.id}/publish`, { method: 'POST', body });
  const status = event => json(`/api/events/${event.id}/followers`);
  const control = (event, action, options = {}, expected = 200) => json(`/api/events/${event.id}/automatic-follower-email`,
    { method: 'POST', body: { action }, ...options }, expected);
  const settings = enabled => typeof enabled === 'boolean'
    ? json('/api/settings/follower-email', { method: 'PATCH', body: { enabled } })
    : json('/api/settings/follower-email');
  const job = async event => (await pool.query(
    'SELECT * FROM automatic_follower_email_events WHERE event_id=$1', [event.id]
  )).rows[0];
  async function due(event, when = dueTime) {
    assert.equal((await pool.query('UPDATE automatic_follower_email_events SET available_at=$2 WHERE event_id=$1',
      [event.id, when])).rowCount, 1);
  }
  async function pastGuests(...addresses) {
    const past = await createEvent({ slug: `automatic-past-${++serial}`, event_date: '2021-01-01' });
    for (const email of addresses) await createRsvp(past.id, { email, organizer_optin: true });
    return past;
  }
  async function logs(event) {
    return (await pool.query(
      `SELECT recipient,status,provider_id,automatic_follower_email_delivery_id AS delivery_id,
              automatic_follower_email_next_at AS next_at,error
         FROM message_log WHERE event_id=$1 AND message_type='announcement' ORDER BY recipient`, [event.id]
    )).rows;
  }
  function worker(outcome = async () => ({ id: 'mock-provider' })) {
    const messages = [];
    return { messages, pass: (now = dueTime) => runAutomaticFollowerEmailPass({ now, sendDelivery: async message => {
      messages.push(message);
      return outcome(message);
    } }) };
  }

  featureCase('is prospectively queued by owner draft publish and direct create, and only delivers when due', async () => {
    const recipient = 'opted-past-guest@example.test';
    const legacy = await pastGuests(recipient);
    const draft = await postEvent({ status: 'draft' });
    assert.equal(await job(legacy), undefined, 'ordinary database writes do not backfill existing public events');
    assert.equal(await job(draft), undefined);
    await publish(draft);
    const first = await job(draft);
    assert.equal(first.status, 'pending');
    const gracePeriod = first.available_at.getTime() - first.created_at.getTime();
    assert.ok(gracePeriod >= 590_000 && gracePeriod <= 610_000, 'publication grants about ten minutes to cancel');
    await publish(draft);
    assert.equal((await job(draft)).available_at.getTime(), first.available_at.getTime(), 'repeat publish cannot requeue');
    const direct = await postEvent();
    assert.equal((await job(direct)).status, 'pending');
    await due(draft);
    await due(direct, offset(60));

    const mock = worker();
    const before = await status(draft);
    assert.equal(before.automaticEmail.status, 'pending');
    assert.equal(before.automaticEmail.eligibleCount, 1);
    assert.equal(before.automaticEmail.sentCount, 0);
    assert.equal(before.emailCount, 0, 'manual email cannot overlap the automatic schedule');
    assert.equal((await mock.pass(offset(-1))).sent, 0);
    assert.deepEqual(mock.messages, []);
    assert.deepEqual(await logs(draft), []);

    assert.equal((await mock.pass()).sent, 1);
    assert.equal((await mock.pass()).sent, 0, 'same due pass cannot send again');
    assert.equal(mock.messages.length, 1);
    assert.equal(mock.messages[0].to, recipient);
    assert.match(mock.messages[0].payload.html, new RegExp(`/s/e/${draft.id}\\b`));
    assert.equal((await logs(draft))[0].provider_id, 'mock-provider');
    const after = await status(draft);
    assert.equal(after.automaticEmail.status, 'complete');
    assert.equal(after.automaticEmail.sentCount, 1);
    assert.equal(after.announcedAt, null, 'the independent manual SMS/legacy marker is untouched');
    assert.equal((await job(direct)).status, 'pending');
  });

  featureCase('never enrolls private, Secret, skipped, or restored publications and drops queued events that stop being public', async () => {
    await pastGuests('privacy-window@example.test');
    const privateEvent = await postEvent({ visibility: 'private', hide_address_until_rsvp: true });
    const secret = await postEvent({ visibility: 'private', secret_show_enabled: true, secret_code: 'A1B2C3', secret_code_confirm: 'A1B2C3' });
    const skipped = await postEvent({ skip_follower_email: true });
    const draft = await postEvent({ status: 'draft' });
    await publish(draft, { skip_follower_email: true });
    for (const event of [privateEvent, secret, skipped, draft]) assert.equal(await job(event), undefined);
    await json(`/api/events/${privateEvent.id}`, { method: 'PUT', body: { visibility: 'public', hide_address_until_rsvp: false } });
    assert.equal(await job(privateEvent), undefined, 'visibility edits are not new publications');

    const [becamePrivate, hidden, cancelled] = await Promise.all([postEvent(), postEvent(), postEvent()]);
    for (const event of [becamePrivate, hidden, cancelled]) await due(event);
    await json(`/api/events/${becamePrivate.id}`, { method: 'PUT', body: { visibility: 'private' } });
    await pool.query("UPDATE events SET status='hidden',hidden_at=NOW(),hidden_previous_status='published' WHERE id=$1", [hidden.id]);
    await json(`/api/events/${cancelled.id}/cancel`, { method: 'POST', body: {} });
    await pool.query("UPDATE events SET status='published',hidden_at=NULL,hidden_previous_status=NULL WHERE id=$1", [hidden.id]);
    await pool.query("UPDATE events SET status='draft' WHERE id=$1", [cancelled.id]);
    await publish(cancelled);
    for (const event of [becamePrivate, hidden, cancelled]) assert.equal((await job(event)).status, 'skipped');
    const mock = worker();
    await mock.pass();
    assert.deepEqual(mock.messages, []);
  });

  featureCase('respects the rollout switch and host cutover; cancel and send now are owner-only queue actions', async () => {
    await pastGuests('controls@example.test');
    process.env.AUTO_FOLLOWER_EMAIL_ENABLED = 'false';
    const unavailable = await postEvent();
    assert.equal(await job(unavailable), undefined);
    assert.deepEqual(await settings(), { enabled: true, available: false });
    process.env.AUTO_FOLLOWER_EMAIL_ENABLED = 'true';
    const old = await postEvent();
    await due(old);
    assert.deepEqual(await settings(false), { enabled: false, available: true });
    const disableCutover = async () => (await pool.query(
      'SELECT auto_follower_email_disabled_at::text AS disabled_at FROM organizers WHERE id=$1', [getOrganizerId()]
    )).rows[0].disabled_at;
    const originalCutover = await disableCutover();
    assert.ok(originalCutover);
    assert.deepEqual(await settings(false), { enabled: false, available: true });
    assert.equal(await disableCutover(), originalCutover, 'a repeat opt-out does not change the cutover');
    const whileDisabled = await postEvent();
    assert.equal(await job(whileDisabled), undefined);
    assert.deepEqual(await settings(true), { enabled: true, available: true });
    assert.equal((await status(old)).automaticEmail.status, 'skipped');
    await control(old, 'send_now', {}, 409);

    const cancelled = await postEvent();
    const expedited = await postEvent();
    const other = (await pool.query("INSERT INTO organizers(email,name) VALUES ('automatic-other-owner@example.test','Other') RETURNING id,user_id")).rows[0];
    await recordLegalAcceptance(pool, other);
    await control(expedited, 'send_now', { organizerId: other.id }, 404);
    const original = await job(expedited);
    const textOnlyPreview = await status(cancelled);
    assert.equal(textOnlyPreview.emailCount, 0);
    await control(cancelled, 'cancel');
    assert.equal((await job(cancelled)).status, 'skipped');
    assert.equal((await job(cancelled)).skip_reason, 'event_opted_out');
    assert.equal((await status(cancelled)).emailCount, 1);
    await json(`/api/events/${cancelled.id}/announce`, {
      method: 'POST', body: { confirm: 'SEND_FOLLOWER_UPDATE', includeTexts: true, fingerprint: textOnlyPreview.fingerprint }
    }, 409);
    assert.deepEqual(await logs(cancelled), [], 'a stale text-only approval cannot send email');
    await control(cancelled, 'send_now', {}, 409);
    await control(expedited, 'send_now');
    const changed = await job(expedited);
    assert.ok(changed.send_now_at);
    assert.ok(changed.available_at < original.available_at);
    assert.equal(changed.status, 'pending');
    assert.deepEqual(await logs(expedited), [], 'the HTTP action does not call transport or create sent logs');
    await due(expedited);
    const mock = worker();
    assert.equal((await mock.pass()).sent, 1);
    assert.match(mock.messages[0].payload.html, new RegExp(`/s/e/${expedited.id}\\b`));
    assert.equal((await job(old)).status, 'skipped');
  });

  featureCase('coalesces one host digest, defers another event to tomorrow, and records acceptance per covered event', async () => {
    const address = 'one-daily-digest@example.test';
    await pastGuests(address);
    const smsOnly = (await pool.query("INSERT INTO organizers(email,name) VALUES ('automatic-sms-only@example.test','Texts Only') RETURNING id")).rows[0];
    await pool.query(`INSERT INTO host_follows (follower_organizer_id,follower_user_id,host_organizer_id,
      sms_phone,sms_opted_in_at,sms_consent_source,sms_consent_version,sms_consent_text)
      VALUES ($1,$1,$2,'+14155550199',NOW(),'host_page_follow','host_follow_sms_v1','Recipient requests text updates')`,
    [smsOnly.id, getOrganizerId()]);
    await pool.query("UPDATE organizers SET auto_follower_email_timezone='UTC',sms_credits=7 WHERE id=$1", [getOrganizerId()]);
    const first = await postEvent({ title: 'Early concert', event_date: '2099-08-07' });
    const second = await postEvent({ title: 'Later concert', event_date: '2099-08-08' });
    const deferred = await postEvent({ title: 'Deferred concert', event_date: '2099-08-09' });
    await due(first);
    await due(second, offset(1));
    await due(deferred, offset(20));
    const preview = await status(first);
    assert.equal(preview.textCount, 1, 'an explicitly text-only follower remains eligible only for manual SMS');
    assert.equal(preview.automaticEmail.eligibleCount, 1);
    const mock = worker();
    assert.equal((await mock.pass()).sent, 0, 'a nearly due second event coalesces under the same host');
    assert.equal((await job(first)).status, 'pending');
    const parallel = await Promise.all([mock.pass(offset(1)), mock.pass(offset(1))]);
    assert.equal(parallel.reduce((sum, pass) => sum + pass.sent, 0), 1);
    assert.equal(mock.messages.length, 1);
    assert.equal(mock.messages[0].to, address);
    for (const event of [first, second]) {
      assert.match(mock.messages[0].payload.html, new RegExp(`/s/e/${event.id}\\b`));
      assert.equal((await status(event)).automaticEmail.sentCount, 1);
    }
    assert.equal((await logs(first))[0].delivery_id, (await logs(second))[0].delivery_id);
    assert.equal((await mock.pass(offset(20))).sent, 0);
    const pending = await status(deferred);
    assert.equal(pending.automaticEmail.sentCount, 0);
    assert.equal(pending.automaticEmail.pendingCount, 1);
    const [waiting] = await logs(deferred);
    assert.equal(waiting.status, 'pending');
    assert.equal(waiting.next_at.toISOString(), '2099-08-02T00:00:00.000Z');
    assert.equal((await mock.pass(new Date('2099-08-02T00:01:00.000Z'))).sent, 1);
    assert.equal(mock.messages.length, 2);
    assert.match(mock.messages[1].payload.html, new RegExp(`/s/e/${deferred.id}\\b`));
    assert.equal((await status(deferred)).automaticEmail.sentCount, 1);
    const tooSoon = await postEvent({ title: 'Before the next daily email', event_date: '2099-08-02', start_time: '22:00' });
    await pool.query("UPDATE events SET timezone='UTC' WHERE id=$1", [tooSoon.id]);
    const nextAfternoon = new Date('2099-08-02T18:00:00.000Z');
    await due(tooSoon, nextAfternoon);
    assert.equal((await mock.pass(nextAfternoon)).sent, 0);
    const expired = (await status(tooSoon)).automaticEmail;
    assert.equal(expired.sentCount, 0);
    assert.equal(expired.failedCount, 1, 'a recipient who can no longer be notified appears as not sent');
    assert.equal(expired.status, 'complete');
    assert.equal((await pool.query('SELECT sms_credits FROM organizers WHERE id=$1', [getOrganizerId()])).rows[0].sms_credits, 7);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM sms_notification_batches')).rows[0].count, 0);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM sms_credit_transactions')).rows[0].count, 0);
  });

  featureCase('publishes another event while a provider request for the same host is in flight', async () => {
    await pastGuests('slow-provider@example.test');
    const event = await postEvent();
    await due(event);
    let providerStarted;
    let finishProvider;
    const started = new Promise(resolve => { providerStarted = resolve; });
    const response = new Promise(resolve => { finishProvider = resolve; });
    const mock = worker(async () => { providerStarted(); return response; });
    const pass = mock.pass();
    async function bounded(operation) {
      let timer;
      try {
        return await Promise.race([operation, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Publication or the mock provider start was blocked')), 5000);
        })]);
      } finally { clearTimeout(timer); }
    }
    try {
      await bounded(started);
      const anotherEvent = await bounded(postEvent({ title: 'Unblocked publication' }));
      assert.equal(anotherEvent.status, 'published');
      assert.equal((await job(anotherEvent)).status, 'pending');
    } finally {
      finishProvider({ id: 'mock-inflight-provider' });
      await pass;
    }
  });

  featureCase('excludes target RSVPs and prior invites and suppresses a retry after a newly recorded opt-out', async () => {
    const unknown = 'unknown-then-optout@example.test';
    const previouslyInvited = 'already-invited@example.test';
    const currentGuest = 'already-going@example.test';
    await pastGuests(unknown, previouslyInvited, currentGuest);
    const event = await postEvent();
    await due(event);
    await createRsvp(event.id, { email: currentGuest });
    await pool.query(`INSERT INTO message_log (event_id,recipient,message_type,channel,status)
      VALUES ($1,$2,'previous_guest_invite','email','sent')`, [event.id, previouslyInvited]);
    const mock = worker(async () => { throw new Error('mock request outcome unknown'); });
    assert.equal((await mock.pass()).retry, 1);
    assert.deepEqual(mock.messages.map(message => message.to), [unknown]);
    assert.equal((await status(event)).automaticEmail.sentCount, 0, 'failed submission does not claim acceptance');
    await pool.query('INSERT INTO follower_optouts(organizer_id,email) VALUES ($1,$2)', [getOrganizerId(), unknown]);
    assert.equal((await mock.pass(offset(3))).unknown, 1);
    assert.equal(mock.messages.length, 1, 'new opt-out prevents another provider attempt');
    const [record] = await logs(event);
    assert.equal(record.status, 'failed');
    assert.equal(record.error, 'automatic_delivery_unknown');
    assert.equal(record.provider_id, null);
    const report = await status(event);
    assert.equal(report.automaticEmail.failedCount, 1);
    assert.equal(report.automaticEmail.sentCount, 0);
    assert.equal(report.automaticEmail.pendingCount, 0);
  });
};
