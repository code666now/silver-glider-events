// Registered by the HTTP/PostgreSQL integration harness. Standalone discovery
// does not initialize credentials, a database, or an outbound provider.
module.exports = function registerDraftManageCases({
  test, assert, pool, createEvent, createRsvp, getOrganizerId, getBaseUrl,
  signSession, mailer
}) {
  let serial = 0;
  const ownerCookie = () => `sge_session=${signSession(getOrganizerId())}`;
  async function request(path, { method = 'GET', body, cookie = ownerCookie() } = {}) {
    return fetch(`${getBaseUrl()}${path}`, {
      method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  }
  async function event(overrides = {}) {
    return createEvent({ slug: `draft-manage-${++serial}`, event_date: '2099-08-10', ...overrides });
  }
  async function loadPeople(target, query = '') {
    const response = await request(`/api/events/${target.id}/familiar-faces/people${query}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /private, no-store/);
    return response.json();
  }
  async function targetEffects(id) {
    return (await pool.query(
      `SELECT status,
              (SELECT COUNT(*)::int FROM rsvps WHERE event_id=e.id) AS rsvps,
              (SELECT COUNT(*)::int FROM message_log WHERE event_id=e.id) AS messages,
              (SELECT COUNT(*)::int FROM previous_guest_invitation_batches WHERE target_event_id=e.id) AS invites,
              (SELECT COUNT(*)::int FROM sms_notification_batches WHERE event_id=e.id) AS texts
         FROM events e WHERE e.id=$1`, [id]
    )).rows[0];
  }

  test('draft management browses owned past guests without emails, current attendance, or invitation side effects', async () => {
    const target = await event({ title: 'Still a private draft', status: 'draft' });
    const older = await event({ title: 'Older night', event_date: '2020-01-01' });
    const recent = await event({ title: 'Recent night', event_date: '2020-02-01' });
    await createRsvp(older.id, { first_name: 'Regular', last_name: 'Guest', email: 'regular-draft@example.test' });
    const regular = await createRsvp(recent.id, { first_name: 'Regular', last_name: 'Guest', email: 'REGULAR-draft@example.test' });
    const guest = await createRsvp(older.id, {
      first_name: 'One', last_name: 'Visit', email: 'one-draft@example.test', organizer_optin: false,
      guest_first_name: 'Named', guest_last_name: 'Friend', guest_email: 'named-draft@example.test'
    });
    await createRsvp(older.id, { first_name: 'Opted', email: 'opted-draft@example.test' });
    await pool.query('INSERT INTO follower_optouts (organizer_id,email) VALUES ($1,$2)', [getOrganizerId(), 'opted-draft@example.test']);
    await createRsvp(older.id, { first_name: 'Cancelled', email: 'cancelled-draft@example.test', status: 'cancelled' });
    const future = await event({ title: 'Not history yet' });
    await createRsvp(future.id, { first_name: 'Future', email: 'future-draft@example.test' });
    const oldDraft = await event({ title: 'Never published', status: 'draft', event_date: '2020-03-01' });
    await createRsvp(oldDraft.id, { first_name: 'Neverpublished', email: 'unpublished-draft@example.test' });

    const stranger = (await pool.query(
      `INSERT INTO organizers (email,name,avatar_url) VALUES ($1,'Different host',$2) RETURNING id`,
      ['other-draft@example.test', 'https://res.cloudinary.com/integration-cloud/image/upload/v1/other-avatar.jpg']
    )).rows[0];
    const foreign = await event({ event_date: '2020-04-01' });
    await pool.query('UPDATE events SET organizer_id=$2 WHERE id=$1', [foreign.id, stranger.id]);
    await createRsvp(foreign.id, { first_name: 'Foreign', email: 'foreign-draft@example.test' });
    await createRsvp(older.id, {
      first_name: 'Typed', last_name: 'Address', email: 'other-draft@example.test', account_id: null
    });

    const effects = await targetEffects(target.id);
    const outboxCount = mailer.devOutbox.length;
    const people = await loadPeople(target);
    assert.equal(people.canBrowsePastGuests, true);
    assert.equal(people.canInvite, false);
    assert.equal(people.total, 3);
    assert.deepEqual(people.people.map(person => person.name), ['Regular Guest', 'One Visit', 'Typed Address']);
    assert.equal(people.people[0].id, `rsvp:${regular.id}`);
    assert.equal(people.people[0].detail, '2 of your events');
    assert.equal(people.people[2].avatarUrl, null, 'typed email must not claim a verified account photo');
    assert.deepEqual(people.plusOnes.map(person => [person.id, person.name]), [[`guest:${guest.id}`, 'Named Friend']]);
    assert.deepEqual(people.sources.map(source => source.title), ['Recent night', 'Older night']);
    assert.equal(people.unsubscribedCount, 1);
    assert.equal(people.groups.find(group => group.key === 'regulars').count, 1);
    assert.doesNotMatch(JSON.stringify(people), /@example\.test|manage_token|recipient_user_id|account_id|user_id/);
    assert.deepEqual((await loadPeople(target, '?group=regulars')).people.map(person => person.id), [`rsvp:${regular.id}`]);
    assert.deepEqual((await loadPeople(target, `?sourceEventId=${recent.id}`)).people.map(person => person.id), [`rsvp:${regular.id}`]);
    assert.deepEqual((await loadPeople(target, '?search=one-draft%40')).people.map(person => person.name), ['One Visit']);
    assert.deepEqual((await loadPeople(target, `?sourceEventId=${foreign.id}`)).people, []);

    const connected = await request(`/api/events/${target.id}/familiar-faces`);
    const current = await connected.json();
    assert.deepEqual(current.faces, []);
    assert.equal(current.totalCount, 0, 'past guests are not current attendees');
    assert.deepEqual(await targetEffects(target.id), effects);
    assert.equal(mailer.devOutbox.length, outboxCount);
    assert.equal((await request(`/api/events/${target.id}/familiar-faces/people`, { cookie: '' })).status, 401);
    assert.equal((await request(`/api/events/${target.id}/familiar-faces/people`, {
      cookie: `sge_session=${signSession(stranger.id)}`
    })).status, 404);
  });

  test('draft management never enables individual or bulk invitations until explicit publication', async () => {
    const target = await event({ status: 'draft' });
    const source = await event({ event_date: '2020-01-01' });
    const person = await createRsvp(source.id, { email: 'draft-selected@example.test' });
    const before = await targetEffects(target.id);
    const outboxCount = mailer.devOutbox.length;
    for (const body of [{ faceIds: [`rsvp:${person.id}`] }, { group: 'all' }]) {
      const blocked = await request(`/api/events/${target.id}/familiar-faces/people/invite`, { method: 'POST', body });
      assert.equal(blocked.status, 400);
      assert.match((await blocked.json()).error, /upcoming published event/);
    }
    assert.deepEqual(await targetEffects(target.id), before);
    const published = await request(`/api/events/${target.id}/publish`, { method: 'POST' });
    assert.equal(published.status, 200);
    assert.equal((await published.json()).alreadyPublished, false);
    const people = await loadPeople(target);
    assert.equal(people.canBrowsePastGuests, true);
    assert.equal(people.canInvite, true);
    assert.deepEqual(people.people.map(face => face.id), [`rsvp:${person.id}`]);
    assert.deepEqual(await targetEffects(target.id), { ...before, status: 'published' });
    assert.equal(mailer.devOutbox.length, outboxCount, 'publication itself sends no guest email');
  });

  test('draft management keeps past-guest browsing and invitations blocked for ineligible target states', async () => {
    const source = await event({ event_date: '2020-01-01' });
    const person = await createRsvp(source.id, { email: 'blocked-history@example.test' });
    for (const overrides of [
      { status: 'draft', archived_at: new Date() },
      { status: 'draft', event_date: '2020-02-01' },
      { status: 'draft', visibility: 'private', secret_show_enabled: true },
      { status: 'cancelled' },
      { status: 'published', archived_at: new Date() },
      { status: 'published', event_date: '2020-02-01' },
      { status: 'published', visibility: 'private', secret_show_enabled: true }
    ]) {
      const target = await event(overrides);
      const people = await loadPeople(target);
      assert.equal(people.canBrowsePastGuests, false);
      assert.equal(people.canInvite, false);
      assert.deepEqual(people.people, []);
      assert.deepEqual(people.plusOnes, []);
      assert.deepEqual(people.sources, []);
      const blocked = await request(`/api/events/${target.id}/familiar-faces/people/invite`, {
        method: 'POST', body: { faceIds: [`rsvp:${person.id}`] }
      });
      assert.equal(blocked.status, 400);
      assert.equal((await targetEffects(target.id)).messages, 0);
    }
  });

  test('draft management pagination stays read-only and preserves the same history filters', async () => {
    const target = await event({ status: 'draft', visibility: 'private' });
    const source = await event({ event_date: '2020-01-01' });
    for (let index = 0; index < 50; index += 1) {
      await createRsvp(source.id, {
        first_name: `Person ${String(index).padStart(2, '0')}`, last_name: '',
        email: `page-${index}@example.test`
      });
    }
    const first = await loadPeople(target);
    assert.equal(first.canBrowsePastGuests, true, 'private link-only drafts may plan their owned guest history');
    assert.equal(first.canInvite, false);
    assert.equal(first.total, 50);
    assert.equal(first.people.length, 48);
    assert.equal(first.hasMore, true);
    const second = await loadPeople(target, '?offset=48');
    assert.equal(second.people.length, 2);
    assert.equal(second.total, 50);
    assert.equal(second.hasMore, false);
    assert.equal(new Set([...first.people, ...second.people].map(person => person.id)).size, 50);
    assert.deepEqual(await targetEffects(target.id), { status: 'draft', rsvps: 0, messages: 0, invites: 0, texts: 0 });
  });

  test('draft publication reuses validation and is concurrent-idempotent without automatic invitations', async () => {
    const incomplete = await event({ status: 'draft', venue_name: '' });
    const rejected = await request(`/api/events/${incomplete.id}/publish`, { method: 'POST' });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error, 'Add the title, date, time, and location before publishing');
    assert.equal((await targetEffects(incomplete.id)).status, 'draft');
    const ticketed = await event({ status: 'draft', admission_type: 'silver_glider_tickets', commerce_event_id: null });
    const missingConnection = await request(`/api/events/${ticketed.id}/publish`, { method: 'POST' });
    assert.equal(missingConnection.status, 400);
    assert.equal((await missingConnection.json()).error, 'Connect this event to Silver Glider Commerce before publishing');
    const target = await event({ status: 'draft' });
    const outboxCount = mailer.devOutbox.length;
    const results = await Promise.all([1, 2].map(() => request(`/api/events/${target.id}/publish`, { method: 'POST' })));
    assert.deepEqual(results.map(response => response.status), [200, 200]);
    const bodies = await Promise.all(results.map(response => response.json()));
    assert.deepEqual(bodies.map(body => body.alreadyPublished).sort(), [false, true]);
    assert.ok(bodies.every(body => body.event.status === 'published'));
    assert.deepEqual(await targetEffects(target.id), { status: 'published', rsvps: 0, messages: 0, invites: 0, texts: 0 });
    assert.equal(mailer.devOutbox.length, outboxCount);
  });

  test('draft history invitation rechecks target publication after acquiring its event lock', async () => {
    const target = await event();
    const source = await event({ event_date: '2020-01-01' });
    const person = await createRsvp(source.id, { email: 'locked-draft@example.test' });
    assert.equal((await loadPeople(target)).canInvite, true);
    const client = await pool.connect();
    let pending;
    try {
      await client.query('BEGIN');
      await client.query("UPDATE events SET status='draft' WHERE id=$1", [target.id]);
      pending = request(`/api/events/${target.id}/familiar-faces/people/invite`, {
        method: 'POST', body: { faceIds: [`rsvp:${person.id}`] }
      });
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
        const result = await pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
             AND wait_event_type='Lock' AND query LIKE 'SELECT e.*, e.event_date%FOR UPDATE'`
        );
        waiting = result.rowCount > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(waiting, true, 'the invitation waits for the target event state transition');
      await client.query('COMMIT');
      const response = await pending;
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /upcoming published event/);
      assert.deepEqual(await targetEffects(target.id), { status: 'draft', rsvps: 0, messages: 0, invites: 0, texts: 0 });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      if (pending) await pending;
    }
  });
};
