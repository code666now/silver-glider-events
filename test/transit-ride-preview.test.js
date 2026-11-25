'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRidePreview, PREVIEW_PATH } = require('../src/lib/transit/ride-preview');
const { gettingHomeEligible } = require('../src/lib/transit/getting-home');
const { buildGettingHomePreviewEmail } = require('../src/lib/mailer');

const date = '2026-11-27';
const stamp = Date.parse('2026-11-25T00:00:00Z');
const env = {
  APP_URL: 'https://silvergliderevents.com', SESSION_SECRET: 'test-preview-signing-key',
  TRANSIT_GETTING_HOME_ENABLED: 'true', TRANSIT_TEST_PREVIEW_ENABLED: 'true',
  TRANSIT_DISTRIBUTION_ENABLED: 'false', TRANSIT_RIDE_REMINDERS_ENABLED: 'false'
};

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
