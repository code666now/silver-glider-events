const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  canAppearInPublicListings,
  cleanComment,
  ATTENDEE_AVATARS,
  attendeeAvatar,
  eventGuestAvatar,
  normalizeGuestExperienceSettings,
  parseNamedGuest,
  publicGuestNames,
  robotsDirective
} = require('../src/lib/private-events');

test('guest experience settings are opt-in for both public and private events', () => {
  assert.deepEqual(normalizeGuestExperienceSettings({
    show_guest_list: true,
    allow_guests: true,
    comments_enabled: true
  }), {
    show_guest_list: true,
    allow_guests: true,
    comments_enabled: true
  });
  assert.deepEqual(normalizeGuestExperienceSettings({
    show_guest_list: true,
    allow_guests: false,
    comments_enabled: true
  }), {
    show_guest_list: true,
    allow_guests: false,
    comments_enabled: true
  });
});

test('only published public events are eligible for public listings', () => {
  assert.equal(canAppearInPublicListings({ visibility: 'public', status: 'published' }), true);
  assert.equal(canAppearInPublicListings({ visibility: 'private', status: 'published' }), false);
  assert.equal(canAppearInPublicListings({ visibility: 'public', status: 'draft' }), false);
  assert.equal(robotsDirective('private'), 'noindex, nofollow, noarchive');
  assert.equal(robotsDirective('public'), 'index, follow');
});

test('host page query and private response retain link-only privacy contracts', () => {
  const hostSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'public-hosts.js'), 'utf8');
  const eventSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'public.js'), 'utf8');
  assert.match(hostSource, /AND visibility='public'/);
  assert.match(eventSource, /X-Robots-Tag/);
  assert.match(eventSource, /noindex, nofollow, noarchive/);
});

test('The Line feed and review action exclude private or unpublished events', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin.js'), 'utf8');
  const reviewView = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'admin-line.html'), 'utf8');
  assert.match(source, /conditions = \["e\.visibility='public'", "e\.status='published'"\]/);
  assert.match(source, /AND e\.visibility='public'\s+AND e\.status='published'/);
  assert.match(reviewView, /class="sg-shell line-admin-shell"/);
  assert.match(reviewView, /@media\(min-width:1024px\)[\s\S]*\.line-admin-shell \{ max-width:1260px/);
  assert.match(reviewView, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(reviewView, /@media\(max-width:620px\)/);
});

test('public guest list exposes first names only', () => {
  const names = publicGuestNames([{
    id: 91,
    first_name: 'Avery',
    last_name: 'Private',
    email: 'avery@example.com',
    phone: '555-0100',
    guest_first_name: 'Sam',
    guest_last_name: 'Secret',
    guest_email: 'sam@example.com'
  }]);
  assert.deepEqual(names.map(({ firstName, isGuest, avatarUrl }) => ({ firstName, isGuest, avatarUrl })), [
    { firstName: 'Avery', isGuest: false, avatarUrl: null },
    { firstName: 'Sam', isGuest: true, avatarUrl: null }
  ]);
  assert.equal(names.every(({ avatarEmoji }) => ATTENDEE_AVATARS.includes(avatarEmoji)), true);
  assert.ok(ATTENDEE_AVATARS.includes('😎'));
  assert.ok(ATTENDEE_AVATARS.includes('🤠'));
  assert.ok(ATTENDEE_AVATARS.includes('🐳'));
  assert.ok(ATTENDEE_AVATARS.includes('👽'));
  assert.ok(ATTENDEE_AVATARS.includes('🐟'));
  assert.ok(ATTENDEE_AVATARS.includes('🥷'));
  assert.ok(ATTENDEE_AVATARS.includes('🐬'));
  assert.ok(ATTENDEE_AVATARS.includes('🦭'));
  assert.ok(ATTENDEE_AVATARS.includes('🦀'));
  assert.ok(ATTENDEE_AVATARS.includes('👨‍🎤'));
  assert.equal(ATTENDEE_AVATARS.includes('🕴️'), false);
  assert.equal(ATTENDEE_AVATARS.includes('🤓'), false);
  const serialized = JSON.stringify(names);
  for (const secret of ['Private', 'Secret', '@example.com', '555-0100', '91']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('both avatar paths use the year-round mix without Halloween or random brides', () => {
  const cycle = Array.from({ length: ATTENDEE_AVATARS.length }, (_, index) => attendeeAvatar(index));
  assert.deepEqual(new Set(cycle), new Set(ATTENDEE_AVATARS));
  for (const excluded of ['🎃', '🧟', '👻', '👰']) {
    assert.equal(ATTENDEE_AVATARS.includes(excluded), false);
    assert.equal(cycle.includes(excluded), false);
  }
  for (let index = 0; index < 100; index++) {
    assert.ok(ATTENDEE_AVATARS.includes(attendeeAvatar(`email:guest-${index}@example.test`)));
  }
});

test('a 17-person list shows every year-round character without clustering', () => {
  const rows = Array.from({ length: 17 }, (_, index) => ({
    id: index + 1,
    first_name: `Guest ${index + 1}`,
    avatar_url: index === 0
      ? 'https://res.cloudinary.com/example/image/upload/profile.jpg'
      : null
  }));
  const counts = new Map();
  for (const { avatarEmoji, avatarUrl } of publicGuestNames(rows)) {
    if (avatarUrl) continue;
    counts.set(avatarEmoji, (counts.get(avatarEmoji) || 0) + 1);
  }
  for (const featured of ATTENDEE_AVATARS) {
    assert.ok(counts.get(featured) >= 1);
  }
  assert.equal(Math.max(...counts.values()), 2);
});

test('event choices preserve photos, restrict badges and never affect plus ones', () => {
  const photo = 'https://res.cloudinary.com/example/image/upload/profile.jpg';
  const names = publicGuestNames([
    { first_name: 'Bride', event_avatar_emoji: '👰', avatar_url: photo, guest_first_name: 'Friend' },
    { first_name: 'Ocean', event_avatar_emoji: '🐬', avatar_url: photo },
    { first_name: 'NoPhoto', event_avatar_emoji: '👰' },
    { first_name: 'Unsafe', event_avatar_emoji: '<script>bad</script>' }
  ]);
  assert.equal(names[0].avatarUrl, photo);
  assert.equal(names[0].avatarBadge, '👰');
  assert.notEqual(names[1].avatarEmoji, '👰');
  assert.equal(names[2].avatarUrl, photo);
  assert.equal(names[2].avatarBadge, null);
  assert.equal(names[2].avatarEmoji, '🐬');
  assert.equal(names[3].avatarEmoji, '👰');
  assert.equal(names[3].avatarBadge, null);
  assert.ok(ATTENDEE_AVATARS.includes(names[4].avatarEmoji));
  for (const bad of ['🎃', '🧟', '👻', '<img>', '', null, undefined]) assert.equal(eventGuestAvatar(bad), null);
});

test('assigning one event emoji does not reshuffle other attendees or their guests', () => {
  const rows = [
    { first_name: 'First', guest_first_name: 'Companion' },
    { first_name: 'Second' },
    { first_name: 'Third' }
  ];
  const before = publicGuestNames(rows);
  const after = publicGuestNames(rows.map((row, index) => index === 0 ? { ...row, event_avatar_emoji: '👰' } : row));
  assert.equal(after[0].avatarEmoji, '👰');
  assert.deepEqual(after.slice(1), before.slice(1));
});

test('named guest validation is server-controlled by the event setting', () => {
  assert.deepEqual(parseNamedGuest({ allow_guests: false }, {
    bringing_guest: true,
    guest_name: 'Unexpected Guest',
    guest_email: 'guest@example.com'
  }), {
    guestFirstName: null,
    guestLastName: null,
    guestEmail: null,
    partySize: 1,
    error: null
  });

  assert.deepEqual(parseNamedGuest({ allow_guests: true }, {
    bringing_guest: true,
    guest_name: 'Jamie Rivera',
    guest_email: 'JAMIE@example.com'
  }), {
    guestFirstName: 'Jamie',
    guestLastName: 'Rivera',
    guestEmail: 'jamie@example.com',
    partySize: 2,
    error: null
  });
  assert.equal(parseNamedGuest({ allow_guests: true }, { bringing_guest: true }).error, 'Enter your guest’s name');
});

test('comments are text-only and limited to 300 characters', () => {
  assert.deepEqual(cleanComment('  See you there!  '), { message: 'See you there!' });
  assert.ok(cleanComment(' '.repeat(10)).error);
  assert.ok(cleanComment('x'.repeat(301)).error);
});

test('fresh comment-enabled RSVPs receive attendee access without trusting existing emails', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'public.js'), 'utf8');
  assert.match(source, /const isNewRsvp = existing\.length === 0/);
  assert.match(source, /if \(event\.comments_enabled && \(isNewRsvp \|\| ownsExisting\)\)/);
  assert.match(source, /setAttendeeCookie\(res, event\.id, rsvp\.manage_token\)/);
  // Owning an existing RSVP takes proof (a verified identity, this browser's
  // guest session, or its attendee token) — never the typed email alone.
  const ownership = source.slice(source.indexOf('const ownsExisting'), source.indexOf('if (existing.length && existing[0].status'));
  assert.match(ownership, /provenIdentityId/);
  assert.match(ownership, /attendeeToken === existing\[0\]\.manage_token/);
  assert.doesNotMatch(ownership, /email/);

  const clientSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'public-event.js'), 'utf8');
  assert.match(clientSource, /await loadComments\(\)/);
});
