const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  canAppearInPublicListings,
  cleanComment,
  ATTENDEE_AVATARS,
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
  assert.ok(ATTENDEE_AVATARS.includes('🎃'));
  assert.ok(ATTENDEE_AVATARS.includes('👽'));
  assert.ok(ATTENDEE_AVATARS.includes('🧟'));
  assert.ok(ATTENDEE_AVATARS.includes('🥷'));
  assert.ok(ATTENDEE_AVATARS.includes('👻'));
  assert.ok(ATTENDEE_AVATARS.includes('👨‍🎤'));
  assert.equal(ATTENDEE_AVATARS.includes('🕴️'), false);
  assert.equal(ATTENDEE_AVATARS.includes('🤓'), false);
  const serialized = JSON.stringify(names);
  for (const secret of ['Private', 'Secret', '@example.com', '555-0100', '91']) {
    assert.equal(serialized.includes(secret), false);
  }
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
  assert.match(source, /if \(isNewRsvp && event\.comments_enabled\)/);
  assert.match(source, /setAttendeeCookie\(res, event\.id, rsvp\.manage_token\)/);

  const clientSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'public-event.js'), 'utf8');
  assert.match(clientSource, /await loadComments\(\)/);
});
