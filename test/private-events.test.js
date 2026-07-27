const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  attendanceCounts,
  canAppearInPublicListings,
  cleanComment,
  normalizePrivateSettings,
  parseNamedGuest,
  publicGuestNames,
  robotsDirective
} = require('../src/lib/private-events');

test('private settings are opt-in and can never leak onto a public event', () => {
  assert.deepEqual(normalizePrivateSettings('public', {
    show_guest_list: true,
    allow_guests: true,
    comments_enabled: true
  }), {
    show_guest_list: false,
    allow_guests: false,
    comments_enabled: false
  });
  assert.deepEqual(normalizePrivateSettings('private', {
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
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'public.js'), 'utf8');
  assert.match(source, /AND visibility='public'/);
  assert.match(source, /X-Robots-Tag/);
  assert.match(source, /noindex, nofollow, noarchive/);
});

test('The Line feed and review action exclude private or unpublished events', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin.js'), 'utf8');
  assert.match(source, /conditions = \["e\.visibility='public'", "e\.status='published'"\]/);
  assert.match(source, /AND e\.visibility='public'\s+AND e\.status='published'/);
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
  assert.deepEqual(names, [
    { firstName: 'Avery', isGuest: false },
    { firstName: 'Sam', isGuest: true }
  ]);
  const serialized = JSON.stringify(names);
  for (const secret of ['Private', 'Secret', '@example.com', '555-0100', '91']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('attendance totals include at most one named guest per RSVP', () => {
  assert.deepEqual(attendanceCounts([
    { status: 'confirmed', guest_first_name: 'June' },
    { status: 'confirmed', guest_first_name: null },
    { status: 'cancelled', guest_first_name: 'Not attending' }
  ]), { submissionCount: 2, guestCount: 1, totalAttendance: 3 });
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
