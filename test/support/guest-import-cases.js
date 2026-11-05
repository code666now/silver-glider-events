// Registered only by the serial dedicated-sge_test HTTP/PostgreSQL harness.
module.exports = function registerGuestImportCases({
  test, assert, pool, createEvent, createRsvp, getOrganizerId, getBaseUrl,
  signSession, mailer, addVerifiedEmailIdentity
}) {
  const lib = require('../../src/lib/guest-import');
  const routes = require('../../src/routes/guest-import');
  const { processImportedGuestInvitationBatch } = require('../../src/jobs/imported-guest-invitations');
  const { settlePreviousGuestInvitationWork, runPreviousGuestInvitationPass } = require('../../src/jobs/previous-guest-invitations');
  let serial = 0;
  async function request(event, action, body, options = {}) {
    return fetch(`${getBaseUrl()}/api/events/${event.id}/guest-import/${action}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { cookie: `sge_session=${signSession(options.ownerId || getOrganizerId())}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(options.headers || {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  }
  async function fixture(overrides = {}) {
    routes.resetRateLimitsForTests();
    await verifyHost();
    return createEvent({ slug: `import-${++serial}`, event_date: '2099-08-10', ...overrides });
  }
  async function verifyHost() {
    const id = getOrganizerId();
    await pool.query("INSERT INTO users(id,name) VALUES ($1,'Test Host') ON CONFLICT DO NOTHING", [id]);
    await pool.query('UPDATE organizers SET user_id=$1 WHERE id=$1', [id]);
    if (!(await pool.query("SELECT 1 FROM user_identities WHERE user_id=$1 AND identity_type='email' AND normalized_value='host@example.test'", [id])).rowCount) {
      await addVerifiedEmailIdentity(id, 'host@example.test');
    }
  }
  async function preview(event, rows) {
    const response = await request(event, 'preview', { rows });
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(response.headers.get('cache-control'), /private, no-store/);
    return response.json();
  }
  async function importContacts(event, rows) {
    const review = await preview(event, rows);
    const response = await request(event, 'contacts/import', { rows, reviewToken: review.reviewToken });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  async function invitationPreview(event, selection) {
    const response = await request(event, 'preview', selection);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  async function send(event, selection, reviewToken) {
    return request(event, 'send', { ...selection, reviewToken, permissionConfirmed: true });
  }
  async function effects() {
    return (await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM users) AS users,
      (SELECT COUNT(*)::int FROM user_identities) AS identities,
      (SELECT COUNT(*)::int FROM rsvps) AS rsvps,
      (SELECT COUNT(*)::int FROM host_follows) AS follows,
      (SELECT COUNT(*)::int FROM guest_invitation_tokens) AS tokens,
      (SELECT COUNT(*)::int FROM sms_notification_batches) AS texts`)).rows[0];
  }
  async function seed(event, email = `seed-${++serial}@example.test`) {
    const context = lib.requireEligible(await lib.loadContext(pool, event.id, getOrganizerId()));
    const batch = (await pool.query(
      `INSERT INTO previous_guest_invitation_batches(target_event_id,source_event_title,source_kind,status,
          recipient_count,import_context_hash,import_permission_version,import_permission_at,import_contacts_count)
       VALUES ($1,'Imported guest list','import','import_pending',1,$2,$3,NOW(),1) RETURNING id`,
      [event.id, lib.contextDigest(context), lib.PERMISSION_VERSION]
    )).rows[0];
    const payload = lib.renderInvitation(context, { name: 'Invited Guest', email });
    const log = (await pool.query(
      `INSERT INTO message_log(event_id,previous_guest_invitation_batch_id,recipient,recipient_name,
        message_type,channel,status,import_render_payload,import_delivery_state)
       VALUES ($1,$2,$3,'Invited Guest','previous_guest_invite','email','pending',$4::jsonb,'pending') RETURNING *`,
      [event.id, batch.id, email, JSON.stringify(payload)]
    )).rows[0];
    return { batch, log, payload };
  }

  test('guest import preview classifies rows and has no account, message, or consent side effects', async () => {
    const event = await fixture({ visibility: 'private', hide_address_until_rsvp: true });
    await createRsvp(event.id, { email: 'going@example.test' });
    await createRsvp(event.id, { email: 'cancelled@example.test', status: 'cancelled' });
    await pool.query('INSERT INTO follower_optouts(organizer_id,email) VALUES ($1,$2)', [getOrganizerId(), 'opted@example.test']);
    const old = await seed(event, 'already@example.test');
    await pool.query("UPDATE message_log SET status='failed',import_delivery_state='failed',attempt_count=3 WHERE id=$1", [old.log.id]);
    const rows = [
      { name: ' Ready ', email: ' READY@EXAMPLE.TEST ' }, { email: 'ready@example.test' },
      { email: 'bad' }, { email: 'going@example.test' }, { email: 'cancelled@example.test' },
      { email: 'opted@example.test' }, { email: 'already@example.test' }
    ];
    const before = await effects();
    const beforeMail = mailer.devOutbox.length;
    const result = await preview(event, rows);
    assert.deepEqual(result.rows.map(row => row.status), ['ready', 'duplicate', 'invalid', 'already_connected', 'already_connected', 'opted_out', 'already_connected']);
    assert.equal(result.summary.ready, 1);
    assert.equal(result.summary.skipped, 6);
    assert.equal(result.canSend, true);
    assert.doesNotMatch(result.previewHtml, /1 Test Way|RSVP’d to|\/g\//);
    assert.deepEqual(await effects(), before);
    assert.equal(mailer.devOutbox.length, beforeMail);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM guest_import_budget')).rows[0].count, 0);
  });

  test('guest import requires owner, same origin, verified account email, and eligible target', async () => {
    const event = await createEvent({ slug: `import-guard-${++serial}`, event_date: '2099-08-10' });
    const rows = [{ email: 'guest@example.test' }];
    let response = await request(event, 'preview', { rows });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'email_verification_required');
    await verifyHost();
    const stranger = (await pool.query("INSERT INTO organizers(email,name) VALUES ('other-import@example.test','Other') RETURNING id")).rows[0];
    assert.equal((await request(event, 'preview', { rows }, { ownerId: stranger.id })).status, 404);
    assert.equal((await request(event, 'preview', { rows }, { headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' } })).status, 403);
    for (const update of ["status='draft'", "status='cancelled'", "status='published',archived_at=NOW()", "archived_at=NULL,visibility='private',secret_show_enabled=TRUE", "secret_show_enabled=FALSE,event_date='2020-01-01'"]) {
      await pool.query(`UPDATE events SET ${update} WHERE id=$1`, [event.id]);
      assert.equal((await request(event, 'preview', { rows })).status, 409);
    }
    assert.equal((await request(event, 'preview', { rows: Array.from({ length: 101 }, () => rows[0]) })).status, 400);
    assert.equal((await effects()).tokens, 0);
  });

  test('guest import approval is concurrent-idempotent, sends neutral mail only, and creates no recipient identities', async () => {
    const event = await fixture();
    const rows = [{ name: '=Not a formula', email: 'guest-import@example.test' }, { email: 'second-import@example.test' }];
    const imported = await importContacts(event, rows);
    const selection = { contactIds: imported.selectedContactIds };
    const review = await invitationPreview(event, selection);
    const before = await effects();
    const responses = await Promise.all([send(event, selection, review.reviewToken), send(event, selection, review.reviewToken)]);
    for (const response of responses) assert.equal(response.status, 202, await response.clone().text());
    const approvals = await Promise.all(responses.map(response => response.json()));
    assert.equal(approvals[0].batchId, approvals[1].batchId);
    await settlePreviousGuestInvitationWork();
    const status = await (await request(event, `status/${approvals[0].batchId}`)).json();
    assert.equal(status.accepted, 2);
    assert.equal(status.queued, 0);
    assert.equal(status.complete, true);
    assert.deepEqual(await effects(), before);
    const facts = (await pool.query('SELECT * FROM guest_import_budget')).rows;
    assert.equal(facts.length, 1);
    assert.equal(facts[0].recipient_count, 2);
    assert.doesNotMatch(JSON.stringify(facts), /@example\.test/);
    const messages = mailer.devOutbox.filter(message => rows.some(row => row.email === message.to));
    assert.equal(messages.length, 2);
    for (const message of messages) {
      assert.match(message.idempotencyKey, /^guest-import:\d+:v1$/);
      assert.match(message.html, /does not subscribe you to future updates/);
      assert.doesNotMatch(message.html, /RSVP’d to|\/g\//);
    }
    const logs = (await pool.query('SELECT recipient_user_id,rsvp_id FROM message_log WHERE event_id=$1', [event.id])).rows;
    assert.ok(logs.every(row => row.recipient_user_id == null && row.rsvp_id == null));
    const connected = await fetch(`${getBaseUrl()}/api/events/${event.id}/familiar-faces`, { headers: { cookie: `sge_session=${signSession(getOrganizerId())}` } });
    const faces = await connected.json();
    assert.equal(faces.invitedCount, 2);
    assert.equal(faces.goingCount, 0);
    assert.ok(faces.faces.every(face => !face.avatarUrl));
  });

  test('guest import send rejects changed lists, event content, recipient eligibility, expired previews, and missing permission', async () => {
    const event = await fixture();
    const rows = [{ name: 'Guest', email: 'stale-import@example.test' }];
    const imported = await importContacts(event, rows);
    const selection = { contactIds: imported.selectedContactIds };
    const review = await invitationPreview(event, selection);
    assert.equal((await request(event, 'send', { ...selection, reviewToken: review.reviewToken })).status, 400);
    assert.equal((await send(event, { contactIds: [] }, review.reviewToken)).status, 409);
    const decoded = lib.readReview(review.reviewToken);
    const expired = lib.signReview(decoded, Date.now() - lib.REVIEW_TTL_MS - 1000);
    assert.equal((await send(event, selection, expired)).status, 409);
    await pool.query("UPDATE events SET title='Changed title' WHERE id=$1", [event.id]);
    assert.equal((await send(event, selection, review.reviewToken)).status, 409);
    const next = await invitationPreview(event, selection);
    await pool.query('INSERT INTO follower_optouts(organizer_id,email) VALUES ($1,$2)', [getOrganizerId(), rows[0].email]);
    assert.equal((await send(event, selection, next.reviewToken)).status, 409);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM guest_import_budget')).rows[0].count, 0);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM message_log WHERE event_id=$1', [event.id])).rows[0].count, 0);
  });

  test('guest import pending recipients are not Invited yet and cannot be reused as past guests', async () => {
    const event = await fixture();
    const seeded = await seed(event, 'unanswered-import@example.test');
    const cookie = `sge_session=${signSession(getOrganizerId())}`;
    let connected = await (await fetch(`${getBaseUrl()}/api/events/${event.id}/familiar-faces`, { headers: { cookie } })).json();
    assert.equal(connected.invitedCount, 0);
    await processImportedGuestInvitationBatch(seeded.batch.id);
    await pool.query("UPDATE events SET event_date='2020-01-01' WHERE id=$1", [event.id]);
    connected = await (await fetch(`${getBaseUrl()}/api/events/${event.id}/familiar-faces`, { headers: { cookie } })).json();
    assert.equal(connected.invitedCount, 1);
    assert.equal(connected.faces[0].canInvite, false);
    const target = await createEvent({ slug: `later-import-${++serial}`, event_date: '2099-09-01' });
    const result = await fetch(`${getBaseUrl()}/api/events/${event.id}/familiar-faces/invite`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ targetEventId: target.id, faceIds: [`invite:${seeded.log.id}`] })
    });
    assert.ok([400, 409].includes(result.status), await result.clone().text());
    assert.equal((await effects()).tokens, 0);
  });

  test('guest import worker suppresses new opt-outs, RSVPs, and privacy changes immediately before sending', async () => {
    const original = mailer.sendImportedGuestInvitation;
    let sends = 0;
    mailer.sendImportedGuestInvitation = async () => { sends += 1; return { id: 'must-not-send' }; };
    try {
      for (const change of ['optout', 'rsvp', 'privacy', 'cancel', 'archived', 'secret', 'past']) {
        const event = await fixture();
        const { batch, log } = await seed(event, `${change}-worker@example.test`);
        if (change === 'optout') await pool.query('INSERT INTO follower_optouts(organizer_id,email) VALUES ($1,$2)', [getOrganizerId(), log.recipient]);
        else if (change === 'rsvp') await createRsvp(event.id, { email: log.recipient });
        else if (change === 'privacy') await pool.query("UPDATE events SET visibility='private',hide_address_until_rsvp=TRUE WHERE id=$1", [event.id]);
        else if (change === 'cancel') await pool.query("UPDATE events SET status='cancelled' WHERE id=$1", [event.id]);
        else if (change === 'archived') await pool.query('UPDATE events SET archived_at=NOW() WHERE id=$1', [event.id]);
        else if (change === 'secret') await pool.query("UPDATE events SET visibility='private',secret_show_enabled=TRUE WHERE id=$1", [event.id]);
        else await pool.query("UPDATE events SET event_date='2020-01-01' WHERE id=$1", [event.id]);
        await processImportedGuestInvitationBatch(batch.id);
        const saved = (await pool.query('SELECT * FROM message_log WHERE id=$1', [log.id])).rows[0];
        assert.equal(saved.import_delivery_state, 'skipped', change);
        assert.equal(saved.attempt_count, 3);
      }
      assert.equal(sends, 0);
    } finally { mailer.sendImportedGuestInvitation = original; }
  });

  test('guest import retries freeze payload and key, and reject unconfirmed provider responses', async () => {
    const event = await fixture();
    const { batch, log, payload } = await seed(event);
    const original = mailer.sendImportedGuestInvitation;
    const attempts = [];
    mailer.sendImportedGuestInvitation = async input => { attempts.push(input); return attempts.length === 1 ? {} : { id: 'accepted-import-test' }; };
    try {
      await processImportedGuestInvitationBatch(batch.id);
      let saved = (await pool.query('SELECT * FROM message_log WHERE id=$1', [log.id])).rows[0];
      assert.equal(saved.import_delivery_state, 'pending');
      assert.equal(saved.status, 'pending');
      await pool.query("UPDATE message_log SET last_attempt_at=NOW()-INTERVAL '3 minutes' WHERE id=$1", [log.id]);
      await processImportedGuestInvitationBatch(batch.id);
      saved = (await pool.query('SELECT * FROM message_log WHERE id=$1', [log.id])).rows[0];
      assert.equal(saved.import_delivery_state, 'accepted');
      assert.equal(saved.attempt_count, 2);
      assert.deepEqual(attempts[0], attempts[1]);
      assert.deepEqual(attempts[0].payload, payload);
    } finally { mailer.sendImportedGuestInvitation = original; }
  });

  test('guest import retry horizon and crashed final attempt finish unconfirmed without another send', async () => {
    const original = mailer.sendImportedGuestInvitation;
    let sends = 0;
    mailer.sendImportedGuestInvitation = async () => { sends += 1; return { id: 'must-not-send' }; };
    try {
      for (const age of ['expired', 'exhausted']) {
        const event = await fixture();
        const { batch, log } = await seed(event);
        await pool.query(`UPDATE message_log SET attempt_count=$2,last_attempt_at=NOW()-INTERVAL '3 minutes',
          import_first_attempt_at=NOW()-INTERVAL '24 hours',created_at=NOW()-$3::interval WHERE id=$1`,
        [log.id, age === 'expired' ? 1 : 3, age === 'expired' ? '24 hours' : '1 hour']);
        await runPreviousGuestInvitationPass();
        const saved = (await pool.query('SELECT * FROM message_log WHERE id=$1', [log.id])).rows[0];
        assert.equal(saved.import_delivery_state, 'failed', age);
        const status = await lib.loadStatus(pool, batch.id, event.id, getOrganizerId());
        assert.equal(status.complete, true, age);
        assert.equal(status.failed, 1, age);
      }
      assert.equal(sends, 0);
    } finally { mailer.sendImportedGuestInvitation = original; }
  });

  test('guest import quotas persist independently from deleted events and prevent global overapproval', async () => {
    const event = await fixture();
    const context = await lib.loadContext(pool, event.id, getOrganizerId());
    const budget = await lib.budgetState(pool, context, { create: true });
    for (let index = 0; index < 2; index += 1) {
      await pool.query('INSERT INTO guest_import_budget(approval_key,account_key,email_keys,recipient_count) VALUES ($1,$2,$3,100)',
        [`host-budget-${index}`, budget.accountKey, budget.emailKeys]);
    }
    await pool.query('DELETE FROM events WHERE id=$1', [event.id]);
    const next = await fixture();
    const rows = [{ email: 'quota@example.test' }];
    const imported = await importContacts(next, rows);
    const selection = { contactIds: imported.selectedContactIds };
    const review = await invitationPreview(next, selection);
    assert.equal(review.limits.remaining24h, 0);
    assert.equal(review.canSend, false);
    assert.equal((await send(next, selection, review.reviewToken)).status, 429);
    await pool.query("UPDATE guest_import_budget SET account_key='other',email_keys='{}'");
    for (let index = 0; index < 18; index += 1) {
      await pool.query("INSERT INTO guest_import_budget(approval_key,account_key,email_keys,recipient_count) VALUES ($1,'other','{}',100)", [`global-budget-${index}`]);
    }
    const capped = await invitationPreview(next, selection);
    assert.equal(capped.limits.remaining24h, 200);
    assert.equal(capped.canSend, false);
    assert.equal((await send(next, selection, capped.reviewToken)).status, 429);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM message_log WHERE event_id=$1', [next.id])).rows[0].count, 0);
  });

  test('guest import Contacts persist per host without sending and reimports preserve names and opt-outs', async () => {
    const event = await fixture();
    await pool.query('INSERT INTO follower_optouts(organizer_id,email) VALUES ($1,$2)', [getOrganizerId(), 'opted-contact@example.test']);
    const rows = [{ name: 'Original name', email: ' KEPT@EXAMPLE.TEST ' }, { name: 'Suppressed', email: 'opted-contact@example.test' }, { email: 'bad' }];
    const before = await effects();
    const outbox = mailer.devOutbox.length;
    const saved = await importContacts(event, rows);
    assert.equal(saved.total, 2);
    assert.equal(saved.saved, 2);
    assert.equal(saved.skipped, 1);
    assert.equal(saved.selectedContactIds.length, 1);
    const again = await importContacts(event, [{ name: 'Overwrite attempt', email: 'kept@example.test' }]);
    assert.equal(again.contacts[0].id, saved.contacts[0].id);
    assert.equal(again.contacts[0].name, 'Original name');
    const next = await fixture();
    const listed = await (await request(next, 'contacts')).json();
    assert.equal(listed.total, 2);
    assert.equal(listed.eligibleCount, 1);
    assert.equal(listed.contacts.find(row => row.email === 'opted-contact@example.test').eligible, false);
    const all = await (await request(next, 'contacts?all=1')).json();
    assert.deepEqual(all.contacts.map(row => row.email), ['kept@example.test']);
    assert.deepEqual(await effects(), before);
    assert.equal(mailer.devOutbox.length, outbox);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM message_log')).rows[0].count, 0);
    const other = (await pool.query("INSERT INTO organizers(email,name) VALUES ('other-contacts@example.test','Other') RETURNING id")).rows[0];
    assert.equal((await request(next, 'contacts', undefined, { ownerId: other.id })).status, 404);
    assert.equal((await request(next, 'preview', { contactIds: ['999999999'] })).status, 400);
  });

  test('guest import combined selection deduplicates Familiar Faces and Contacts and charges only new contacts', async () => {
    const target = await fixture();
    const past = await createEvent({ slug: `mixed-past-${++serial}`, event_date: '2020-01-01' });
    const guest = await createRsvp(past.id, { first_name: 'Known', email: 'known-contact@example.test', organizer_optin: true });
    const saved = await importContacts(target, [{ name: 'Known import', email: guest.email }, { name: 'New contact', email: 'brand-new@example.test' }]);
    const selection = { faceIds: [`rsvp:${guest.id}`], contactIds: saved.selectedContactIds };
    const review = await invitationPreview(target, selection);
    assert.equal(review.summary.ready, 2);
    assert.equal(review.summary.duplicate, 1);
    assert.equal(review.rows.find(row => row.source === 'face').email, undefined);
    const response = await send(target, selection, review.reviewToken);
    assert.equal(response.status, 202, await response.clone().text());
    const approved = await response.json();
    await settlePreviousGuestInvitationWork();
    const status = await (await request(target, `status/${approved.batchId}`)).json();
    assert.equal(status.accepted, 2);
    assert.equal((await pool.query('SELECT recipient_count FROM guest_import_budget')).rows[0].recipient_count, 1);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM rsvps WHERE event_id=$1', [target.id])).rows[0].count, 0);
  });

  test('guest import contacts resolve only proven own-host RSVP aliases and preserve canonical deduplication', async () => {
    const target = await fixture();
    const past = await createEvent({ slug: `alias-past-${++serial}`, event_date: '2020-01-01' });
    const account = (await pool.query("INSERT INTO organizers(email,name) VALUES ('alias-a@example.test','Known guest') RETURNING id,user_id")).rows[0];
    const user = (await pool.query('SELECT user_id AS id FROM organizers WHERE id=$1', [account.id])).rows[0];
    const first = await createRsvp(past.id, { email: 'alias-a@example.test', account_id: account.id, user_id: user.id, organizer_optin: true });
    await createRsvp(past.id, { email: 'alias-b@example.test', account_id: account.id, user_id: user.id, organizer_optin: true });
    const saved = await importContacts(target, [{ email: 'alias-a@example.test' }, { email: 'alias-b@example.test' }]);
    assert.equal(saved.contacts[0].selectionKey, saved.contacts[1].selectionKey);
    const selection = { faceIds: [`rsvp:${first.id}`], contactIds: saved.selectedContactIds };
    const review = await invitationPreview(target, selection);
    assert.equal(review.summary.ready, 1);
    assert.equal(review.summary.duplicate, 2);
    const response = await send(target, selection, review.reviewToken);
    assert.equal(response.status, 202, await response.clone().text());
    await settlePreviousGuestInvitationWork();
    const log = (await pool.query("SELECT recipient_user_id FROM message_log WHERE event_id=$1 AND message_type='previous_guest_invite'", [target.id])).rows[0];
    assert.equal(Number(log.recipient_user_id), Number(user.id));
    const listed = await (await request(target, 'contacts')).json();
    assert.equal(listed.eligibleCount, 0);
    assert.ok(listed.contacts.every(contact => !contact.eligible));
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM guest_import_budget')).rows[0].count, 0);
  });

  test('guest import suppresses announcement reservations and uncertain failures across both invitation flows', async () => {
    const event = await fixture();
    for (const status of ['pending', 'failed']) await pool.query(
      "INSERT INTO message_log(event_id,recipient,message_type,channel,status) VALUES ($1,$2,'announcement','email',$3)",
      [event.id, `${status}-announcement@example.test`, status]
    );
    const review = await preview(event, [{ email: 'pending-announcement@example.test' }, { email: 'failed-announcement@example.test' }]);
    assert.ok(review.rows.every(row => row.status === 'already_connected'));
    const past = await createEvent({ slug: `unknown-past-${++serial}`, event_date: '2020-01-01' });
    await createRsvp(past.id, { email: 'unknown-import@example.test', organizer_optin: true });
    const seeded = await seed(event, 'unknown-import@example.test');
    await pool.query("UPDATE message_log SET status='failed',import_delivery_state='failed',attempt_count=3 WHERE id=$1", [seeded.log.id]);
    const recipients = await require('../../src/lib/follow-announcement').eligibleEmailRecipients(pool, getOrganizerId(), event.id);
    assert.equal(recipients.some(recipient => recipient.email === 'unknown-import@example.test'), false);
  });

  test('guest import keeps a known past identity when the newest RSVP uses a different email without new account proof', async () => {
    const target = await fixture();
    const past = await createEvent({ slug: `proof-past-${++serial}`, event_date: '2020-01-01' });
    const account = (await pool.query("INSERT INTO organizers(email,name) VALUES ('proof-a@example.test','Known person') RETURNING id")).rows[0];
    const canonical = (await pool.query('SELECT user_id FROM organizers WHERE id=$1', [account.id])).rows[0].user_id;
    await createRsvp(past.id, { email: 'proof-a@example.test', account_id: account.id, user_id: canonical, organizer_optin: true });
    const newest = await createRsvp(past.id, { email: 'proof-b@example.test', user_id: canonical, account_id: null, organizer_optin: true });
    const imported = await importContacts(target, [{ email: 'proof-a@example.test' }]);
    const selection = { faceIds: [`rsvp:${newest.id}`], contactIds: imported.selectedContactIds };
    const review = await invitationPreview(target, selection);
    assert.equal(review.summary.ready, 1);
    assert.equal(review.summary.duplicate, 1);
    assert.equal(review.rows[0].source, 'face');
    assert.equal(review.rows[0].selectionKey, imported.contacts[0].selectionKey);
    const response = await send(target, selection, review.reviewToken);
    assert.equal(response.status, 202, await response.clone().text());
    await settlePreviousGuestInvitationWork();
    const sent = (await pool.query("SELECT recipient,recipient_user_id FROM message_log WHERE event_id=$1 AND message_type='previous_guest_invite'", [target.id])).rows;
    assert.equal(sent.length, 1);
    assert.equal(sent[0].recipient, 'proof-b@example.test');
    assert.equal(Number(sent[0].recipient_user_id), Number(canonical));
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM guest_import_budget')).rows[0].count, 0);
  });
};
