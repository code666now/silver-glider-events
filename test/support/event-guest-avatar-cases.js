// Registered by the isolated integration harness. These cases never submit an
// RSVP or dispatch a message: synthetic attendee rows are seeded directly.
module.exports = function registerEventGuestAvatarCases({
  test, assert, pool, createEvent, createRsvp, getOrganizerId, getBaseUrl,
  signSession, mailer
}) {
  const { attendeeAvatar } = require('../../src/lib/private-events');
  let serial = 0;
  const ownerCookie = () => `sge_session=${signSession(getOrganizerId())}`;
  async function event(overrides = {}) {
    return createEvent({
      slug: `event-avatar-${++serial}`, event_date: '2099-08-10',
      show_guest_list: true, ...overrides
    });
  }
  async function override(target, email, emoji = '👰') {
    await pool.query(
      'INSERT INTO event_guest_avatar_overrides(event_id,recipient_email,emoji) VALUES ($1,$2,$3)',
      [target.id, email, emoji]
    );
  }
  async function faces(target) {
    const response = await fetch(`${getBaseUrl()}/api/events/${target.id}/familiar-faces`, {
      headers: { cookie: ownerCookie() }
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function publicHtml(target) {
    const response = await fetch(`${getBaseUrl()}/e/${target.slug}`);
    assert.equal(response.status, 200);
    return response.text();
  }
  async function effects(target) {
    return (await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM rsvps WHERE event_id=$1) AS rsvps,
              (SELECT COUNT(*)::int FROM message_log WHERE event_id=$1) AS messages,
              (SELECT COUNT(*)::int FROM previous_guest_invitation_batches WHERE target_event_id=$1) AS invitations,
              (SELECT COUNT(*)::int FROM sms_notification_batches WHERE event_id=$1) AS texts`,
      [target.id]
    )).rows[0];
  }
  const face = (data, rsvp) => data.faces.find(item => item.id === `rsvp:${rsvp.id}`);

  test('event guest avatars match the exact event and normalized recipient, not a shared name or plus-one', async () => {
    const target = await event();
    const other = await event();
    const intended = await createRsvp(target.id, {
      first_name: 'Mira', last_name: 'ConfidentialSurname', email: ' MIRA-AVATAR@EXAMPLE.TEST ',
      guest_first_name: 'Companion', guest_last_name: 'PrivateCompanion',
      guest_email: 'companion-avatar@example.test'
    });
    const sameName = await createRsvp(target.id, {
      first_name: 'Mira', last_name: 'ConfidentialSurname', email: 'other-mira-avatar@example.test'
    });
    const dolphin = await createRsvp(target.id, {
      first_name: 'Nori', last_name: 'PrivateDolphin', email: 'nori-avatar@example.test'
    });
    const elsewhere = await createRsvp(other.id, {
      first_name: 'Mira', last_name: 'ConfidentialSurname', email: 'mira-avatar@example.test'
    });
    const before = await effects(target);
    const outboxCount = mailer.devOutbox.length;
    await override(target, 'mira-avatar@example.test');
    await override(target, 'nori-avatar@example.test', '🐬');
    await override(target, 'companion-avatar@example.test');

    const current = await faces(target);
    assert.equal(face(current, intended).avatarEmoji, '👰');
    assert.equal(face(current, intended).avatarBadge, null, 'an emoji-only face needs no duplicate badge');
    assert.equal(face(current, dolphin).avatarEmoji, '🐬');
    assert.equal(face(current, sameName).avatarEmoji, attendeeAvatar('email:other-mira-avatar@example.test'));
    assert.equal(current.faces.find(item => item.plusOne).avatarEmoji,
      attendeeAvatar(`guest:${intended.id}:companion privatecompanion`));
    assert.equal(current.faces.find(item => item.plusOne).avatarBadge || null, null);
    assert.equal(face(await faces(other), elsewhere).avatarEmoji, attendeeAvatar('email:mira-avatar@example.test'));
    const html = await publicHtml(target);
    assert.match(html, /👰/);
    assert.match(html, /🐬/);
    assert.doesNotMatch(html, /<i class="guest-avatar-badge"/, 'emoji-only avatars need no duplicate badge');
    assert.doesNotMatch(html, /ConfidentialSurname|PrivateCompanion|PrivateDolphin|mira-avatar@|nori-avatar@|companion-avatar@|MIRA-AVATAR@/);
    assert.doesNotMatch(JSON.stringify(current), /@example\.test|recipient_email|event_avatar_emoji/);
    assert.doesNotMatch(await publicHtml(other), /👰/);
    assert.deepEqual(await effects(target), before);
    assert.equal(mailer.devOutbox.length, outboxCount);
  });

  test('a future event guest avatar does not create attendance or decorate unanswered or cancelled invitations', async () => {
    const target = await event();
    const email = 'future-avatar@example.test';
    await override(target, email);
    const empty = await effects(target);
    const outboxCount = mailer.devOutbox.length;
    assert.equal(empty.rsvps, 0);
    assert.deepEqual((await faces(target)).faces, []);
    assert.doesNotMatch(await publicHtml(target), /👰/);
    assert.deepEqual(await effects(target), empty);

    await pool.query(
      `INSERT INTO message_log(event_id,recipient,recipient_name,message_type,channel,status)
       VALUES ($1,$2,'Future Person','previous_guest_invite','email','pending')`,
      [target.id, email]
    );
    const invited = (await faces(target)).faces;
    assert.equal(invited.length, 1);
    assert.equal(invited[0].group, 'invited');
    assert.equal(invited[0].avatarEmoji, attendeeAvatar(`email:${email}`));
    assert.equal(invited[0].avatarBadge || null, null);
    assert.doesNotMatch(await publicHtml(target), /👰/);
    const rsvp = await createRsvp(target.id, {
      first_name: 'Future', last_name: 'Person', email, status: 'cancelled'
    });
    const cancelled = (await faces(target)).faces;
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].group, 'declined');
    assert.equal(cancelled[0].avatarEmoji, attendeeAvatar(`email:${email}`));
    assert.equal(cancelled[0].avatarBadge || null, null);
    assert.doesNotMatch(await publicHtml(target), /👰/);

    await pool.query("UPDATE rsvps SET status='confirmed' WHERE id=$1", [rsvp.id]);
    const beforeReads = await effects(target);
    const confirmed = await faces(target);
    assert.equal(confirmed.faces.length, 1);
    assert.equal(face(confirmed, rsvp).group, 'going');
    assert.equal(face(confirmed, rsvp).avatarEmoji, '👰');
    assert.match(await publicHtml(target), /👰/);
    assert.deepEqual(await effects(target), beforeReads);
    assert.equal(beforeReads.messages, 1, 'only the explicitly seeded invitation exists');
    assert.equal(mailer.devOutbox.length, outboxCount);
  });

  test('event guest avatars preserve account photos and add a bride badge only for that event', async () => {
    const target = await event();
    const other = await event();
    const photo = 'https://res.cloudinary.com/integration-cloud/image/upload/v1/avatar-bride.jpg';
    const account = (await pool.query(
      'INSERT INTO organizers(email,name,avatar_url) VALUES ($1,$2,$3) RETURNING id',
      ['photo-avatar@example.test', 'Photo Guest', photo]
    )).rows[0];
    const bride = await createRsvp(target.id, {
      first_name: 'Photo', last_name: 'PrivatePhotoGuest', email: 'photo-avatar@example.test', account_id: account.id
    });
    const elsewhere = await createRsvp(other.id, {
      first_name: 'Photo', email: 'photo-avatar@example.test', account_id: account.id
    });
    await override(target, 'photo-avatar@example.test');
    const outboxCount = mailer.devOutbox.length;
    const current = face(await faces(target), bride);
    assert.equal(current.avatarUrl, photo);
    assert.equal(current.avatarEmoji, '👰');
    assert.equal(current.avatarBadge, '👰');
    const unmodified = face(await faces(other), elsewhere);
    assert.equal(unmodified.avatarUrl, photo);
    assert.equal(unmodified.avatarBadge, null);
    assert.equal(unmodified.avatarEmoji, attendeeAvatar('email:photo-avatar@example.test'));
    const html = await publicHtml(target);
    assert.ok(html.includes(`<img src="${photo}"`));
    assert.match(html, /<i class="guest-avatar-badge" aria-hidden="true">👰<\/i>/);
    assert.doesNotMatch(html, /PrivatePhotoGuest|photo-avatar@example/);
    assert.doesNotMatch(await publicHtml(other), /👰/);

    await pool.query('UPDATE event_guest_avatar_overrides SET emoji=$3 WHERE event_id=$1 AND recipient_email=$2',
      [target.id, 'photo-avatar@example.test', '🐬']);
    const dolphin = face(await faces(target), bride);
    assert.equal(dolphin.avatarUrl, photo);
    assert.equal(dolphin.avatarEmoji, '🐬');
    assert.equal(dolphin.avatarBadge, null, 'ordinary emoji overrides remain photo fallbacks');
    assert.equal((await pool.query('SELECT avatar_url FROM organizers WHERE id=$1', [account.id])).rows[0].avatar_url, photo);
    assert.equal(mailer.devOutbox.length, outboxCount);
  });

  test('event guest avatars respect hidden public guest lists without hiding the owner management face', async () => {
    const target = await event({ show_guest_list: false });
    const rsvp = await createRsvp(target.id, {
      first_name: 'UnlistedGuest', last_name: 'UnlistedPrivate', email: 'unlisted-avatar@example.test'
    });
    await override(target, 'unlisted-avatar@example.test');
    const before = await effects(target);
    const html = await publicHtml(target);
    assert.doesNotMatch(html, /<section class="public-guest-list"|UnlistedGuest|UnlistedPrivate|unlisted-avatar@example|👰/);
    assert.equal(face(await faces(target), rsvp).avatarEmoji, '👰');
    const unauthorized = await fetch(`${getBaseUrl()}/api/events/${target.id}/familiar-faces`);
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await effects(target), before);
  });

  test('event guest avatar choices never become global past-event invitation identities', async () => {
    const source = await event({ event_date: '2020-08-10' });
    const target = await event();
    const guest = await createRsvp(source.id, {
      first_name: 'Past', last_name: 'Guest', email: 'past-avatar@example.test', organizer_optin: true
    });
    await override(source, 'past-avatar@example.test');
    assert.equal(face(await faces(source), guest).avatarEmoji, '👰');
    const before = await effects(target);
    const response = await fetch(`${getBaseUrl()}/api/events/${target.id}/familiar-faces/people`, {
      headers: { cookie: ownerCookie() }
    });
    assert.equal(response.status, 200);
    const people = await response.json();
    assert.equal(people.people.length, 1);
    assert.equal(people.people[0].avatarEmoji, attendeeAvatar('email:past-avatar@example.test'));
    assert.equal(people.people[0].avatarBadge || null, null);
    assert.deepEqual((await faces(target)).faces, []);
    assert.deepEqual(await effects(target), before);
  });

  test('event guest avatar storage enforces normalized recipients, supported emojis, unique event scope and cascade cleanup', async () => {
    const target = await event();
    const other = await event();
    const email = 'constraints-avatar@example.test';
    await override(target, email);
    await override(other, email, '🐬');
    await assert.rejects(override(target, email, '🐬'), error => error.code === '23505');
    for (const recipient of ['UPPER@example.test', ' leading@example.test', 'trailing@example.test ']) {
      await assert.rejects(override(target, recipient), error => error.code === '23514');
    }
    for (const emoji of ['🎃', '🧟', '👻', '<script>', 'arbitrary', '']) {
      await assert.rejects(override(target, `unsupported-${++serial}@example.test`, emoji), error => error.code === '23514');
    }
    for (const emoji of ['🐳', '🐟', '🐬', '🦭', '🦀']) {
      await override(target, `marine-${++serial}@example.test`, emoji);
    }
    await pool.query('DELETE FROM events WHERE id=$1', [target.id]);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM event_guest_avatar_overrides WHERE event_id=$1', [target.id])).rows[0].count, 0);
    assert.equal((await pool.query('SELECT emoji FROM event_guest_avatar_overrides WHERE event_id=$1 AND recipient_email=$2', [other.id, email])).rows[0].emoji, '🐬');
    await assert.rejects(override(target, 'deleted-avatar@example.test'), error => error.code === '23503');
  });
};
