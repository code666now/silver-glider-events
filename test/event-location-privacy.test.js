const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  HIDDEN_LOCATION_MESSAGE,
  addressPrivacyEnabled,
  calendarEventForViewer,
  locationForViewer
} = require('../src/lib/event-location-privacy');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

function sampleEvent(overrides = {}) {
  return {
    slug: 'private-night',
    visibility: 'private',
    admission_type: 'free_rsvp',
    hide_address_until_rsvp: true,
    venue_name: 'The Secret Room',
    venue_address: '123 Hidden Street, San Francisco, CA 94110',
    venue_city: 'San Francisco',
    venue_state: 'CA',
    ...overrides
  };
}

test('private free-RSVP events can hide their exact location until RSVP', () => {
  const event = sampleEvent();
  assert.equal(addressPrivacyEnabled(event), true);
  assert.deepEqual(locationForViewer(event), {
    name: 'San Francisco, CA',
    address: HIDDEN_LOCATION_MESSAGE,
    mapsUrl: null,
    hidden: true
  });
  assert.deepEqual(locationForViewer(event, { canViewExact: true }), {
    name: 'The Secret Room',
    address: '123 Hidden Street, San Francisco, CA 94110',
    mapsUrl: 'https://maps.google.com/?q=The%20Secret%20Room%2C%20123%20Hidden%20Street%2C%20San%20Francisco%2C%20CA%2094110',
    hidden: false
  });
});

test('address privacy is inert for public and external-ticket events', () => {
  for (const event of [
    sampleEvent({ visibility: 'public' }),
    sampleEvent({ admission_type: 'external_tickets' }),
    sampleEvent({ hide_address_until_rsvp: false })
  ]) {
    assert.equal(addressPrivacyEnabled(event), false);
    const location = locationForViewer(event);
    assert.equal(location.hidden, false);
    assert.equal(location.name, 'The Secret Room');
    assert.match(location.mapsUrl, /123%20Hidden%20Street/);
  }
});

test('public calendar projection removes venue and street without mutating the event', () => {
  const event = sampleEvent();
  const safeEvent = calendarEventForViewer(event);
  assert.notEqual(safeEvent, event);
  assert.equal(safeEvent.venue_name, 'San Francisco, CA');
  assert.equal(safeEvent.venue_address, '');
  assert.equal(event.venue_name, 'The Secret Room');
  assert.equal(event.venue_address, '123 Hidden Street, San Francisco, CA 94110');
  assert.equal(calendarEventForViewer(event, { canViewExact: true }), event);
});

test('public rendering and RSVP responses enforce location privacy server-side', () => {
  const route = read('src/routes/public.js');
  const standard = read('src/views/event-public.html');
  const flyer = read('src/views/event-public-flyer.html');
  const client = read('public/js/public-event.js');

  assert.match(route, /locationForViewer\(event, \{ canViewExact: canViewExactLocation \}\)/);
  assert.match(route, /calendarEventForViewer\(event, \{ canViewExact: false \}\)/);
  assert.match(route, /addressPrivacyEnabled\(event\) && \(isNewRsvp \|\| ownsExisting\)/);
  assert.match(route, /location: locationResponse\(event, \{/);
  assert.match(route, /canViewExact: answer === 'going'/);
  assert.match(route, /`\/r\/\$\{encodeURIComponent\(req\.params\.token\)\}\/calendar\.ics`/);
  assert.doesNotMatch(standard, /\{\{MAPS_URL\}\}/);
  assert.match(standard, /id="event-location-map">\{\{MAPS_LINK_HTML\}\}/);
  assert.match(standard, /id="rsvp-form-title">RSVP/);
  assert.match(standard, /id="rsvp-form-context" hidden>The exact address will appear immediately after you’re confirmed\./);
  assert.match(flyer, /\{\{FLYER_VENUE_HTML\}\}/);
  assert.match(flyer, /id="rsvp-form-title">RSVP/);
  assert.match(flyer, /id="rsvp-form-context" hidden>The exact address will appear immediately after you’re confirmed\./);
  assert.match(route, /class="location-rsvp-trigger"[\s\S]*data-open-rsvp[\s\S]*data-rsvp-context="location"[\s\S]*type="button"[\s\S]*aria-controls=/);
  assert.match(route, /RSVP to reveal the exact address/);
  assert.match(route, /addressPrivacyEnabled\(event\)[\s\S]*rsvpEnabled[\s\S]*event\.status === 'published'[\s\S]*!isFull/);
  assert.match(client, /function applyLocation\(location\)/);
  assert.match(client, /if \(data\.location\) applyLocation\(data\.location\)/);
  assert.match(client, /EVENT\.returningGuest\.calendarUrl = data\.location\.calendarUrl/);
  assert.match(client, /context === 'location'/);
  assert.match(client, /RSVP to see the full address/);
});

test('public client replaces location, Maps, confirmation, and calendar details in place', () => {
  const client = read('public/js/public-event.js');
  const applyStart = client.indexOf('function applyLocation(location)');
  const applyEnd = client.indexOf('if (EVENT.location) applyLocation(EVENT.location)', applyStart);
  const applyLocation = client.slice(applyStart, applyEnd);

  assert.ok(applyStart >= 0 && applyEnd > applyStart, 'applyLocation implementation is present');
  assert.match(applyLocation, /event-location-name/);
  assert.match(applyLocation, /event-location-address/);
  assert.match(applyLocation, /event-location-map/);
  assert.match(applyLocation, /event-location-rsvp/);
  assert.match(applyLocation, /map\.querySelectorAll\('a'\)\.forEach\(link => link\.remove\(\)\)/);
  assert.match(applyLocation, /rsvpAction\.hidden = !canPromptForLocation/);
  assert.match(applyLocation, /link\.href = location\.mapsUrl/);
  assert.match(applyLocation, /rsvp-confirmation-location-name/);
  assert.match(applyLocation, /rsvp-confirmation-location-address/);
  assert.match(applyLocation, /calendar\.href = location\.calendarUrl \|\| EVENT\.calendarUrl \|\| publicIcsUrl/);

  const returningStart = client.indexOf('async function answerReturningRsvp');
  const returningEnd = client.indexOf("$('returning-rsvp-change')?.addEventListener", returningStart);
  const returningFlow = client.slice(returningStart, returningEnd);
  assert.match(returningFlow, /EVENT\.returningGuest\.calendarUrl = data\.location\.calendarUrl \|\| publicIcsUrl/);
  assert.match(returningFlow, /applyLocation\(data\.location\)/);

  const submitStart = client.indexOf('async function submitRsvp');
  const submitEnd = client.indexOf("$('rsvp-form')?.addEventListener", submitStart);
  const submitFlow = client.slice(submitStart, submitEnd);
  assert.match(submitFlow, /personalAccess\.rsvpToken = data\.rsvpToken/);
  assert.match(submitFlow, /if \(data\.location\) applyLocation\(data\.location\)/);
});

test('exact-location responses are private and past attendees keep authorization without RSVP UI', () => {
  const route = read('src/routes/public.js');
  const client = read('public/js/public-event.js');
  const recognitionStart = route.indexOf('const recognizedGuestCandidate');
  const recognitionEnd = route.indexOf('const recognizedGuest =', recognitionStart);
  const recognition = route.slice(recognitionStart, recognitionEnd);
  assert.match(recognition, /rsvpEnabled && event\.status === 'published'/);
  assert.doesNotMatch(recognition, /!event\.is_past/);

  const exactAccessStart = route.indexOf('const canViewExactLocation');
  const exactAccessEnd = route.indexOf("if (event.visibility === 'private')", exactAccessStart);
  const exactAccess = route.slice(exactAccessStart, exactAccessEnd);
  assert.match(exactAccess, /returningGuest\?\.rsvp\?\.status === 'confirmed'/);
  assert.match(exactAccess, /returningGuest \|\| canViewExactLocation/);
  assert.match(exactAccess, /Cache-Control', 'private, no-store'/);
  assert.match(exactAccess, /Referrer-Policy', 'no-referrer'/);

  assert.match(client, /if \(!EVENT\.isPast && EVENT\.returningGuest\?\.response/);
});

test('token management and already-confirmed RSVP recovery preserve private attendee access', () => {
  const route = read('src/routes/public.js');
  const confirmedStart = route.indexOf("if (existing.length && existing[0].status === 'confirmed')");
  const confirmedEnd = route.indexOf('// Re-confirming a cancelled RSVP', confirmedStart);
  const confirmedBranch = route.slice(confirmedStart, confirmedEnd);
  assert.match(confirmedBranch, /if \(ownsExisting && \(event\.comments_enabled \|\| addressPrivacyEnabled\(event\)\)\) \{[\s\S]*setAttendeeCookie\(res, event\.id, existing\[0\]\.manage_token\)/);

  const manageStart = route.indexOf("router.get('/r/:token',");
  const manageEnd = route.indexOf('// GET is the visible email link', manageStart);
  const manageRoute = route.slice(manageStart, manageEnd);
  assert.match(manageRoute, /Cache-Control', 'private, no-store'/);
  assert.match(manageRoute, /Referrer-Policy', 'no-referrer'/);
  assert.match(manageRoute, /canViewExact: row\.rsvp_status === 'confirmed'/);
});
