'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRidePreview, PREVIEW_PATH, PREVIEW_COOKIE,
  createCityRidePreview, cityRidePreviewEvent, CITY_PREVIEW_PATH, CITY_PREVIEW_SLUG, CITY_PREVIEW_COOKIE
} = require('../src/lib/transit/ride-preview');
const { gettingHomeEligible, sfGettingHomeEligible } = require('../src/lib/transit/getting-home');
const { buildGettingHomePreviewEmail } = require('../src/lib/mailer');

const date = '2026-11-27';
const stamp = Date.parse('2026-11-25T00:00:00Z');
const env = {
  APP_URL: 'https://silvergliderevents.com', SESSION_SECRET: 'test-preview-signing-key',
  TRANSIT_GETTING_HOME_ENABLED: 'true', TRANSIT_TEST_PREVIEW_ENABLED: 'true',
  TRANSIT_DISTRIBUTION_ENABLED: 'false', TRANSIT_RIDE_REMINDERS_ENABLED: 'false'
};
const cityEnv = { ...env, TRANSIT_SF_GETTING_HOME_ENABLED: 'true', GEOAPIFY_API_KEY: 'not-used-in-preview-test' };
const publicWalks = [
  { stopId: 'SF:12034', lat: 37.768924, lon: -122.453128, walkSeconds: 126 },
  { stopId: 'SF:18001', stationId: 'SF:station-1', lat: 37.7698, lon: -122.4481, walkSeconds: 262 }
];

test('test link and cookie grant only the synthetic service night', () => {
  const preview = createRidePreview({ env, now: () => stamp });
  const href = preview.issueLink(date);
  assert.ok(href.startsWith(`${PREVIEW_PATH}/from-test?t=`));
  const token = new URL(href, env.APP_URL).searchParams.get('t');
  const event = preview.verifyLink(token);
  assert.equal(gettingHomeEligible(event, env, stamp), true);
  assert.equal(event.ends_at, Date.parse('2026-11-28T12:00:00Z'));
  assert.equal(event.id, undefined);
  assert.equal(preview.verifyCookie(token), null);
  const cookie = preview.issueCookie(date);
  assert.equal(preview.verifyLink(cookie), null);
  assert.deepEqual(preview.verifyCookie(cookie), event);
  assert.equal(preview.verifyLink(token.replace(date, '2026-11-28')), null);
});

test('preview flags, date validation, and expiry fail closed', () => {
  const runtime = { ...env };
  let now = stamp;
  const preview = createRidePreview({ env: runtime, now: () => now });
  const cookie = preview.issueCookie(date);
  runtime.TRANSIT_TEST_PREVIEW_ENABLED = 'false';
  assert.equal(preview.verifyCookie(cookie), null);
  runtime.TRANSIT_TEST_PREVIEW_ENABLED = 'true';
  assert.equal(preview.issueLink('2026-11-31'), null);
  assert.equal(preview.issueLink('2026-12-08'), null);
  now = Date.parse('2026-11-28T12:00:00Z');
  assert.equal(preview.verifyCookie(cookie), null);
});

test('standalone test email labels the sample and involves no RSVP reminder opt-in link', () => {
  const email = buildGettingHomePreviewEmail({ date, env, now: () => stamp });
  assert.match(email.subject, /^Test: Getting Home/);
  assert.match(email.text, /sample show on Friday, November 27/);
  assert.match(email.text, /published 511 schedules, not live vehicle arrivals/);
  assert.match(email.html, /Open the Getting Home preview/);
  assert.doesNotMatch(email.html, /\/from-email|unsubscribe|confirm RSVP/);
  assert.equal(email.url, buildGettingHomePreviewEmail({ date, env, now: () => stamp + 1000 }).url);
});

test('city preview carries only verified public walks and never accepts pilot or wrong-scope grants', () => {
  const city = createCityRidePreview({ env: cityEnv, now: () => stamp });
  const pilot = createRidePreview({ env: cityEnv, now: () => stamp });
  const walks = [{ ...publicWalks[0], attendeeEmail: 'not-in-token@example.test', address: 'not-in-token' }, publicWalks[1]];
  const href = city.issueLink(date, walks);
  assert.ok(href.startsWith(`${CITY_PREVIEW_PATH}/from-test?t=`));
  const token = new URL(href, env.APP_URL).searchParams.get('t');
  const event = city.verifyLink(token);
  assert.deepEqual(event, { ...cityRidePreviewEvent(date), sfWalks: publicWalks });
  assert.equal(event.slug, CITY_PREVIEW_SLUG);
  assert.equal(event.venue_address, '1725 Haight St, San Francisco, CA, USA');
  assert.equal(sfGettingHomeEligible(event, cityEnv, stamp), true);
  assert.equal(gettingHomeEligible(event, cityEnv, stamp), false);
  assert.doesNotMatch(Buffer.from(token.split('.')[0], 'base64url').toString(), /not-in-token|Haight|attendeeEmail/);
  assert.notEqual(CITY_PREVIEW_COOKIE, PREVIEW_COOKIE);
  assert.equal(city.verifyCookie(token), null);
  assert.equal(pilot.verifyLink(token), null);
  assert.equal(city.verifyCookie(pilot.issueCookie(date)), null);
  const cookie = city.issueCookie(date, event.sfWalks);
  assert.equal(city.verifyLink(cookie), null);
  assert.deepEqual(city.verifyCookie(cookie), event);
  const [payload, sig] = token.split('.');
  const changedDate = Buffer.from(Buffer.from(payload, 'base64url').toString().replace(date, '2026-11-28')).toString('base64url');
  assert.equal(city.verifyLink(`${changedDate}.${sig}`), null);
});

test('city preview validates both flags and window and bounds the signed walk claims', () => {
  const runtime = { ...cityEnv };
  let now = stamp;
  const city = createCityRidePreview({ env: runtime, now: () => now });
  const cookie = city.issueCookie(date, publicWalks);
  for (const flag of ['TRANSIT_SF_GETTING_HOME_ENABLED', 'TRANSIT_GETTING_HOME_ENABLED', 'TRANSIT_TEST_PREVIEW_ENABLED']) {
    runtime[flag] = 'false';
    assert.equal(city.issueCookie(date, publicWalks), null);
    assert.equal(city.verifyCookie(cookie), null);
    runtime[flag] = 'true';
  }
  assert.equal(city.issueCookie('2026-11-31', publicWalks), null);
  assert.equal(city.issueCookie('2026-12-08', publicWalks), null);
  assert.equal(city.issueCookie(date, []), null);
  assert.equal(city.issueCookie(date, [publicWalks[0], publicWalks[0]]), null);
  assert.equal(city.issueCookie(date, [{ ...publicWalks[0], walkSeconds: 601 }]), null);
  assert.equal(city.issueCookie(date, [{ ...publicWalks[0], lat: 40.7, lon: -74 }]), null);
  assert.equal(city.verifyCookie('a'.repeat(3001)), null);
  const many = Array.from({ length: 16 }, (_, i) => ({ ...publicWalks[0], stopId: `SF:${18000 + i}`, walkSeconds: 100 + i }));
  assert.deepEqual(city.verifyCookie(city.issueCookie(date, [...many].reverse())).sfWalks, many.slice(0, 12));
  const long = many.slice(0, 12).map((walk, i) => ({ ...walk, stopId: `${'é'.repeat(96)}${i}`, stationId: 'é'.repeat(100) }));
  const bounded = city.issueCookie(date, long);
  assert.ok(bounded.length <= 3000);
  const kept = city.verifyCookie(bounded).sfWalks;
  assert.ok(kept.length < long.length && kept.length > 0);
  assert.deepEqual(kept, long.slice(0, kept.length));
  now = Date.parse('2026-11-28T12:00:00Z');
  assert.equal(city.verifyCookie(cookie), null);
});

test('city preview email has a distinct label and the same scoped Getting Home button', () => {
  const options = { date, env: cityEnv, now: () => stamp };
  const city = buildGettingHomePreviewEmail({ ...options, walks: publicWalks });
  assert.equal(city.subject, 'Test: Getting Home from Haight Street');
  assert.match(city.text, /read-only preview for a sample show at 1725 Haight St, San Francisco/);
  assert.match(city.text, /published 511 schedules, not live vehicle arrivals/);
  assert.match(city.html, />Help me get home<\/a>/);
  assert.doesNotMatch(city.html, /\/from-email|unsubscribe|confirm RSVP/i);
  assert.equal(new URL(city.url).pathname, `${CITY_PREVIEW_PATH}/from-test`);
  assert.equal(new URL(buildGettingHomePreviewEmail(options).url).pathname, `${PREVIEW_PATH}/from-test`);
  assert.equal(buildGettingHomePreviewEmail({ ...options, walks: [] }), null);
});

test('Kilowatt test uses the reminder layout and signed guest planner without inventing an event', () => {
  const options = { date, walks: publicWalks, venue: 'kilowatt', env: cityEnv, now: () => stamp };
  const email = buildGettingHomePreviewEmail(options);
  assert.equal(email.subject, 'Test reminder: Getting home from Kilowatt');
  assert.match(email.html, /See buses and trains from Kilowatt\./);
  assert.match(email.html, />Help me get home<\/a>/);
  assert.match(email.html, /View venue/);
  assert.doesNotMatch(email.html, /sample show|read-only|Add to Calendar|Manage RSVP|\/r\/undefined/i);
  const signer = createCityRidePreview({ env: cityEnv, now: options.now });
  const grant = new URL(email.url).searchParams.get('t');
  const event = signer.verifyLink(grant);
  assert.equal(event.venue_name, 'Kilowatt');
  assert.equal(event.testVenue, 'kilowatt');
  assert.match(event.venue_address, /^3160 16th St/);
  assert.deepEqual(signer.verifyCookie(signer.issueCookie(date, event.sfWalks, event.testVenue)), event);
  assert.equal(signer.verifyCookie(grant), null);
  assert.equal(signer.issueLink(date, publicWalks, 'unrecognized-venue'), null);
});
