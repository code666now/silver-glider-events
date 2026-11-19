'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://silvergliderevents.com';
process.env.RESEND_API_KEY = 're_no_real_email_requests_in_test';
process.env.RESEND_FROM = 'events@example.test';

const { buildAutomaticFollowerEmail, sendAutomaticFollowerEmail } = require('../src/lib/mailer');

const organizerLabel = 'Night & Day Booking';
const unsubscribeUrl = 'https://silvergliderevents.com/unsubscribe?token=host-scoped-signed-token';
const event = Object.freeze({
  id: 42, organizer_id: 7, status: 'published', visibility: 'public',
  title: 'First <Night> & Friends', slug: 'never-use-raw-slug',
  event_date: '2030-11-14', start_time: '20:00:00',
  venue_name: 'The Main Room', venue_address: '123 Private Street',
  venue_city: 'Oakland', venue_state: 'CA',
  cover_image_url: 'https://res.cloudinary.com/demo/image/upload/main.jpg',
  guest_name: 'Never Display This Guest', guest_email: 'guest@example.test',
  manage_token: 'never-render-attendee-access'
});

function build(events = [event], overrides = {}) {
  return buildAutomaticFollowerEmail({ events, organizerLabel, unsubscribeUrl, ...overrides });
}

test('a single automatic update reuses the artwork-led announcement with a public-only link and no private details', () => {
  const payload = build([event], { replyTo: 'night@host.example' });
  assert.ok(Object.isFrozen(payload));
  assert.ok(Object.isFrozen(payload.headers));
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
  assert.equal(Object.hasOwn(payload, 'to'), false);
  assert.equal(payload.from, '"Night & Day Booking via Silver Glider" <events@example.test>');
  assert.equal(payload.subject, 'Night & Day Booking just announced: First <Night> & Friends');
  assert.equal(payload.replyTo, 'night@host.example');
  assert.deepEqual(payload.headers, {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
  });
  assert.match(payload.html, /class="sg-event-artwork"/);
  assert.match(payload.html, /First &lt;Night&gt; &amp; Friends/);
  assert.match(payload.html, /href="https:\/\/silvergliderevents\.com\/s\/e\/42"/);
  assert.match(payload.text, /Thursday, November 14, 2030 · 8:00 PM\nThe Main Room\nView & RSVP: .*\/s\/e\/42/);
  for (const content of [payload.html, payload.text]) {
    assert.match(content, /490 Post Street, Suite 500/);
    assert.match(content, /\/email-settings\/host\?token=host-scoped-signed-token/);
    assert.match(content, /Privacy Policy/);
    assert.doesNotMatch(content, /Guest|guest@example|never-render|never-use-raw-slug|123 Private Street|maps\.google\.com|Replies are not monitored/i);
  }
});

test('a stable digest describes distinct events once, escapes HTML, and never expands street-address fallbacks', () => {
  const extraEvent = {
    ...event, id: '43', title: 'Second </h2>\r\nNight', event_date: '2030-11-15', start_time: '18:30',
    venue_name: '123 Private Street', venue_address: '123 Private Street, Oakland, CA'
  };
  const hiddenVenue = {
    ...event, id: 44, title: 'Third Night', venue_name: 'The Hidden Warehouse', hide_address_until_rsvp: true
  };
  const events = [event, extraEvent, hiddenVenue];
  const digest = build(events);
  assert.deepEqual(build(JSON.parse(JSON.stringify(events))), digest);
  assert.equal(digest.subject, 'New events from Night & Day Booking');
  assert.equal(Object.hasOwn(digest, 'replyTo'), false);
  assert.match(digest.html, /Second &lt;\/h2&gt; Night/);
  assert.match(digest.text, /Friday, November 15, 2030 · 6:30 PM\nOakland, CA/);
  assert.match(digest.html, /Replies are not monitored/);
  for (const content of [digest.html, digest.text]) {
    for (const id of [42, 43, 44]) assert.equal((content.match(new RegExp(`/s/e/${id}\\b`, 'g')) || []).length, 1);
    assert.doesNotMatch(content, /The Hidden Warehouse|123 Private Street|never-use-raw-slug|guest@example/);
  }
});

test('the automatic renderer rejects unsafe event scopes, duplicate events, and non-host unsubscribe URLs', () => {
  for (const changes of [{ visibility: 'private' }, { status: 'draft' }, { status: 'hidden' },
    { status: 'cancelled' }, { secret_show_enabled: true }, { id: '../../e/private' }, { id: '042' }]) {
    assert.throws(() => build([{ ...event, ...changes }]), /published public event/);
  }
  assert.throws(() => build([event, { ...event, id: 43, organizer_id: 8 }]), /from one host/);
  assert.throws(() => build([event, { ...event, id: '42' }]), /distinct events/);
  assert.throws(() => build([]), /at least one event/);
  for (const unsubscribeUrl of ['https://elsewhere.example/unsubscribe?token=anything',
    'https://silvergliderevents.com/email-settings/host?token=anything',
    'https://silvergliderevents.com/unsubscribe?token=secret&email=guest@example.test',
    'https://silvergliderevents.com/unsubscribe?token=one&token=two', 'javascript:alert(1)']) {
    assert.throws(() => build([event], { unsubscribeUrl }), /host unsubscribe URL/);
  }
});

test('the Resend request reuses the exact acceptance key and frozen render, without considering an empty acknowledgement success', async t => {
  const requests = [];
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return Response.json(requests.length <= 2 ? { id: 'accepted-id' } : {});
  });
  const payload = JSON.parse(JSON.stringify(build()));
  const message = { to: 'recipient@example.test', payload, idempotencyKey: 'sge-auto-follower-v1:42:1' };
  await assert.rejects(sendAutomaticFollowerEmail({ ...message, idempotencyKey: '' }), /idempotency key/);
  await assert.rejects(sendAutomaticFollowerEmail({ ...message, payload: { ...payload, headers: {} } }), /frozen payload/);
  assert.equal(fetch.mock.callCount(), 0);

  assert.deepEqual(await sendAutomaticFollowerEmail(message), { id: 'accepted-id' });
  assert.deepEqual(await sendAutomaticFollowerEmail(message), { id: 'accepted-id' });
  await assert.rejects(sendAutomaticFollowerEmail(message), /provider acceptance not confirmed/);
  assert.equal(fetch.mock.callCount(), 3);
  for (const { url, options } of requests) {
    assert.match(url, /\/emails$/);
    assert.equal(options.method, 'POST');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.get('Idempotency-Key'), message.idempotencyKey);
    const outgoing = JSON.parse(options.body);
    assert.deepEqual(outgoing, { ...payload, to: message.to });
  }
});
