// These cases use the integration suite's isolated database and HTTP server.
// Every reminder delivery is injected; none calls a live email/SMS provider.
module.exports = function registerDraftReminderCases({
  test, assert, pool, createEvent, getOrganizerId, getBaseUrl, signSession,
  addVerifiedEmailIdentity, signInAccount, createAdminOperator,
  signInAdminOperator, createDoneForYouClient, openDoneForYouEditor, resetRateLimits
}) {
  // Node also discovers support files on their own. Load auth-dependent
  // helpers only after the integration harness has configured its test env.
  const { createEventInTransaction, updateEventInTransaction } = require('../../src/lib/event-editor');
  const { setEmailPreference } = require('../../src/lib/email-preferences');
  let serial = 0;
  const hoursAgo = hours => new Date(Date.now() - hours * 60 * 60 * 1000);
  const ownerCookie = () => `sge_session=${signSession(getOrganizerId())}`;
  const content = overrides => ({
    title: 'Saved draft night', event_date: '2099-08-10', start_time: '19:30',
    venue_name: 'Saved Hall', venue_address: '10 Saved Way',
    cover_image_url: 'https://images.example.test/saved-draft.jpg',
    description: 'These are the saved details.', status: 'draft', ...overrides
  });
  async function account() {
    const id = getOrganizerId();
    const email = `draft-reminder-${++serial}@example.test`;
    await pool.query("INSERT INTO users(id,name) VALUES ($1,'Draft Host') ON CONFLICT(id) DO NOTHING", [id]);
    await pool.query('UPDATE organizers SET user_id=$1 WHERE id=$1', [id]);
    const identity = await addVerifiedEmailIdentity(id, email, { primary: true, source: 'draft_reminder_integration' });
    return { id, email, identity };
  }
  async function request(path, { method = 'GET', body, cookie = ownerCookie() } = {}) {
    return fetch(`${getBaseUrl()}${path}`, {
      method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  }
  async function postDraft(overrides = {}) {
    const response = await request('/api/events', { method: 'POST', body: content(overrides) });
    assert.equal(response.status, 201);
    return (await response.json()).event;
  }
  async function row(id) {
    return (await pool.query('SELECT * FROM events WHERE id=$1', [id])).rows[0];
  }
  async function draft(overrides = {}) {
    return createEvent({
      slug: `draft-reminder-${++serial}`, status: 'draft', event_date: '2099-08-10',
      draft_host_activity_at: hoursAgo(25), ...overrides
    });
  }
  function worker() {
    const deliveries = [];
    const instance = require('../../src/jobs/draft-reminders').createDraftReminderWorker({
      db: pool,
      sendEmail: async message => {
        deliveries.push(message);
        return { id: `mock-draft-email-${deliveries.length}` };
      }
    });
    return { ...instance, deliveries };
  }

  test('draft reminder activity is armed by a host save, not reads or normalized no-op updates', async () => {
    await account();
    const event = await postDraft();
    assert.ok((await row(event.id)).draft_host_activity_at);
    const old = hoursAgo(30);
    await pool.query('UPDATE events SET draft_host_activity_at=$2 WHERE id=$1', [event.id, old]);
    assert.equal((await request(`/api/events/${event.id}`)).status, 200);
    assert.equal((await request(`/events/${event.id}/edit`)).status, 302);
    assert.equal((await row(event.id)).draft_host_activity_at.getTime(), old.getTime());
    const unchanged = await request(`/api/events/${event.id}`, {
      method: 'PUT', body: { title: '  Saved draft night  ', start_time: '19:30:00', venue_name: 'Saved Hall' }
    });
    assert.equal(unchanged.status, 200);
    assert.equal((await row(event.id)).draft_host_activity_at.getTime(), old.getTime(),
      'normalization and the generic updated_at timestamp cannot postpone a reminder');
    const changed = await request(`/api/events/${event.id}`, { method: 'PUT', body: { title: 'A meaningful saved change' } });
    assert.equal(changed.status, 200);
    assert.ok((await row(event.id)).draft_host_activity_at.getTime() > old.getTime());
    const published = await postDraft({ status: 'published', title: 'Already published' });
    assert.equal((await row(published.id)).draft_host_activity_at, null);
  });

  test('draft reminder activity is not enrolled by shared administrator editor helpers', async () => {
    await account();
    const client = await pool.connect();
    let event;
    try {
      await client.query('BEGIN');
      event = (await createEventInTransaction(client, { organizerId: getOrganizerId(), body: content() })).event;
      await updateEventInTransaction(client, {
        organizerId: getOrganizerId(), eventId: event.id, body: { title: 'Administrator prepared this' }
      });
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    assert.equal((await row(event.id)).draft_host_activity_at, null);
    assert.equal((await worker().pendingDraftReminders()).length, 0);
  });

  test('draft reminder activity stays absent through actual dedicated admin create and edit routes', async () => {
    resetRateLimits();
    const operator = await createAdminOperator('draft-reminder-admin@example.test', 'support');
    const adminCookie = await signInAdminOperator(operator.email);
    const prepared = await createDoneForYouClient(adminCookie, {
      hostName: 'Prepared Draft Host', contactName: 'Prepared Client', email: 'draft-reminder-client@example.test'
    });
    const opened = await openDoneForYouEditor(adminCookie, prepared.client.id);
    const cookie = `${adminCookie}; ${opened.editorCookie}`;
    const created = await request('/admin-editor/api/events', { method: 'POST', cookie, body: content() });
    assert.equal(created.status, 201);
    const event = (await created.json()).event;
    const updated = await request(`/admin-editor/api/events/${event.id}`, {
      method: 'PUT', cookie, body: { title: 'Prepared by an administrator' }
    });
    assert.equal(updated.status, 200);
    assert.equal((await row(event.id)).draft_host_activity_at, null);
    assert.equal((await worker().pendingDraftReminders()).length, 0);
    const target = (await pool.query('SELECT user_id FROM organizers WHERE id=$1', [event.organizer_id])).rows[0];
    await addVerifiedEmailIdentity(target.user_id, 'draft-admin-workspace-owner@example.test', { primary: true });
    await pool.query('UPDATE events SET draft_host_activity_at=$2 WHERE id=$1', [event.id, hoursAgo(25)]);
    assert.equal((await worker().pendingDraftReminders()).length, 0,
      'an active staff editing workspace still excludes a previously host-touched draft');
    await pool.query("UPDATE admin_event_editor_workspaces SET status='exited',closed_at=NOW() WHERE event_id=$1 AND status='active'", [event.id]);
    assert.equal((await worker().pendingDraftReminders()).length, 1,
      'the exclusion is specifically the active workspace, not a missing verified identity');
  });

  test('draft reminder duplication creates a new owned draft with its own inactivity clock and preserved artwork', async () => {
    await account();
    const source = await createEvent({ title: 'Repeat this night', event_date: '2099-08-10' });
    const response = await request(`/api/events/${source.id}/duplicate`, { method: 'POST' });
    assert.equal(response.status, 201);
    const duplicated = (await response.json()).event;
    const saved = await row(duplicated.id);
    assert.notEqual(Number(saved.id), Number(source.id));
    assert.equal(Number(saved.organizer_id), Number(getOrganizerId()));
    assert.equal(saved.status, 'draft');
    assert.equal(saved.first_published_at, null);
    assert.ok(saved.draft_host_activity_at);
    for (const field of ['title', 'start_time', 'venue_name', 'venue_address', 'cover_image_url', 'flyer_image_url']) {
      assert.equal(saved[field], source[field], field);
    }
    assert.equal((await worker().pendingDraftReminders()).length, 0, 'a just-created duplicate is not abandoned');
  });

  test('draft reminder continue link signs in normally and reopens only the exact owned saved event', async () => {
    const host = await account();
    const event = await postDraft();
    const destination = `/events/${event.id}/edit`;
    const loginPath = `/login?next=${encodeURIComponent(destination)}`;
    const signedOut = await request(loginPath, { cookie: '' });
    assert.equal(signedOut.status, 200);
    assert.equal((await row(event.id)).status, 'draft', 'opening a reminder does not publish or create a copy');
    resetRateLimits();
    const signedIn = await signInAccount(host.email, destination);
    assert.equal(signedIn.body.redirect, destination);
    const loggedInLink = await request(loginPath, { cookie: signedIn.sessionCookie });
    assert.equal(loggedInLink.headers.get('location'), destination);
    const edit = await request(destination, { cookie: signedIn.sessionCookie });
    assert.equal(edit.headers.get('location'), `/events/new?id=${event.id}&advanced=1`);
    const builder = await request(edit.headers.get('location'), { cookie: signedIn.sessionCookie });
    assert.equal(builder.status, 200);
    const restored = await request(`/api/events/${event.id}`, { cookie: signedIn.sessionCookie });
    assert.equal(restored.status, 200);
    const actual = (await restored.json()).event;
    for (const field of ['title', 'venue_name', 'venue_address', 'cover_image_url', 'description']) {
      assert.equal(actual[field], content()[field], `${field} restored from the same persisted draft`);
    }
    assert.equal(actual.event_date.slice(0, 10), '2099-08-10');
    assert.equal(actual.start_time.slice(0, 5), '19:30');
    assert.equal(Number(actual.id), Number(event.id));
    const other = (await pool.query("INSERT INTO organizers(email,name) VALUES ('draft-other-owner@example.test','Other') RETURNING id")).rows[0];
    const wrongCookie = `sge_session=${signSession(other.id)}`;
    assert.equal((await request(destination, { cookie: wrongCookie })).status, 404);
    assert.equal((await request(`/api/events/${event.id}`, { cookie: wrongCookie })).status, 404);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM events')).rows[0].count, 1);
  });

  test('draft reminder waits 24 hours from the latest host draft activity and sends only once', async () => {
    const host = await account();
    const older = await draft({ title: 'Older eligible draft', draft_host_activity_at: hoursAgo(30) });
    const newest = await draft({ title: 'Latest active draft', draft_host_activity_at: hoursAgo(2) });
    const job = worker();
    assert.equal(await job.runDraftReminderPass(), 0, 'a newer active draft suppresses the older abandoned one');
    await pool.query('UPDATE events SET draft_host_activity_at=$2 WHERE id=$1', [newest.id, hoursAgo(23.99)]);
    assert.equal(await job.runDraftReminderPass(), 0);
    await pool.query('UPDATE events SET draft_host_activity_at=$2 WHERE id=$1', [newest.id, hoursAgo(24.01)]);
    assert.equal(await job.runDraftReminderPass(), 1);
    assert.equal(job.deliveries.length, 1);
    assert.equal(job.deliveries[0].to, host.email);
    assert.equal(job.deliveries[0].idempotencyKey, `sge-draft-reminder-v1-${newest.id}`);
    assert.match(job.deliveries[0].html, new RegExp(`/login\\?next=%2Fevents%2F${newest.id}%2Fedit`));
    assert.doesNotMatch(job.deliveries[0].html, new RegExp(`%2Fevents%2F${older.id}%2Fedit`));
    assert.equal(await job.runDraftReminderPass(), 0);
    const stored = (await pool.query('SELECT * FROM event_draft_reminders WHERE event_id=$1', [newest.id])).rows[0];
    assert.equal(stored.status, 'sent');
    assert.equal(stored.attempt_count, 1);
    assert.ok(stored.sent_at);
    await request(`/api/events/${newest.id}`, { method: 'PUT', body: { title: 'Host came back later' } });
    await pool.query('UPDATE events SET draft_host_activity_at=$2 WHERE id=$1', [newest.id, hoursAgo(25)]);
    await pool.query("UPDATE organizers SET last_draft_reminder_attempt_at=NOW()-INTERVAL '8 days' WHERE id=$1", [host.id]);
    assert.equal(await job.deliverDraftReminder({ ...newest, organizer_id: host.id }), false,
      'later activity never reenrolls a draft that already had its one reminder');
    assert.equal(job.deliveries.length, 1);
  });

  test('draft reminder excludes stale past archived cancelled published and never-host-saved drafts', async () => {
    await account();
    const event = await draft({ draft_host_activity_at: hoursAgo(8 * 24) });
    const job = worker();
    assert.equal(await job.runDraftReminderPass(), 0, 'activity older than seven days is not backfilled');
    await pool.query("UPDATE events SET draft_host_activity_at=NOW()-INTERVAL '25 hours',event_date='2000-01-01' WHERE id=$1", [event.id]);
    assert.equal(await job.runDraftReminderPass(), 0, 'past events are not a draft-completion journey');
    await pool.query("UPDATE events SET event_date='2099-08-10',archived_at=NOW() WHERE id=$1", [event.id]);
    assert.equal(await job.runDraftReminderPass(), 0);
    await pool.query("UPDATE events SET archived_at=NULL,status='cancelled' WHERE id=$1", [event.id]);
    assert.equal(await job.runDraftReminderPass(), 0);
    await pool.query("UPDATE events SET status='published' WHERE id=$1", [event.id]);
    assert.equal(await job.runDraftReminderPass(), 0);
    await pool.query("UPDATE events SET status='draft' WHERE id=$1", [event.id]);
    assert.equal(await job.runDraftReminderPass(), 0, 'returning a previously published event to draft does not enroll it');
    const legacy = await draft({ draft_host_activity_at: null });
    await pool.query('UPDATE events SET updated_at=NOW() WHERE id=$1', [legacy.id]);
    assert.equal(await job.runDraftReminderPass(), 0, 'system timestamps do not enroll a legacy draft');
  });

  test('draft reminder rechecks host activity publication deletion and account status at delivery', async () => {
    const host = await account();
    const event = await draft();
    const job = worker();
    let candidate = (await job.pendingDraftReminders())[0];
    assert.ok(candidate);
    const edited = await request(`/api/events/${event.id}`, { method: 'PUT', body: { description: 'Just saved another change' } });
    assert.equal(edited.status, 200);
    assert.equal(await job.deliverDraftReminder(candidate), false);
    await pool.query('UPDATE events SET draft_host_activity_at=$2 WHERE id=$1', [event.id, hoursAgo(25)]);
    candidate = (await job.pendingDraftReminders())[0];
    await pool.query("UPDATE users SET account_status='suspended',suspended_at=NOW(),suspension_reason='Draft reminder integration' WHERE id=$1", [host.id]);
    assert.equal(await job.deliverDraftReminder(candidate), false);
    await pool.query("UPDATE users SET account_status='active',suspended_at=NULL,suspension_reason=NULL WHERE id=$1", [host.id]);
    await pool.query("UPDATE events SET status='published' WHERE id=$1", [event.id]);
    assert.equal(await job.deliverDraftReminder(candidate), false);
    await pool.query('DELETE FROM events WHERE id=$1', [event.id]);
    assert.equal(await job.deliverDraftReminder(candidate), false);
    assert.equal(job.deliveries.length, 0);
  });

  test('draft reminder seven-day host cooldown survives deletion of the previously reminded event', async () => {
    const host = await account();
    const event = await draft();
    const job = worker();
    assert.equal(await job.runDraftReminderPass(), 1);
    const deleted = await request(`/api/events/${event.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    const next = await draft();
    assert.equal(await job.runDraftReminderPass(), 0, 'deletion cannot bypass the host-level cooldown');
    const storedHost = (await pool.query('SELECT first_draft_reminder_attempt_at,last_draft_reminder_attempt_at FROM organizers WHERE id=$1', [host.id])).rows[0];
    assert.ok(storedHost.first_draft_reminder_attempt_at);
    assert.ok(storedHost.last_draft_reminder_attempt_at);
    await pool.query("UPDATE organizers SET last_draft_reminder_attempt_at=NOW()-INTERVAL '8 days' WHERE id=$1", [host.id]);
    assert.equal(await job.runDraftReminderPass(), 1);
    assert.equal(job.deliveries.length, 2);
    assert.equal(job.deliveries[1].idempotencyKey, `sge-draft-reminder-v1-${next.id}`);
  });

  test('draft reminder honors verified-account email and direct or inherited optional-email opt-outs', async () => {
    const host = await account();
    await draft();
    const job = worker();
    assert.equal((await job.pendingDraftReminders()).length, 1,
      'the absence of a separate post-recap opt-in does not itself opt out of draft reminders');
    await setEmailPreference(pool, host.email, 'host_drafts', false);
    assert.equal(await job.runDraftReminderPass(), 0);
    await setEmailPreference(pool, host.email, 'host_drafts', true);
    await setEmailPreference(pool, host.email, 'host_onboarding', false);
    assert.equal(await job.runDraftReminderPass(), 0);
    await pool.query("UPDATE email_optouts SET updated_at=NOW()-INTERVAL '1 day' WHERE email=$1 AND scope='host_onboarding'", [host.email]);
    await setEmailPreference(pool, host.email, 'host_drafts', true);
    assert.equal((await job.pendingDraftReminders()).length, 1, 'a later explicit draft preference can override inherited silence');
    await pool.query('UPDATE user_identities SET revoked_at=NOW() WHERE id=$1', [host.identity.id]);
    assert.equal(await job.runDraftReminderPass(), 0, 'a revoked address is not replaced with the legacy organizer email');
    assert.equal(job.deliveries.length, 0);
  });

  test('draft reminder spacing avoids recent onboarding tips and morning-after recaps', async () => {
    const host = await account();
    await draft();
    const job = worker();
    await pool.query('UPDATE organizers SET host_profile_nudge_sent_at=NOW() WHERE id=$1', [host.id]);
    assert.equal(await job.runDraftReminderPass(), 0);
    await pool.query("UPDATE organizers SET host_profile_nudge_sent_at=NOW()-INTERVAL '8 days',first_event_nudge_sent_at=NOW() WHERE id=$1", [host.id]);
    assert.equal(await job.runDraftReminderPass(), 0);
    await pool.query("UPDATE organizers SET first_event_nudge_sent_at=NOW()-INTERVAL '8 days' WHERE id=$1", [host.id]);
    const recap = await createEvent({ slug: `draft-recent-recap-${++serial}`, event_date: '2000-01-01', host_recap_delivered_at: new Date() });
    assert.equal(await job.runDraftReminderPass(), 0);
    await pool.query("UPDATE events SET host_recap_delivered_at=NOW()-INTERVAL '25 hours' WHERE id=$1", [recap.id]);
    assert.equal(await job.runDraftReminderPass(), 1);
  });

  test('draft reminder retries use one frozen provider key and stop when the host resumes', async t => {
    await account();
    const event = await draft();
    const attempted = [];
    t.mock.method(console, 'error', () => {});
    const job = require('../../src/jobs/draft-reminders').createDraftReminderWorker({
      db: pool,
      sendEmail: async message => {
        attempted.push(message);
        throw new Error('Synthetic provider failure: no external request made');
      }
    });
    assert.equal(await job.runDraftReminderPass(), 0);
    assert.equal(attempted.length, 1);
    assert.equal(await job.runDraftReminderPass(), 0, 'the two-minute retry delay is enforced');
    assert.equal(attempted.length, 1);
    await pool.query("UPDATE event_draft_reminders SET last_attempt_at=NOW()-INTERVAL '3 minutes' WHERE event_id=$1", [event.id]);
    assert.equal(await job.runDraftReminderPass(), 0);
    assert.equal(attempted.length, 2);
    assert.deepEqual(attempted[1], attempted[0], 'same recipient, body and provider idempotency key on retry');
    const changed = await request(`/api/events/${event.id}`, { method: 'PUT', body: { title: 'Resumed draft work' } });
    assert.equal(changed.status, 200);
    const delivery = (await pool.query('SELECT status,error,attempt_count FROM event_draft_reminders WHERE event_id=$1', [event.id])).rows[0];
    assert.deepEqual(delivery, { status: 'suppressed', error: 'host_resumed', attempt_count: 2 });
    await pool.query('UPDATE events SET draft_host_activity_at=$2 WHERE id=$1', [event.id, hoursAgo(25)]);
    await pool.query("UPDATE event_draft_reminders SET last_attempt_at=NOW()-INTERVAL '3 minutes' WHERE event_id=$1", [event.id]);
    assert.equal(await job.runDraftReminderPass(), 0);
    assert.equal(attempted.length, 2, 'a new payload must never reuse an already attempted provider key');
  });

  test('draft reminder final handoff serializes a concurrent host edit on the same saved event', { timeout: 10000 }, async () => {
    await account();
    const event = await draft({ title: 'Before the concurrent edit' });
    let enteredSend;
    let finishSend;
    const entered = new Promise(resolve => { enteredSend = resolve; });
    const finish = new Promise(resolve => { finishSend = resolve; });
    const attempted = [];
    const job = require('../../src/jobs/draft-reminders').createDraftReminderWorker({
      db: pool,
      sendEmail: async message => {
        attempted.push(message);
        enteredSend();
        await finish;
        return { id: 'mock-draft-lock-race' };
      }
    });
    const sending = job.runDraftReminderPass();
    let editing;
    let editSettled = false;
    try {
      await Promise.race([entered, sending.then(() => { throw new Error('Mock delivery did not reach the final handoff'); })]);
      editing = request(`/api/events/${event.id}`, {
        method: 'PUT', body: { title: 'After the concurrent edit' }
      }).then(response => { editSettled = true; return response; });
      let observedWait = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        const waiting = (await pool.query(
          `SELECT COUNT(*)::int AS count FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock'
              AND query ILIKE '%FROM events%FOR UPDATE%'`
        )).rows[0].count;
        if (waiting > 0) { observedWait = true; break; }
        if (editSettled) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(observedWait, true, 'the concurrent mutation reached PostgreSQL and is waiting on the event row');
      assert.equal(editSettled, false, 'a host edit cannot commit between the final eligibility check and provider handoff');
      assert.equal((await row(event.id)).title, 'Before the concurrent edit');
    } finally {
      finishSend();
      await Promise.allSettled([sending, ...(editing ? [editing] : [])]);
    }
    assert.equal(await sending, 1);
    assert.equal((await editing).status, 200);
    assert.equal((await row(event.id)).title, 'After the concurrent edit');
    assert.equal(attempted.length, 1);
    assert.match(attempted[0].html, /Before the concurrent edit/);
    assert.equal((await pool.query('SELECT status FROM event_draft_reminders WHERE event_id=$1', [event.id])).rows[0].status, 'sent');
    assert.equal(await job.runDraftReminderPass(), 0);
  });
};
