const test = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const { version: appVersion } = require('../../package.json');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/sge_test';
if (!/(?:^|\/)sge_test(?:\?|$)/.test(TEST_DATABASE_URL)) {
  throw new Error('Integration tests require a dedicated sge_test database');
}

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.SESSION_SECRET = 'silver-glider-integration-test-secret';
process.env.APP_URL = 'http://127.0.0.1';
process.env.NODE_ENV = 'development';
process.env.REMINDERS_ENABLED = 'false';
process.env.COMMERCE_ENABLED = 'false';
delete process.env.COMMERCE_API_BASE_URL;
delete process.env.RESEND_API_KEY;

const pool = require('../../src/config/db');
const migrate = require('../../src/db/migrate');
const { app } = require('../../src/index');
const { commerceClient } = require('../../src/lib/commerce-client');
const { hashCode } = require('../../src/lib/secret-show');
const { attendeeAvatar } = require('../../src/lib/private-events');
const { signSession } = require('../../src/lib/session');
const sms = require('../../src/lib/sms');
const paypal = require('../../src/lib/paypal');
const stripeSms = require('../../src/lib/stripe-sms');
const { runAutomaticReminderPass } = require('../../src/jobs/sms-notifications');

let server;
let baseUrl;
let organizerId;

async function resetDatabase() {
  await pool.query('TRUNCATE stripe_sms_webhook_events, paypal_webhook_events, organizers RESTART IDENTITY CASCADE');
  organizerId = (await pool.query(
    `INSERT INTO organizers (email, name, org_name, public_slug)
     VALUES ('host@example.test', 'Test Host', 'Test Host', 'test-host')
     RETURNING id`
  )).rows[0].id;
}

async function createEvent(overrides = {}) {
  const event = {
    slug: 'standard-night',
    title: 'Standard Night',
    description: 'A production-shaped integration test event.',
    cover_image_url: 'https://images.example.test/cover.jpg',
    event_date: '2030-08-10',
    start_time: '19:30',
    venue_name: 'Test Hall',
    venue_address: '1 Test Way',
    capacity: 20,
    visibility: 'public',
    admission_type: 'free_rsvp',
    status: 'published',
    background_theme: 'midnight',
    presentation_mode: 'standard',
    flyer_image_url: null,
    show_guest_list: false,
    allow_guests: false,
    comments_enabled: false,
    secret_show_enabled: false,
    secret_show_version: 0,
    ...overrides
  };
  const columns = Object.keys(event);
  const values = Object.values(event);
  const placeholders = values.map((_, index) => `$${index + 2}`);
  const { rows } = await pool.query(
    `INSERT INTO events (organizer_id, ${columns.join(', ')})
     VALUES ($1, ${placeholders.join(', ')}) RETURNING *`,
    [organizerId, ...values]
  );
  return rows[0];
}

async function createRsvp(eventId, overrides = {}) {
  const rsvp = {
    first_name: 'Guest',
    last_name: 'Person',
    email: `guest-${Date.now()}-${Math.random()}@example.test`,
    wants_reminders: true,
    organizer_optin: false,
    status: 'confirmed',
    manage_token: `token-${Date.now()}-${Math.random()}`,
    guest_first_name: null,
    guest_last_name: null,
    guest_email: null,
    ...overrides
  };
  const columns = Object.keys(rsvp);
  const values = Object.values(rsvp);
  const placeholders = values.map((_, index) => `$${index + 2}`);
  return (await pool.query(
    `INSERT INTO rsvps (event_id, ${columns.join(', ')})
     VALUES ($1, ${placeholders.join(', ')}) RETURNING *`,
    [eventId, ...values]
  )).rows[0];
}

async function waitForConfirmation(email) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { rows } = await pool.query(
      `SELECT status FROM message_log
        WHERE recipient=$1 AND message_type='rsvp_confirmation'
        ORDER BY id DESC LIMIT 1`,
      [email]
    );
    if (rows[0]?.status === 'sent') return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`confirmation dispatch did not finish for ${email}`);
}

async function waitForSmsBatch(batchId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const { rows } = await pool.query(
      'SELECT status FROM sms_notification_batches WHERE id=$1', [batchId]
    );
    if (['sent', 'failed'].includes(rows[0]?.status)) return rows[0].status;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`SMS batch ${batchId} did not finish`);
}

test.before(async () => {
  await migrate();
  await resetDatabase();
  server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(resetDatabase);

test.after(async () => {
  if (server) await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  await pool.end();
});

test('serves each protected settings destination from the responsive settings shell', async () => {
  const cookie = `sge_session=${signSession(organizerId)}`;
  for (const pathname of ['/settings', '/settings/account', '/settings/messaging', '/settings/host-page']) {
    const signedOut = await fetch(`${baseUrl}${pathname}`, { redirect: 'manual' });
    assert.equal(signedOut.status, 302);
    assert.equal(signedOut.headers.get('location'), '/login');

    const signedIn = await fetch(`${baseUrl}${pathname}`, { headers: { cookie } });
    assert.equal(signedIn.status, 200);
    const html = await signedIn.text();
    assert.match(html, /data-settings-shell/);
    assert.match(html, /href="\/settings\/account"/);
    assert.match(html, /href="\/settings\/messaging"/);
    assert.match(html, /href="\/settings\/host-page"/);
  }
});

test('creates an event only for an authenticated organizer and publishes its page', async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).version, appVersion);

  const sessionCookie = `sge_session=${signSession(organizerId)}`;
  const dashboard = await fetch(`${baseUrl}/dashboard`, {
    headers: { cookie: sessionCookie }
  });
  assert.equal(dashboard.status, 200);
  const dashboardHtml = await dashboard.text();
  assert.match(dashboardHtml, /href="\/events\/new"[^>]*>Create Event<\/a>/);
  assert.match(dashboardHtml, /class="dashboard-skeleton"/);

  const createPage = await fetch(`${baseUrl}/events/new`, {
    headers: { cookie: sessionCookie }
  });
  assert.equal(createPage.status, 200);
  assert.match(await createPage.text(), /<title>Create Event/);

  const body = {
    title: 'Created Through HTTP',
    event_date: '2030-09-12',
    start_time: '20:00',
    venue_name: 'Integration Hall',
    visibility: 'public',
    background_theme: 'liquid-stardust',
    presentation_mode: 'standard',
    show_guest_list: true,
    allow_guests: true,
    comments_enabled: true
  };
  const signedOut = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert.equal(signedOut.status, 401);

  const created = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: sessionCookie
    },
    body: JSON.stringify(body)
  });
  assert.equal(created.status, 201);
  const payload = await created.json();
  assert.equal(payload.event.title, body.title);
  assert.equal(payload.event.organizer_id, organizerId);
  assert.equal(payload.event.show_guest_list, true);
  assert.equal(payload.event.allow_guests, true);
  assert.equal(payload.event.comments_enabled, true);
  assert.equal(payload.event.background_theme, 'liquid-stardust');

  const publicPage = await fetch(`${baseUrl}/e/${payload.event.slug}`);
  assert.equal(publicPage.status, 200);
  const publicHtml = await publicPage.text();
  assert.match(publicHtml, /Created Through HTTP/);
  assert.match(publicHtml, /class="public-guest-list"/);
  assert.match(publicHtml, /name="party_size"/);
  assert.match(publicHtml, /class="event-wall"/);
  assert.match(publicHtml, /class="event-bg bg-theme fx-liquid-stardust"/);
  assert.match(publicHtml, /sg-events\/effects\/liquid-stardust/);

  const rsvp = await fetch(`${baseUrl}/api/public/events/${payload.event.slug}/rsvp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      full_name: 'Public Attendee',
      email: 'public-attendee@example.test',
      bringing_guest: true,
      guest_name: 'Public Guest'
    })
  });
  assert.equal(rsvp.status, 201);
  const attendeeCookie = rsvp.headers.get('set-cookie').split(';')[0];

  const comment = await fetch(`${baseUrl}/api/public/events/${payload.event.slug}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: attendeeCookie },
    body: JSON.stringify({ message: 'See you there!' })
  });
  assert.equal(comment.status, 201);

  const updatedPage = await fetch(`${baseUrl}/e/${payload.event.slug}`);
  const updatedHtml = await updatedPage.text();
  assert.match(updatedHtml, /class="guest-avatar"/);
  assert.match(updatedHtml, /<span>Public<\/span><\/li>/);
  await waitForConfirmation('public-attendee@example.test');
});

test('RSVP SMS consent requires an enabled reminder and valid phone, then powers the host eligibility count', async () => {
  const event = await createEvent({
    slug: 'sms-consent-night',
    title: 'SMS Consent Night',
    sms_reminder_enabled: true
  });
  const sessionCookie = `sge_session=${signSession(organizerId)}`;

  const publicPage = await fetch(`${baseUrl}/e/${event.slug}`);
  const publicHtml = await publicPage.text();
  assert.match(publicHtml, /Text me a reminder the day before this event from Test Host through Silver Glider\./);
  assert.match(publicHtml, /Keep me posted about future events and updates from Test Host\./);
  assert.match(publicHtml, /Consent isn’t required to RSVP\./);
  assert.doesNotMatch(publicHtml, /id="sms_optin"[^>]*checked/);
  assert.doesNotMatch(publicHtml, /id="organizer_optin"[^>]*checked/);

  const missingPhone = await fetch(`${baseUrl}/api/public/events/${event.slug}/rsvp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      full_name: 'Missing Phone',
      email: 'missing-phone@example.test',
      sms_optin: true
    })
  });
  assert.equal(missingPhone.status, 400);
  assert.deepEqual(await missingPhone.json(), { error: 'Enter a valid phone number to receive text messages' });

  const optedIn = await fetch(`${baseUrl}/api/public/events/${event.slug}/rsvp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      full_name: 'Text Guest',
      email: 'text-guest@example.test',
      phone: '(415) 555-1234',
      sms_optin: true
    })
  });
  assert.equal(optedIn.status, 201);

  const phoneOnly = await fetch(`${baseUrl}/api/public/events/${event.slug}/rsvp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      full_name: 'Phone Only',
      email: 'phone-only@example.test',
      phone: '415-555-5678',
      sms_optin: false
    })
  });
  assert.equal(phoneOnly.status, 201);

  const { rows } = await pool.query(
    `SELECT email, phone, sms_optin, sms_consent_at, sms_consent_source,
            sms_consent_version, sms_consent_text, sms_opted_out_at
       FROM rsvps WHERE event_id=$1 ORDER BY email`,
    [event.id]
  );
  assert.equal(rows[0].email, 'phone-only@example.test');
  assert.equal(rows[0].phone, '415-555-5678');
  assert.equal(rows[0].sms_optin, false);
  assert.equal(rows[0].sms_consent_at, null);
  assert.equal(rows[1].email, 'text-guest@example.test');
  assert.equal(rows[1].phone, '+14155551234');
  assert.equal(rows[1].sms_optin, true);
  assert.ok(rows[1].sms_consent_at instanceof Date);
  assert.equal(rows[1].sms_consent_source, 'event_rsvp');
  assert.equal(rows[1].sms_consent_version, 'rsvp_event_reminder_v1');
  assert.match(rows[1].sms_consent_text, /Test Host through Silver Glider/);
  assert.equal(rows[1].sms_opted_out_at, null);

  const manageEvent = await fetch(`${baseUrl}/api/events/${event.id}`, {
    headers: { cookie: sessionCookie }
  });
  assert.equal(manageEvent.status, 200);
  assert.equal((await manageEvent.json()).event.sms_eligible_count, 1);
  await Promise.all([
    waitForConfirmation('text-guest@example.test'),
    waitForConfirmation('phone-only@example.test')
  ]);
});

test('tomorrow SMS requires purchased host credits, debits once, deduplicates phones, and records delivery', async () => {
  const tomorrow = (await pool.query(
    "SELECT ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date + 1)::text AS date"
  )).rows[0].date;
  const event = await createEvent({
    slug: 'paid-tomorrow-sms',
    title: 'Tomorrow Night',
    event_date: tomorrow,
    timezone: 'America/Los_Angeles',
    sms_reminder_enabled: true
  });
  const cookie = `sge_session=${signSession(organizerId)}`;
  const consent = {
    phone: '+14155551234',
    sms_optin: true,
    sms_consent_at: new Date(),
    sms_consent_source: 'event_rsvp',
    sms_consent_version: 'rsvp_event_reminder_v1',
    sms_consent_text: 'One reminder for this event.'
  };
  await createRsvp(event.id, { email: 'sms-one@example.test', ...consent });
  const recipient = await createRsvp(event.id, {
    email: 'sms-duplicate@example.test',
    first_name: 'Duplicate',
    ...consent
  });
  await createRsvp(event.id, {
    email: 'sms-no-consent@example.test',
    phone: '+14155559876',
    sms_optin: false
  });

  const noCredits = await fetch(`${baseUrl}/api/events/${event.id}/sms/tomorrow-preview`, {
    headers: { cookie }
  });
  assert.equal(noCredits.status, 200);
  const blockedPreview = await noCredits.json();
  assert.equal(blockedPreview.recipientCount, 1, 'the same phone is charged only once');
  assert.equal(blockedPreview.canSend, false);
  assert.match(blockedPreview.reason, /Add .* more texting credit/);

  const blockedSend = await fetch(`${baseUrl}/api/events/${event.id}/sms/tomorrow`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ confirm: 'SEND_TOMORROW_SMS', fingerprint: blockedPreview.fingerprint })
  });
  assert.equal(blockedSend.status, 402);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM sms_notification_batches')).rows[0].count, 0);

  await pool.query('UPDATE organizers SET sms_credits=5 WHERE id=$1', [organizerId]);
  const readyPreview = await (await fetch(
    `${baseUrl}/api/events/${event.id}/sms/tomorrow-preview`, { headers: { cookie } }
  )).json();
  assert.equal(readyPreview.canSend, true);
  assert.equal(readyPreview.creditCost, readyPreview.segmentCount);
  assert.match(readyPreview.messageBody, /^Test Host: Tomorrow Night is tomorrow at Test Hall\./);
  assert.match(readyPreview.messageBody, /Reply STOP to opt out\.$/);
  assert.deepEqual(readyPreview.recipients.map(item => item.phone), ['•••• 1234']);

  const stale = await fetch(`${baseUrl}/api/events/${event.id}/sms/tomorrow`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ confirm: 'SEND_TOMORROW_SMS', fingerprint: '0'.repeat(64) })
  });
  assert.equal(stale.status, 409);
  assert.equal((await pool.query('SELECT sms_credits FROM organizers WHERE id=$1', [organizerId])).rows[0].sms_credits, 5);

  const originalSendSms = sms.sendSms;
  const sends = [];
  sms.sendSms = async payload => {
    sends.push(payload);
    const sid = `SM${'d'.repeat(32)}`;
    const token = payload.statusCallback.split('/').pop();
    const earlyCallback = await fetch(`${baseUrl}/api/webhooks/twilio/status/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ MessageSid: sid, MessageStatus: 'delivered' })
    });
    assert.equal(earlyCallback.status, 204, 'a callback can arrive before Twilio returns the create response');
    return { sid, status: 'accepted', recipient: payload.to };
  };
  try {
    const queued = await fetch(`${baseUrl}/api/events/${event.id}/sms/tomorrow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ confirm: 'SEND_TOMORROW_SMS', fingerprint: readyPreview.fingerprint })
    });
    assert.equal(queued.status, 202);
    const payload = await queued.json();
    assert.equal(payload.queued, 1);
    assert.equal(payload.balance, 5 - readyPreview.creditCost);
    await waitForSmsBatch(payload.batch.id);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].to, '+14155551234');
    assert.match(sends[0].body, /^Test Host: Tomorrow Night is tomorrow at Test Hall\./);
    assert.match(sends[0].body, /\/t\/[0-9a-f]{32} Reply STOP to opt out\.$/);
    assert.notEqual(sends[0].body, readyPreview.messageBody, 'each recipient receives a private link');
    assert.match(sends[0].statusCallback, /\/api\/webhooks\/twilio\/status\/[0-9a-f-]{36}$/);

    const ledger = (await pool.query(
      `SELECT kind,credits_delta,balance_after,external_key FROM sms_credit_transactions
        WHERE organizer_id=$1 ORDER BY id`, [organizerId]
    )).rows;
    assert.deepEqual(ledger, [{
      kind: 'send',
      credits_delta: -readyPreview.creditCost,
      balance_after: 5 - readyPreview.creditCost,
      external_key: `sms:batch:${payload.batch.id}:send`
    }]);
    const delivery = (await pool.query(
      'SELECT * FROM sms_notification_recipients WHERE batch_id=$1', [payload.batch.id]
    )).rows[0];
    assert.equal(delivery.rsvp_id, recipient.id);
    assert.equal(delivery.message_body, sends[0].body);
    assert.match(delivery.access_token, /^[0-9a-f]{32}$/);
    assert.equal(delivery.provider_message_sid, `SM${'d'.repeat(32)}`);
    assert.equal(delivery.status, 'delivered', 'the create response must not overwrite a newer callback');

    const callback = await fetch(`${baseUrl}/api/webhooks/twilio/status/${delivery.status_token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ MessageSid: delivery.provider_message_sid, MessageStatus: 'delivered' })
    });
    assert.equal(callback.status, 204);
    const delivered = (await pool.query(
      'SELECT status FROM sms_notification_recipients WHERE id=$1', [delivery.id]
    )).rows[0];
    assert.equal(delivered.status, 'delivered');

    const oneTap = await fetch(`${baseUrl}/t/${delivery.access_token}`, { redirect: 'manual' });
    assert.equal(oneTap.status, 303);
    assert.equal(oneTap.headers.get('location'), `/e/${event.slug}`);
    assert.match(oneTap.headers.get('set-cookie') || '', new RegExp(`sge_attendee_${event.id}=`));
    assert.ok((await pool.query(
      'SELECT sms_phone_verified_at FROM rsvps WHERE id=$1', [recipient.id]
    )).rows[0].sms_phone_verified_at instanceof Date);

    const duplicate = await fetch(`${baseUrl}/api/events/${event.id}/sms/tomorrow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ confirm: 'SEND_TOMORROW_SMS', fingerprint: readyPreview.fingerprint })
    });
    assert.equal(duplicate.status, 409);

    const stop = await fetch(`${baseUrl}/api/webhooks/twilio/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: '+14155551234', Body: 'STOP', OptOutType: 'STOP' })
    });
    assert.equal(stop.status, 200);
    const optouts = (await pool.query(
      'SELECT sms_optin,sms_opted_out_at FROM rsvps WHERE phone=$1', ['+14155551234']
    )).rows;
    assert.equal(optouts.every(row => row.sms_optin === false && row.sms_opted_out_at instanceof Date), true);
  } finally {
    sms.sendSms = originalSendSms;
  }
});

test('enabled day-before reminders send automatically once when the full balance is available', async () => {
  const tomorrow = (await pool.query(
    "SELECT ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date + 1)::text AS date"
  )).rows[0].date;
  const event = await createEvent({
    slug: 'automatic-tomorrow-sms',
    title: 'Automatic Tomorrow Night',
    event_date: tomorrow,
    timezone: 'America/Los_Angeles',
    sms_reminder_enabled: true
  });
  await pool.query('UPDATE organizers SET sms_credits=5 WHERE id=$1', [organizerId]);
  await createRsvp(event.id, {
    email: 'automatic-sms@example.test',
    phone: '+14155550123',
    sms_optin: true,
    sms_consent_at: new Date(),
    sms_consent_source: 'event_rsvp',
    sms_consent_version: 'rsvp_event_reminder_v1',
    sms_consent_text: 'One reminder for this event.'
  });

  const originalSendSms = sms.sendSms;
  const sends = [];
  sms.sendSms = async payload => {
    sends.push(payload);
    return { sid: `SM${'e'.repeat(32)}`, status: 'accepted', recipient: payload.to };
  };
  try {
    await runAutomaticReminderPass({ minimumLocalHour: 0 });
    const batch = (await pool.query(
      "SELECT * FROM sms_notification_batches WHERE event_id=$1 AND kind='event_tomorrow'",
      [event.id]
    )).rows[0];
    assert.ok(batch);
    await waitForSmsBatch(batch.id);
    assert.equal(sends.length, 1);
    assert.match(sends[0].body, /\/t\/[0-9a-f]{32}/);

    await runAutomaticReminderPass({ minimumLocalHour: 0 });
    assert.equal((await pool.query(
      "SELECT COUNT(*)::int AS count FROM sms_notification_batches WHERE event_id=$1 AND kind='event_tomorrow'",
      [event.id]
    )).rows[0].count, 1);
    assert.equal(sends.length, 1);
  } finally {
    sms.sendSms = originalSendSms;
  }
});

test('live event editing is visible only to the owner and saves through the protected event API', async () => {
  const event = await createEvent({ slug: 'owner-edit-night', title: 'Owner Edit Night' });
  const sessionCookie = `sge_session=${signSession(organizerId)}`;

  const visitorPage = await fetch(`${baseUrl}/e/${event.slug}`);
  const visitorHtml = await visitorPage.text();
  assert.equal(visitorPage.status, 200);
  assert.doesNotMatch(visitorHtml, /id="owner-edit-trigger"/);
  assert.doesNotMatch(visitorHtml, /id="owner-event-data"/);
  assert.doesNotMatch(visitorHtml, /data-owner-preview-section/);

  const { rows: otherOrganizers } = await pool.query(
    "INSERT INTO organizers (email, name) VALUES ('other-host@example.test','Other Host') RETURNING id"
  );
  const otherPage = await fetch(`${baseUrl}/e/${event.slug}`, {
    headers: { cookie: `sge_session=${signSession(otherOrganizers[0].id)}` }
  });
  const otherHtml = await otherPage.text();
  assert.doesNotMatch(otherHtml, /id="owner-edit-trigger"/);
  assert.doesNotMatch(otherHtml, /data-owner-preview-section/);

  const ownerPage = await fetch(`${baseUrl}/e/${event.slug}`, { headers: { cookie: sessionCookie } });
  const ownerHtml = await ownerPage.text();
  assert.equal(ownerPage.status, 200);
  assert.match(ownerHtml, /id="owner-edit-trigger"/);
  assert.match(ownerHtml, /id="owner-editor"/);
  assert.match(ownerHtml, /id="owner-event-data"/);
  assert.match(ownerHtml, new RegExp(`"id":${event.id}`));
  assert.match(ownerHtml, /data-owner-preview-section="guest-list" hidden/);
  assert.match(ownerHtml, /data-owner-preview-section="guest-fields" hidden/);
  assert.match(ownerHtml, /data-owner-preview-section="comments" hidden/);

  const visitorComments = await fetch(`${baseUrl}/api/public/events/${event.slug}/comments`);
  assert.equal(visitorComments.status, 404);
  const ownerComments = await fetch(`${baseUrl}/api/public/events/${event.slug}/comments`, {
    headers: { cookie: sessionCookie }
  });
  assert.equal(ownerComments.status, 200);
  assert.equal((await ownerComments.json()).canComment, false);

  const signedOutUpdate = await fetch(`${baseUrl}/api/events/${event.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Unauthorized change' })
  });
  assert.equal(signedOutUpdate.status, 401);

  const update = await fetch(`${baseUrl}/api/events/${event.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: sessionCookie },
    body: JSON.stringify({
      title: 'Edited On The Event Page',
      background_theme: 'aurora',
      venue_name: 'Selected Venue',
      venue_address: '123 Test Street, San Francisco, CA',
      venue_city: 'San Francisco',
      venue_state: 'CA',
      venue_latitude: 37.76,
      venue_longitude: -122.42,
      google_place_id: 'test-place-id',
      visibility: 'private',
      show_guest_list: true,
      allow_guests: true,
      comments_enabled: true
    })
  });
  assert.equal(update.status, 200);
  const updated = (await update.json()).event;
  assert.equal(updated.title, 'Edited On The Event Page');
  assert.equal(updated.background_theme, 'aurora');
  assert.equal(updated.venue_name, 'Selected Venue');
  assert.equal(updated.venue_city, 'San Francisco');
  assert.equal(updated.venue_state, 'CA');
  assert.equal(updated.google_place_id, 'test-place-id');
  assert.equal(updated.visibility, 'private');
  assert.equal(updated.show_guest_list, true);

  const refreshed = await fetch(`${baseUrl}/e/${event.slug}`, { headers: { cookie: sessionCookie } });
  const refreshedHtml = await refreshed.text();
  assert.match(refreshedHtml, /Edited On The Event Page/);
  assert.match(refreshedHtml, /class="event-bg bg-theme bg-aurora"/);
  assert.match(refreshedHtml, /class="public-guest-list"/);

  const adaptiveUpdate = await fetch(`${baseUrl}/api/events/${event.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: sessionCookie },
    body: JSON.stringify({ background_theme: 'adaptive' })
  });
  assert.equal(adaptiveUpdate.status, 200);
  assert.equal((await adaptiveUpdate.json()).event.background_theme, 'adaptive');

  const adaptivePage = await fetch(`${baseUrl}/e/${event.slug}`, { headers: { cookie: sessionCookie } });
  const adaptiveHtml = await adaptivePage.text();
  assert.match(adaptiveHtml, /class="event-bg bg-theme bg-adaptive"/);
  assert.match(adaptiveHtml, /"adaptiveBackground":true/);

  const colorStaticUpdate = await fetch(`${baseUrl}/api/events/${event.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: sessionCookie },
    body: JSON.stringify({ background_theme: 'color-static' })
  });
  assert.equal(colorStaticUpdate.status, 200);
  assert.equal((await colorStaticUpdate.json()).event.background_theme, 'color-static');

  const colorStaticPage = await fetch(`${baseUrl}/e/${event.slug}`, { headers: { cookie: sessionCookie } });
  const colorStaticHtml = await colorStaticPage.text();
  assert.match(colorStaticHtml, /class="event-bg bg-theme fx-color-static"/);
  assert.match(colorStaticHtml, /sg-events\/effects\/color-static/);
});

test('important edits and cancellations can notify every confirmed RSVP exactly once', async () => {
  const event = await createEvent({ slug: 'important-update-night' });
  const sessionCookie = `sge_session=${signSession(organizerId)}`;
  const reminderOptOut = await createRsvp(event.id, {
    email: 'critical-optout@example.test',
    wants_reminders: false,
    guest_first_name: 'Plus',
    guest_last_name: 'One',
    guest_email: 'named-guest@example.test'
  });
  const reminderOptIn = await createRsvp(event.id, { email: 'critical-optin@example.test' });
  await createRsvp(event.id, { email: 'cancelled-rsvp@example.test', status: 'cancelled' });

  const ordinaryEdit = await fetch(`${baseUrl}/api/events/${event.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: sessionCookie },
    body: JSON.stringify({ description: 'This should not email anyone.', notify_attendees: true })
  });
  assert.equal(ordinaryEdit.status, 200);
  assert.deepEqual((await ordinaryEdit.json()).importantChanges, []);

  const silentImportantEdit = await fetch(`${baseUrl}/api/events/${event.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: sessionCookie },
    body: JSON.stringify({ event_date: '2030-08-11', start_time: '20:15', notify_attendees: false })
  });
  assert.equal(silentImportantEdit.status, 200);
  const silentPayload = await silentImportantEdit.json();
  assert.equal(silentPayload.notification, null);
  assert.equal(silentPayload.importantChanges.length, 2);

  const notifiedEdit = await fetch(`${baseUrl}/api/events/${event.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: sessionCookie },
    body: JSON.stringify({
      event_date: '2030-08-12',
      venue_name: 'Updated Hall',
      venue_address: '99 Updated Way',
      notify_attendees: true
    })
  });
  assert.equal(notifiedEdit.status, 200);
  const updatePayload = await notifiedEdit.json();
  assert.equal(updatePayload.notification.queued, 2);
  assert.deepEqual(updatePayload.importantChanges.map(change => change.field), ['date', 'location']);

  const { processEventNotificationBatch } = require('../../src/jobs/event-notifications');
  await processEventNotificationBatch(updatePayload.notification.batchId);
  const updateLogs = (await pool.query(
    `SELECT rsvp_id, recipient FROM message_log
      WHERE notification_batch_id=$1 ORDER BY recipient`,
    [updatePayload.notification.batchId]
  )).rows;
  assert.deepEqual(updateLogs.map(row => row.recipient), ['critical-optin@example.test', 'critical-optout@example.test']);
  assert.deepEqual(new Set(updateLogs.map(row => row.rsvp_id)), new Set([reminderOptOut.id, reminderOptIn.id]));
  assert.equal(updateLogs.some(row => row.recipient === 'named-guest@example.test'), false);

  const cancel = await fetch(`${baseUrl}/api/events/${event.id}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: sessionCookie },
    body: JSON.stringify({ notify_attendees: true })
  });
  assert.equal(cancel.status, 200);
  const cancelPayload = await cancel.json();
  assert.equal(cancelPayload.notification.queued, 2);
  await processEventNotificationBatch(cancelPayload.notification.batchId);

  const finalEvent = (await pool.query('SELECT status, calendar_sequence FROM events WHERE id=$1', [event.id])).rows[0];
  assert.equal(finalEvent.status, 'cancelled');
  assert.equal(finalEvent.calendar_sequence, 3);
  const cancellationRecipients = (await pool.query(
    `SELECT recipient FROM message_log WHERE notification_batch_id=$1 ORDER BY recipient`,
    [cancelPayload.notification.batchId]
  )).rows.map(row => row.recipient);
  assert.deepEqual(cancellationRecipients, ['critical-optin@example.test', 'critical-optout@example.test']);
});

test('address-only locations render once and keep Maps and calendar destinations intact', async () => {
  const event = await createEvent({
    slug: 'address-only-night',
    title: 'Address Only Night',
    venue_name: '987 Cedar Lane',
    venue_address: '987 Cedar Lane, Testville, CA 90000'
  });

  const publicPage = await fetch(`${baseUrl}/e/${event.slug}`);
  assert.equal(publicPage.status, 200);
  const html = await publicPage.text();
  assert.match(html, /<strong>987 Cedar Lane, Testville, CA 90000<\/strong>/);
  assert.doesNotMatch(html, /<strong>987 Cedar Lane<\/strong>\s*<span[^>]*>987 Cedar Lane, Testville/);
  assert.match(html, /maps\.google\.com\/\?q=987%20Cedar%20Lane%2C%20Testville%2C%20CA%2090000/);
  assert.doesNotMatch(html, /q=987%20Cedar%20Lane%2C%20987%20Cedar%20Lane/);

  const calendar = await fetch(`${baseUrl}/e/${event.slug}/calendar.ics`);
  assert.equal(calendar.status, 200);
  const ics = await calendar.text();
  assert.match(ics, /LOCATION:987 Cedar Lane\\, Testville\\, CA 90000/);
  assert.doesNotMatch(ics, /LOCATION:987 Cedar Lane\\, 987 Cedar Lane/);
});

test('personal RSVP photos require verified identity or attendee ownership and stay separate from Host Page logos', async () => {
  const event = await createEvent({ slug: 'avatar-night', title: 'Avatar Night', show_guest_list: true });
  const historicalEvent = await createEvent({ slug: 'historical-avatar-night', title: 'Historical Avatar Night', show_guest_list: true });
  const browserOwnedEvent = await createEvent({ slug: 'browser-owned-avatar-night', title: 'Browser-owned Avatar Night', show_guest_list: true });
  const avatarUrl = 'https://res.cloudinary.com/demo/image/upload/v1/sg-events-dev/avatars/attendee.jpg';
  const logoUrl = 'https://res.cloudinary.com/demo/image/upload/v1/sg-events-dev/hosts/attendee-logo.jpg';
  const { rows: accounts } = await pool.query(
    `INSERT INTO organizers (email, name, avatar_url, logo_url)
     VALUES ('avatar@example.test','Avatar Person',$1,$2) RETURNING id`,
    [avatarUrl, logoUrl]
  );
  const accountId = accounts[0].id;
  const accountCookie = `sge_session=${signSession(accountId)}`;

  await pool.query(
    `INSERT INTO rsvps (event_id, first_name, last_name, email, status, manage_token)
     VALUES ($1,'Avatar','Person','avatar@example.test','confirmed','historical-avatar-token')`,
    [historicalEvent.id]
  );

  const signedOutMe = await fetch(`${baseUrl}/api/me`);
  assert.equal(signedOutMe.status, 401);
  const me = await fetch(`${baseUrl}/api/me`, { headers: { cookie: accountCookie } });
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), {
    user: { id: accountId, email: 'avatar@example.test', name: 'Avatar Person', avatarUrl }
  });

  const signedOutLink = await fetch(`${baseUrl}/api/me/link-rsvps`, { method: 'POST' });
  assert.equal(signedOutLink.status, 401);
  const linkHistorical = await fetch(`${baseUrl}/api/me/link-rsvps`, {
    method: 'POST',
    headers: { cookie: accountCookie }
  });
  assert.equal(linkHistorical.status, 200);
  assert.deepEqual(await linkHistorical.json(), { ok: true, linked: 1 });
  const { rows: historicalRsvps } = await pool.query(
    'SELECT account_id FROM rsvps WHERE event_id=$1',
    [historicalEvent.id]
  );
  assert.equal(historicalRsvps[0].account_id, accountId);

  const matchingRsvp = await fetch(`${baseUrl}/api/public/events/${event.slug}/rsvp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: accountCookie },
    body: JSON.stringify({ full_name: 'Avatar Person', email: 'avatar@example.test' })
  });
  assert.equal(matchingRsvp.status, 201);

  const emailOnlyRsvp = await fetch(`${baseUrl}/api/public/events/${event.slug}/rsvp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: accountCookie },
    body: JSON.stringify({ full_name: 'Smiley Guest', email: 'different@example.test' })
  });
  assert.equal(emailOnlyRsvp.status, 201);

  const { rows: rsvps } = await pool.query(
    `SELECT email, account_id FROM rsvps WHERE event_id=$1 ORDER BY email`,
    [event.id]
  );
  assert.deepEqual(rsvps, [
    { email: 'avatar@example.test', account_id: accountId },
    { email: 'different@example.test', account_id: null }
  ]);

  await pool.query(
    `INSERT INTO rsvps (event_id, first_name, last_name, email, status, manage_token)
     VALUES ($1,'Avatar','Alias','alias@example.test','confirmed','browser-owned-avatar-token')`,
    [browserOwnedEvent.id]
  );
  const mismatchedWithoutOwnership = await fetch(`${baseUrl}/api/me/link-rsvps`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: accountCookie },
    body: JSON.stringify({ eventSlug: browserOwnedEvent.slug })
  });
  assert.equal(mismatchedWithoutOwnership.status, 200);
  assert.deepEqual(await mismatchedWithoutOwnership.json(), { ok: true, linked: 0 });

  const ownedCookie = `${accountCookie}; sge_attendee_${browserOwnedEvent.id}=browser-owned-avatar-token`;
  const linkBrowserOwned = await fetch(`${baseUrl}/api/me/link-rsvps`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: ownedCookie },
    body: JSON.stringify({ eventSlug: browserOwnedEvent.slug })
  });
  assert.equal(linkBrowserOwned.status, 200);
  assert.deepEqual(await linkBrowserOwned.json(), { ok: true, linked: 1 });
  const { rows: browserOwnedRsvps } = await pool.query(
    'SELECT account_id FROM rsvps WHERE event_id=$1',
    [browserOwnedEvent.id]
  );
  assert.equal(browserOwnedRsvps[0].account_id, accountId);
  const browserOwnedPage = await fetch(`${baseUrl}/e/${browserOwnedEvent.slug}`);
  assert.match(await browserOwnedPage.text(), new RegExp(avatarUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const page = await fetch(`${baseUrl}/e/${event.slug}`);
  const html = await page.text();
  assert.match(html, new RegExp(avatarUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /class="guest-avatar"/);
  assert.match(html, /Avatar<\/span>/);
  assert.match(html, /Smiley<\/span>/);

  const signedOutRemove = await fetch(`${baseUrl}/api/me/profile`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ avatarUrl: null })
  });
  assert.equal(signedOutRemove.status, 401);

  await pool.query(
    "UPDATE organizers SET org_name='Unpublished Host', public_slug=NULL WHERE id=$1",
    [accountId]
  );
  const rename = await fetch(`${baseUrl}/api/me/profile`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: accountCookie },
    body: JSON.stringify({ name: 'Updated Account Name' })
  });
  assert.equal(rename.status, 200);
  assert.equal((await rename.json()).organizer.name, 'Updated Account Name');
  const { rows: renamedAccounts } = await pool.query(
    'SELECT name, org_name, public_slug FROM organizers WHERE id=$1',
    [accountId]
  );
  assert.deepEqual(renamedAccounts[0], {
    name: 'Updated Account Name',
    org_name: 'Unpublished Host',
    public_slug: null
  });

  const remove = await fetch(`${baseUrl}/api/me/profile`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: accountCookie },
    body: JSON.stringify({ avatarUrl: null })
  });
  assert.equal(remove.status, 200);
  const { rows: accountAfter } = await pool.query(
    'SELECT avatar_url, logo_url FROM organizers WHERE id=$1',
    [accountId]
  );
  assert.deepEqual(accountAfter[0], { avatar_url: null, logo_url: logoUrl });
});

test('serves email-safe adaptive icon PNGs with immutable caching', async () => {
  for (const pathname of [
    '/logo.png',
    '/images/email/calendar.png',
    '/images/email/map.png',
    '/images/email/manage.png',
    '/images/email/music.png'
  ]) {
    const staticAsset = await fetch(`${baseUrl}${pathname}`);
    const staticBytes = Buffer.from(await staticAsset.arrayBuffer());
    assert.equal(staticAsset.status, 200, `${pathname} should be served`);
    assert.equal(staticAsset.headers.get('content-type'), 'image/png');
    assert.deepEqual([...staticBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }

  const response = await fetch(`${baseUrl}/images/email/music/637CDA.png`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.match(response.headers.get('cache-control') || '', /max-age=31536000, immutable/);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const decoded = PNG.sync.read(bytes);
  let recoloredPixels = 0;
  for (let index = 0; index < decoded.data.length; index += 4) {
    if (decoded.data[index] === 99 && decoded.data[index + 1] === 124 && decoded.data[index + 2] === 218 && decoded.data[index + 3] > 0) {
      recoloredPixels += 1;
    }
  }
  assert.ok(recoloredPixels > 100, 'adaptive icon should contain the requested accent color');

  const invalid = await fetch(`${baseUrl}/images/email/music/not-a-color.png`);
  assert.equal(invalid.status, 404);
});

test('serves Standard and Flyer events through their isolated templates', async () => {
  await createEvent({ background_theme: 'last-guest', cover_image_url: null });
  await createEvent({
    slug: 'flyer-night',
    title: 'Flyer Night',
    presentation_mode: 'flyer',
    flyer_image_url: 'https://res.cloudinary.com/dhvavjgnw/image/upload/sg-events/flyers/test.jpg'
  });

  const standard = await fetch(`${baseUrl}/e/standard-night`);
  const standardHtml = await standard.text();
  assert.equal(standard.status, 200);
  assert.doesNotMatch(standardHtml, /<body class="flyer-public-page">/);
  assert.match(standardHtml, /class="layout"/);
  assert.match(standardHtml, /class="event-bg bg-theme fx-last-guest"/);
  assert.match(standardHtml, /sg-events\/effects\/the-last-guest/);

  const flyer = await fetch(`${baseUrl}/e/flyer-night`);
  const flyerHtml = await flyer.text();
  assert.equal(flyer.status, 200);
  assert.match(flyerHtml, /<body class="flyer-public-page">/);
  assert.match(flyerHtml, /Flyer Night flyer/);
  assert.doesNotMatch(flyerHtml, /\{\{[A-Z0-9_]+\}\}/);

  const host = await fetch(`${baseUrl}/h/test-host`);
  const hostHtml = await host.text();
  assert.equal(host.status, 200);
  assert.match(hostHtml, /Standard Night/);
  assert.match(hostHtml, /Flyer Night/);
  assert.match(hostHtml, /sg-events\/effects\/the-last-guest\.jpg/);
  assert.doesNotMatch(hostHtml, /\{\{[A-Z0-9_]+\}\}/);
});

test('Flyer designer credits normalize, render only on Flyer pages, and survive editing and duplication', async () => {
  const organizerCookie = `sge_session=${signSession(organizerId)}`;
  const createdResponse = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: organizerCookie },
    body: JSON.stringify({
      title: 'Designed Flyer Night',
      event_date: '2030-10-04',
      start_time: '20:00',
      venue_name: 'Poster Hall',
      presentation_mode: 'flyer',
      flyer_image_url: 'https://res.cloudinary.com/dhvavjgnw/image/upload/sg-events-dev/flyers/designed-night.jpg',
      flyer_designer_name: 'Poster Lab',
      flyer_designer_instagram_handle: '@Poster.Lab'
    })
  });
  assert.equal(createdResponse.status, 201);
  const createdEvent = (await createdResponse.json()).event;
  assert.equal(createdEvent.flyer_designer_name, 'Poster Lab');
  assert.equal(createdEvent.flyer_designer_instagram_handle, 'poster.lab');

  const flyerHtml = await (await fetch(`${baseUrl}/e/${createdEvent.slug}`)).text();
  assert.match(flyerHtml, /class="flyer-design-credit">Design by <a href="https:\/\/www\.instagram\.com\/poster\.lab\/"[^>]*>@poster\.lab<\/a><\/p>/);
  assert.doesNotMatch(flyerHtml, /Design by Poster Lab/);

  const nameOnlyEvent = await createEvent({
    slug: 'designer-name-only',
    title: 'Name Only Flyer',
    presentation_mode: 'flyer',
    flyer_image_url: 'https://res.cloudinary.com/dhvavjgnw/image/upload/sg-events/flyers/name-only.jpg',
    flyer_designer_name: 'Analog Studio',
    flyer_designer_instagram_handle: null
  });
  const nameOnlyHtml = await (await fetch(`${baseUrl}/e/${nameOnlyEvent.slug}`)).text();
  assert.match(nameOnlyHtml, /class="flyer-design-credit">Design by Analog Studio<\/p>/);

  const standardEvent = await createEvent({
    slug: 'standard-with-hidden-designer',
    flyer_designer_name: 'Hidden Designer',
    flyer_designer_instagram_handle: 'hidden.designer'
  });
  const standardHtml = await (await fetch(`${baseUrl}/e/${standardEvent.slug}`)).text();
  assert.doesNotMatch(standardHtml, /flyer-design-credit|Design by/);

  const invalidUpdate = await fetch(`${baseUrl}/api/events/${createdEvent.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: organizerCookie },
    body: JSON.stringify({ flyer_designer_instagram_handle: 'bad handle' })
  });
  assert.equal(invalidUpdate.status, 400);
  assert.match((await invalidUpdate.json()).error, /Instagram handle/);

  const validUpdate = await fetch(`${baseUrl}/api/events/${createdEvent.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: organizerCookie },
    body: JSON.stringify({
      flyer_designer_name: '  New   Poster Lab  ',
      flyer_designer_instagram_handle: 'New.Artist'
    })
  });
  assert.equal(validUpdate.status, 200);
  const updatedEvent = (await validUpdate.json()).event;
  assert.equal(updatedEvent.flyer_designer_name, 'New Poster Lab');
  assert.equal(updatedEvent.flyer_designer_instagram_handle, 'new.artist');

  const ownerPage = await fetch(`${baseUrl}/e/${createdEvent.slug}`, { headers: { cookie: organizerCookie } });
  const ownerHtml = await ownerPage.text();
  assert.match(ownerHtml, /id="owner-flyer-credit-fields"/);
  assert.match(ownerHtml, /"flyerDesignerInstagramHandle":"new\.artist"/);

  const duplicate = await fetch(`${baseUrl}/api/events/${createdEvent.id}/duplicate`, {
    method: 'POST',
    headers: { cookie: organizerCookie }
  });
  assert.equal(duplicate.status, 201);
  const duplicateEvent = (await duplicate.json()).event;
  assert.equal(duplicateEvent.flyer_designer_name, 'New Poster Lab');
  assert.equal(duplicateEvent.flyer_designer_instagram_handle, 'new.artist');
  assert.equal(duplicateEvent.status, 'draft');
});

test('Commerce ticket events use Get Tickets, reject RSVP, and never duplicate the Commerce reference', async () => {
  const organizerCookie = `sge_session=${signSession(organizerId)}`;
  const missingReference = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: organizerCookie },
    body: JSON.stringify({
      title: 'Unlinked Commerce Night',
      event_date: '2030-08-11',
      start_time: '19:30',
      venue_name: 'Test Hall',
      admission_type: 'silver_glider_tickets'
    })
  });
  assert.equal(missingReference.status, 400);

  const create = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: organizerCookie },
    body: JSON.stringify({
      title: 'Commerce Night',
      event_date: '2030-08-10',
      start_time: '19:30',
      venue_name: 'Test Hall',
      admission_type: 'silver_glider_tickets',
      commerce_event_id: 'commerce_event_123'
    })
  });
  assert.equal(create.status, 201);
  const commerceEvent = (await create.json()).event;

  const publicPage = await fetch(`${baseUrl}/e/${commerceEvent.slug}`);
  const publicHtml = await publicPage.text();
  assert.equal(publicPage.status, 200);
  assert.match(publicHtml, new RegExp(`data-primary-action="ticket"[^>]*href="/e/${commerceEvent.slug}/tickets"[^>]*>Get Tickets</a>`));
  assert.match(publicHtml, /"rsvpEnabled":false/);
  assert.doesNotMatch(publicHtml, /data-open-rsvp/);

  const directRsvp = await fetch(`${baseUrl}/api/public/events/${commerceEvent.slug}/rsvp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ full_name: 'Ticket Buyer', email: 'buyer@example.test' })
  });
  assert.equal(directRsvp.status, 409);
  assert.equal((await directRsvp.json()).error, 'tickets_required');

  const handoff = await fetch(`${baseUrl}/e/${commerceEvent.slug}/tickets`);
  assert.equal(handoff.status, 503);
  assert.match(await handoff.text(), /Ticket checkout is temporarily unavailable/);

  const duplicate = await fetch(`${baseUrl}/api/events/${commerceEvent.id}/duplicate`, {
    method: 'POST',
    headers: { cookie: organizerCookie }
  });
  assert.equal(duplicate.status, 201);
  const duplicateEvent = (await duplicate.json()).event;
  assert.equal(duplicateEvent.admission_type, 'silver_glider_tickets');
  assert.equal(duplicateEvent.commerce_event_id, null);
  assert.equal(duplicateEvent.status, 'draft');
});

test('canonical external tickets preserve the existing price, link, and RSVP behavior', async () => {
  const response = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `sge_session=${signSession(organizerId)}`
    },
    body: JSON.stringify({
      title: 'External Ticket Night',
      event_date: '2030-09-20',
      start_time: '20:00',
      venue_name: 'External Hall',
      admission_type: 'external_tickets',
      ticket_price: 25,
      ticket_url: 'https://tickets.example.test/external-night'
    })
  });
  assert.equal(response.status, 201);
  const event = (await response.json()).event;
  assert.equal(event.admission_type, 'external_tickets');
  assert.equal(Number(event.ticket_price), 25);
  assert.equal(event.commerce_event_id, null);

  const pageHtml = await (await fetch(`${baseUrl}/e/${event.slug}`)).text();
  assert.match(pageHtml, /\$25/);
  assert.match(pageHtml, /https:\/\/tickets\.example\.test\/external-night/);
  assert.match(pageHtml, /data-primary-action="rsvp"/);
});

test('ticketing launch interest is reversible, admin-visible, and safely gated', async () => {
  const cookie = `sge_session=${signSession(organizerId)}`;
  const initialConfig = await fetch(`${baseUrl}/api/commerce/config`, { headers: { cookie } });
  assert.equal(initialConfig.status, 200);
  assert.equal((await initialConfig.json()).interest.interested, false);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const subscribe = await fetch(`${baseUrl}/api/commerce/interest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ interested: true })
    });
    assert.equal(subscribe.status, 200);
    assert.equal((await subscribe.json()).interest.interested, true);
  }
  const stored = await pool.query(
    `SELECT COUNT(*)::int AS count FROM commerce_feature_interests
      WHERE organizer_id=$1 AND feature_key='commerce_ticketing'`,
    [organizerId]
  );
  assert.equal(stored.rows[0].count, 1);

  const denied = await fetch(`${baseUrl}/api/admin/commerce-interest`, { headers: { cookie } });
  assert.equal(denied.status, 403);

  await pool.query('UPDATE organizers SET is_admin=TRUE WHERE id=$1', [organizerId]);
  const adminPage = await fetch(`${baseUrl}/admin/ticketing`, { headers: { cookie } });
  assert.equal(adminPage.status, 200);
  assert.match(await adminPage.text(), /Ticketing interest/);

  const adminList = await fetch(`${baseUrl}/api/admin/commerce-interest`, { headers: { cookie } });
  assert.equal(adminList.status, 200);
  const adminData = await adminList.json();
  assert.equal(adminData.counts.interested, 1);
  assert.equal(adminData.counts.awaiting, 1);
  assert.equal(adminData.interests[0].email, 'host@example.test');

  const testEmail = await fetch(`${baseUrl}/api/admin/commerce-interest/test`, {
    method: 'POST', headers: { cookie }
  });
  assert.equal(testEmail.status, 200);
  assert.equal((await testEmail.json()).recipient, 'host@example.test');

  const prematureLaunch = await fetch(`${baseUrl}/api/admin/commerce-interest/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ confirm: 'SEND_LAUNCH' })
  });
  assert.equal(prematureLaunch.status, 409);

  const previousCommerce = {
    enabled: process.env.COMMERCE_ENABLED,
    baseUrl: commerceClient.baseUrl,
    apiKey: commerceClient.apiKey
  };
  process.env.COMMERCE_ENABLED = 'true';
  commerceClient.baseUrl = 'https://commerce.example.test';
  commerceClient.apiKey = 'integration-test-key';
  try {
    const launch = await fetch(`${baseUrl}/api/admin/commerce-interest/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ confirm: 'SEND_LAUNCH' })
    });
    assert.equal(launch.status, 200);
    assert.deepEqual(await launch.json(), { total: 1, sent: 1, failed: 0 });

    const retryLaunch = await fetch(`${baseUrl}/api/admin/commerce-interest/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ confirm: 'SEND_LAUNCH' })
    });
    assert.equal(retryLaunch.status, 200);
    assert.deepEqual(await retryLaunch.json(), { total: 0, sent: 0, failed: 0 });
  } finally {
    process.env.COMMERCE_ENABLED = previousCommerce.enabled;
    commerceClient.baseUrl = previousCommerce.baseUrl;
    commerceClient.apiKey = previousCommerce.apiKey;
  }

  const delivered = await pool.query(
    `SELECT launch_sent_at FROM commerce_feature_interests
      WHERE organizer_id=$1 AND feature_key='commerce_ticketing'`,
    [organizerId]
  );
  assert.ok(delivered.rows[0].launch_sent_at);

  const remove = await fetch(`${baseUrl}/api/commerce/interest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ interested: false })
  });
  assert.equal(remove.status, 200);
  assert.equal((await remove.json()).interest.interested, false);

  const afterRemoval = await fetch(`${baseUrl}/api/admin/commerce-interest`, { headers: { cookie } });
  const afterRemovalData = await afterRemoval.json();
  assert.equal(afterRemovalData.counts.interested, 0);
  assert.ok(afterRemovalData.interests[0].removed_at);
});

test('renders the Host Page Dashboard control only for its authenticated owner', async () => {
  const publicPage = await fetch(`${baseUrl}/h/test-host`);
  const publicHtml = await publicPage.text();
  assert.equal(publicPage.status, 200);
  assert.doesNotMatch(publicHtml, /<a class="host-owner-dashboard"/);
  assert.doesNotMatch(publicHtml, /← Dashboard/);

  const ownerPage = await fetch(`${baseUrl}/h/test-host`, {
    headers: { cookie: `sge_session=${signSession(organizerId)}` }
  });
  const ownerHtml = await ownerPage.text();
  assert.equal(ownerPage.status, 200);
  assert.match(ownerHtml, /class="host-owner-dashboard" href="\/dashboard"/);
  assert.match(ownerHtml, /← Dashboard<\/a>/);
  assert.doesNotMatch(ownerHtml, /<div class="host-follow" data-host-follow/);

  const visitorId = (await pool.query(
    `INSERT INTO organizers (email, name)
     VALUES ('host-page-visitor@example.test', 'Host Page Visitor') RETURNING id`
  )).rows[0].id;
  const visitorPage = await fetch(`${baseUrl}/h/test-host`, {
    headers: { cookie: `sge_session=${signSession(visitorId)}` }
  });
  const visitorHtml = await visitorPage.text();
  assert.equal(visitorPage.status, 200);
  assert.doesNotMatch(visitorHtml, /<a class="host-owner-dashboard"/);
  assert.match(visitorHtml, /<div class="host-follow" data-host-follow/);
});

test('completes logged-in and magic-link Host follows without creating Host Pages', async () => {
  const secondHostId = (await pool.query(
    `INSERT INTO organizers (email, org_name, public_slug)
     VALUES ('second-host@example.test', 'Second Host', 'second-host') RETURNING id`
  )).rows[0].id;
  await pool.query(
    `INSERT INTO events (organizer_id, slug, title, event_date, start_time, venue_name, visibility, status)
     VALUES ($1, 'second-host-public', 'Second Public Show', '2030-10-10', '20:00', 'Public Hall', 'public', 'published'),
            ($1, 'second-host-private', 'Second Private Show', '2030-10-11', '20:00', 'Private Hall', 'private', 'published')`,
    [secondHostId]
  );

  const signedInFollow = await fetch(`${baseUrl}/api/hosts/second-host/follow`, {
    method: 'POST', headers: { cookie: `sge_session=${signSession(organizerId)}` }
  });
  assert.equal(signedInFollow.status, 200);
  assert.deepEqual(await signedInFollow.json(), { following: true });
  await fetch(`${baseUrl}/api/hosts/second-host/follow`, {
    method: 'POST', headers: { cookie: `sge_session=${signSession(organizerId)}` }
  });
  let count = (await pool.query(
    'SELECT COUNT(*)::int AS count FROM host_follows WHERE follower_organizer_id=$1 AND host_organizer_id=$2',
    [organizerId, secondHostId]
  )).rows[0].count;
  assert.equal(count, 1, 'repeated follows should reuse one relationship row');

  const following = await fetch(`${baseUrl}/api/following`, {
    headers: { cookie: `sge_session=${signSession(organizerId)}` }
  });
  const followingPayload = await following.json();
  assert.equal(followingPayload.hosts[0].org_name, 'Second Host');
  assert.equal(followingPayload.hosts[0].upcoming_count, 1, 'private events must not count');

  const unfollow = await fetch(`${baseUrl}/api/hosts/second-host/follow`, {
    method: 'DELETE', headers: { cookie: `sge_session=${signSession(organizerId)}` }
  });
  assert.deepEqual(await unfollow.json(), { following: false });
  await fetch(`${baseUrl}/api/hosts/second-host/follow`, {
    method: 'POST', headers: { cookie: `sge_session=${signSession(organizerId)}` }
  });
  count = (await pool.query(
    'SELECT COUNT(*)::int AS count FROM host_follows WHERE follower_organizer_id=$1 AND host_organizer_id=$2',
    [organizerId, secondHostId]
  )).rows[0].count;
  assert.equal(count, 1, 'refollow should reactivate rather than duplicate');

  const magicRequest = await fetch(`${baseUrl}/api/auth/magic-link`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'new-follower@example.test', intent: 'follow_host', host_slug: 'test-host' })
  });
  assert.equal(magicRequest.status, 200);
  const pending = (await pool.query(
    `SELECT token, intent, target_organizer_id, return_path
       FROM magic_link_tokens WHERE email='new-follower@example.test' ORDER BY id DESC LIMIT 1`
  )).rows[0];
  assert.equal(pending.intent, 'follow_host');
  assert.equal(pending.target_organizer_id, organizerId);
  assert.equal(pending.return_path, '/h/test-host');

  const verify = await fetch(`${baseUrl}/auth/verify?token=${pending.token}&next=%2Fdashboard`, { redirect: 'manual' });
  assert.equal(verify.status, 302);
  assert.equal(verify.headers.get('location'), '/h/test-host', 'stored intent return must win over URL tampering');
  const follower = (await pool.query(
    `SELECT id, org_name, public_slug FROM organizers WHERE email='new-follower@example.test'`
  )).rows[0];
  assert.equal(follower.org_name, null);
  assert.equal(follower.public_slug, null);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM host_follows
      WHERE follower_organizer_id=$1 AND host_organizer_id=$2 AND unsubscribed_at IS NULL`,
    [follower.id, organizerId]
  )).rows[0].count, 1);
});

test('keeps ordinary Create Event magic-link destinations unchanged', async () => {
  const request = await fetch(`${baseUrl}/api/auth/magic-link`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'creator-flow@example.test', next: '/events/new' })
  });
  assert.equal(request.status, 200);
  const pending = (await pool.query(
    `SELECT token, intent, target_organizer_id, return_path
       FROM magic_link_tokens WHERE email='creator-flow@example.test' ORDER BY id DESC LIMIT 1`
  )).rows[0];
  assert.equal(pending.intent, 'sign_in');
  assert.equal(pending.target_organizer_id, null);
  assert.equal(pending.return_path, '/events/new');
  const verify = await fetch(`${baseUrl}/auth/verify?token=${pending.token}`, { redirect: 'manual' });
  assert.equal(verify.status, 302);
  assert.equal(verify.headers.get('location'), '/events/new');
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM host_follows hf
      JOIN organizers o ON o.id=hf.follower_organizer_id
     WHERE o.email='creator-flow@example.test'`
  )).rows[0].count, 0);
});

test('serves two labeled Event Vibe choices in both public presentations', async () => {
  const vibeFields = {
    event_vibe_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    event_vibe_label: 'Fire in the Sky',
    event_vibe_url_2: 'https://www.youtube.com/watch?v=9bZkp7q19f0',
    event_vibe_label_2: 'TL Tramps'
  };
  await createEvent({ slug: 'standard-vibe', ...vibeFields });
  await createEvent({
    slug: 'flyer-vibe',
    presentation_mode: 'flyer',
    flyer_image_url: 'https://res.cloudinary.com/dhvavjgnw/image/upload/sg-events/flyers/vibe.jpg',
    ...vibeFields
  });

  for (const slug of ['standard-vibe', 'flyer-vibe']) {
    const response = await fetch(`${baseUrl}/e/${slug}`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /data-vibe-switcher/);
    assert.match(html, /role="tablist" aria-label="Choose an artist"/);
    assert.match(html, />Fire in the Sky<\/button>/);
    assert.match(html, />TL Tramps<\/button>/);
    assert.equal((html.match(/data-vibe-player/g) || []).length, 1);
    assert.equal((html.match(/data-vibe-template=/g) || []).length, 2);
  }
});

test('keeps Secret Show details out of locked responses and reveals them after unlock', async () => {
  const event = await createEvent({
    slug: 'secret-night',
    title: 'Hidden Headliner',
    description: 'Do not leak this description.',
    venue_name: 'Hidden Venue',
    visibility: 'private',
    secret_show_enabled: true,
    secret_show_version: 1
  });
  await pool.query(
    'INSERT INTO event_secret_codes (event_id, code_hash) VALUES ($1, $2)',
    [event.id, await hashCode('AB12CD')]
  );

  const locked = await fetch(`${baseUrl}/e/secret-night`);
  const lockedHtml = await locked.text();
  assert.equal(locked.status, 200);
  assert.equal(locked.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.doesNotMatch(lockedHtml, /Hidden Headliner|Hidden Venue|Do not leak/);

  const unlock = await fetch(`${baseUrl}/api/public/events/secret-night/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'AB12CD' })
  });
  assert.equal(unlock.status, 200);
  const setCookie = unlock.headers.get('set-cookie') || '';
  const unlockCookie = setCookie.match(/sge_secret_\d+=[^;]+/)?.[0];
  assert.ok(unlockCookie, 'unlock response should set an event-scoped cookie');

  const revealed = await fetch(`${baseUrl}/e/secret-night`, { headers: { cookie: unlockCookie } });
  const revealedHtml = await revealed.text();
  assert.equal(revealed.status, 200);
  assert.match(revealedHtml, /Hidden Headliner/);
  assert.match(revealedHtml, /Hidden Venue/);
});

test('enforces RSVP capacity through the live HTTP route and database transaction', async () => {
  await createEvent({ slug: 'one-seat', title: 'One Seat', capacity: 1 });

  const first = await fetch(`${baseUrl}/api/public/events/one-seat/rsvp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ full_name: 'First Guest', email: 'first@example.test' })
  });
  assert.equal(first.status, 201);
  await waitForConfirmation('first@example.test');

  const second = await fetch(`${baseUrl}/api/public/events/one-seat/rsvp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ full_name: 'Second Guest', email: 'second@example.test' })
  });
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), { error: 'full' });

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM rsvps
      WHERE event_id=(SELECT id FROM events WHERE slug='one-seat') AND status='confirmed'`
  );
  assert.equal(rows[0].count, 1);
});

test('uses past tense for attendance after a private event passes', async () => {
  const past = await createEvent({
    slug: 'past-private-night',
    title: 'Past Private Night',
    event_date: '2020-08-10',
    visibility: 'private',
    show_guest_list: true,
    allow_guests: true
  });
  await pool.query(
    `INSERT INTO rsvps
       (event_id, first_name, last_name, email, guest_first_name, wants_reminders, organizer_optin, status, manage_token)
     VALUES ($1,'First','Guest','past-one@example.test','Plus One',TRUE,FALSE,'confirmed','past-one-token'),
            ($1,'Second','Guest','past-two@example.test',NULL,TRUE,FALSE,'confirmed','past-two-token')`,
    [past.id]
  );

  const response = await fetch(`${baseUrl}/e/past-private-night`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /3 people went/);
  assert.doesNotMatch(html, /3 people are going/);
  assert.match(html, /class="guest-avatar-stack"/);
  assert.match(html, /aria-controls="guest-list-inline guest-list-modal"/);
  assert.match(html, /class="guest-list-inline" id="guest-list-inline" hidden/);
  assert.match(html, /class="guest-list-modal-card" role="dialog" aria-modal="true"/);
  assert.match(html, /First[\s\S]*Plus One[\s\S]*Second/);
});

test('guest preview shows first names for up to five attendees and compacts at six', async () => {
  const event = await createEvent({ slug: 'guest-preview-night', show_guest_list: true });
  const firstNames = ['Ada', 'Ben', 'Cleo', 'Drew', 'Esme', 'Finn'];

  for (const [index, firstName] of firstNames.entries()) {
    await pool.query(
      `INSERT INTO rsvps (event_id, first_name, last_name, email, status, manage_token)
       VALUES ($1,$2,'Guest',$3,'confirmed',$4)`,
      [event.id, firstName, `preview-${index}@example.test`, `guest-preview-token-${index}`]
    );

    if (index !== 4) continue;
    const fiveGuestPage = await fetch(`${baseUrl}/e/${event.slug}`);
    const fiveGuestHtml = await fiveGuestPage.text();
    assert.equal(fiveGuestPage.status, 200);
    assert.match(fiveGuestHtml, /data-preview-style="named"/);
    assert.equal((fiveGuestHtml.match(/class="guest-avatar-label"/g) || []).length, 5);
    assert.match(fiveGuestHtml, /class="guest-avatar-label">Ada<\/span>/);
    assert.match(fiveGuestHtml, /class="guest-avatar-label">Esme<\/span>/);
    assert.match(fiveGuestHtml, /See everyone/);
  }

  const sixGuestPage = await fetch(`${baseUrl}/e/${event.slug}`);
  const sixGuestHtml = await sixGuestPage.text();
  assert.equal(sixGuestPage.status, 200);
  assert.match(sixGuestHtml, /data-preview-style="compact"/);
  assert.doesNotMatch(sixGuestHtml, /class="guest-avatar-label"/);
  assert.match(sixGuestHtml, /See everyone/);
});

test('past events no longer accept new RSVPs', async () => {
  await createEvent({ slug: 'ended-rsvp-night', event_date: '2020-08-10' });

  const page = await fetch(`${baseUrl}/e/ended-rsvp-night`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /This event has ended\./);
  assert.doesNotMatch(html, /data-open-rsvp/);

  const response = await fetch(`${baseUrl}/api/public/events/ended-rsvp-night/rsvp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ full_name: 'Late Guest', email: 'late@example.test' })
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'event_ended', message: 'This event has ended.' });
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM rsvps
      WHERE event_id=(SELECT id FROM events WHERE slug='ended-rsvp-night')`
  )).rows[0].count, 0);
});

test('keeps Collect Photos isolated to one Super-Admin-enabled past event', async () => {
  const past = await createEvent({
    slug: 'past-photo-night',
    title: 'Past Photo Night',
    event_date: '2020-08-10'
  });
  const future = await createEvent({
    slug: 'future-photo-night',
    title: 'Future Photo Night',
    event_date: '2030-08-10'
  });
  const organizerCookie = `sge_session=${signSession(organizerId)}`;

  const forbidden = await fetch(`${baseUrl}/api/admin/events/${past.id}/collect-photos`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: organizerCookie },
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(forbidden.status, 403);

  await pool.query('UPDATE organizers SET is_admin=TRUE WHERE id=$1', [organizerId]);
  const futureEnable = await fetch(`${baseUrl}/api/admin/events/${future.id}/collect-photos`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: organizerCookie },
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(futureEnable.status, 400);

  const enabled = await fetch(`${baseUrl}/api/admin/events/${past.id}/collect-photos`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: organizerCookie },
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(enabled.status, 200);
  const enabledEvent = (await enabled.json()).event;
  assert.equal(enabledEvent.collect_photos_enabled, true);
  assert.match(enabledEvent.photo_upload_token, /^[a-f0-9]{48}$/);
  assert.match(enabledEvent.photo_short_token, /^[A-Za-z0-9_-]{22}$/);

  const state = await pool.query(
    'SELECT id, collect_photos_enabled, photo_upload_token, photo_short_token FROM events WHERE id IN ($1,$2) ORDER BY id',
    [past.id, future.id]
  );
  assert.equal(state.rows.find(event => event.id === past.id).collect_photos_enabled, true);
  assert.equal(state.rows.find(event => event.id === future.id).collect_photos_enabled, false);
  assert.equal(state.rows.find(event => event.id === future.id).photo_upload_token, null);
  assert.equal(state.rows.find(event => event.id === future.id).photo_short_token, null);

  const uploadPage = await fetch(`${baseUrl}/photos/${enabledEvent.photo_upload_token}`);
  const uploadHtml = await uploadPage.text();
  assert.equal(uploadPage.status, 200);
  assert.match(uploadHtml, /Share your photos from Past Photo Night/);
  assert.match(uploadHtml, /No account needed/);
  assert.equal(uploadPage.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');

  // Simulate an event enabled before short links existed. Owner access backfills
  // a short token without invalidating its already-shared legacy URL.
  await pool.query('UPDATE events SET photo_short_token=NULL WHERE id=$1', [past.id]);

  const normalEventPage = await fetch(`${baseUrl}/e/past-photo-night`);
  const normalEventHtml = await normalEventPage.text();
  assert.equal(normalEventPage.status, 200);
  assert.doesNotMatch(normalEventHtml, /photo-form|Collect photos/);

  await pool.query(
    `INSERT INTO rsvps (event_id, first_name, last_name, email, wants_reminders, organizer_optin, status, manage_token)
     VALUES ($1,'Photo','Guest','photo-guest@example.test',TRUE,FALSE,'confirmed','photo-guest-token'),
            ($1,'No','Updates','no-updates@example.test',FALSE,FALSE,'confirmed','no-updates-token')`,
    [past.id]
  );

  const collection = await fetch(`${baseUrl}/api/events/${past.id}/photos`, {
    headers: { cookie: organizerCookie }
  });
  const collectionData = await collection.json();
  assert.equal(collection.status, 200);
  assert.equal(collectionData.eligibleCount, 1);
  assert.equal(collectionData.photos.length, 0);
  assert.match(collectionData.collectionUrl, /\/p\/[A-Za-z0-9_-]{22}$/);
  const shortPath = new URL(collectionData.collectionUrl).pathname;
  const shortUploadPage = await fetch(`${baseUrl}${shortPath}`);
  assert.equal(shortUploadPage.status, 200);
  const shortUploadHtml = await shortUploadPage.text();
  assert.match(shortUploadHtml, /Allow public featuring/);
  assert.match(shortUploadHtml, /Your name will not be shown publicly/);

  const { rows: photoRows } = await pool.query(
    `INSERT INTO event_photos
       (event_id, cloudinary_id, image_url, contributor_name, public_feature_consent)
     VALUES ($1,'private-photo','https://images.example/private.jpg','Private Person',FALSE),
            ($1,'consented-photo','https://images.example/featured.jpg','Featured Person',TRUE)
     RETURNING id, public_feature_consent`,
    [past.id]
  );
  const privatePhoto = photoRows.find(photo => !photo.public_feature_consent);
  const consentedPhoto = photoRows.find(photo => photo.public_feature_consent);

  const unsignedFeature = await fetch(`${baseUrl}/api/events/${past.id}/photos/${consentedPhoto.id}/feature`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ featured: true })
  });
  assert.equal(unsignedFeature.status, 401);
  const privateFeature = await fetch(`${baseUrl}/api/events/${past.id}/photos/${privatePhoto.id}/feature`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: organizerCookie },
    body: JSON.stringify({ featured: true })
  });
  assert.equal(privateFeature.status, 400);
  assert.match((await privateFeature.json()).error, /did not permit public featuring/);

  const feature = await fetch(`${baseUrl}/api/events/${past.id}/photos/${consentedPhoto.id}/feature`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: organizerCookie },
    body: JSON.stringify({ featured: true })
  });
  assert.equal(feature.status, 200);
  assert.equal((await feature.json()).photo.is_featured, true);

  const recapPage = await fetch(`${baseUrl}/e/past-photo-night`);
  const recapHtml = await recapPage.text();
  assert.match(recapHtml, /Event photos/);
  assert.match(recapHtml, /class="event-recap" id="event-recap"/);
  assert.match(recapHtml, /data-primary-action="recap"[^>]*href="#event-recap"[^>]*>View event photos<\/a>/);
  assert.doesNotMatch(recapHtml, /data-open-rsvp/);
  assert.match(recapHtml, /https:\/\/images\.example\/featured\.jpg/);
  assert.doesNotMatch(recapHtml, /private\.jpg|Private Person|Featured Person/);

  const unfeature = await fetch(`${baseUrl}/api/events/${past.id}/photos/${consentedPhoto.id}/feature`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: organizerCookie },
    body: JSON.stringify({ featured: false })
  });
  assert.equal(unfeature.status, 200);
  const recapRemovedHtml = await (await fetch(`${baseUrl}/e/past-photo-night`)).text();
  assert.doesNotMatch(recapRemovedHtml, /Event photos|featured\.jpg/);
  assert.match(recapRemovedHtml, /This event has ended\./);
  assert.doesNotMatch(recapRemovedHtml, /data-open-rsvp/);

  const request = await fetch(`${baseUrl}/api/events/${past.id}/photo-request`, {
    method: 'POST', headers: { cookie: organizerCookie }
  });
  assert.equal(request.status, 200);
  assert.deepEqual(await request.json(), { sent: 1, total: 1 });
  const logs = await pool.query(
    `SELECT recipient, status FROM message_log WHERE event_id=$1 AND message_type='photo_request'`,
    [past.id]
  );
  assert.deepEqual(logs.rows, [{ recipient: 'photo-guest@example.test', status: 'sent' }]);

  const repeated = await fetch(`${baseUrl}/api/events/${past.id}/photo-request`, {
    method: 'POST', headers: { cookie: organizerCookie }
  });
  assert.equal(repeated.status, 409);

  const disabled = await fetch(`${baseUrl}/api/admin/events/${past.id}/collect-photos`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: organizerCookie },
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(disabled.status, 200);
  const hiddenUploadPage = await fetch(`${baseUrl}/photos/${enabledEvent.photo_upload_token}`);
  assert.equal(hiddenUploadPage.status, 404);
  const hiddenShortUploadPage = await fetch(`${baseUrl}${shortPath}`);
  assert.equal(hiddenShortUploadPage.status, 404);
});

test('invites confirmed primary guests from one past event and never emails them twice', async () => {
  const source = await createEvent({
    slug: 'past-birthday-crowd',
    title: 'Past Birthday Crowd',
    event_date: '2020-04-18'
  });
  const target = await createEvent({
    slug: 'next-private-party',
    title: 'Next Private Party',
    event_date: '2030-11-14',
    visibility: 'private'
  });
  await createRsvp(source.id, {
    first_name: 'Alice', last_name: 'Eligible', email: 'alice@example.test', organizer_optin: true,
    guest_first_name: 'Plus', guest_last_name: 'One', guest_email: 'plus-one@example.test'
  });
  await createRsvp(source.id, {
    first_name: 'Frank', last_name: 'Selectable', email: 'frank@example.test', organizer_optin: true
  });
  const rsvpOnly = await createRsvp(source.id, {
    first_name: 'No', last_name: 'Consent', email: 'no-consent@example.test', organizer_optin: false
  });
  await createRsvp(source.id, {
    first_name: 'Cancelled', last_name: 'Guest', email: 'cancelled@example.test', organizer_optin: true, status: 'cancelled'
  });
  await createRsvp(source.id, {
    first_name: 'Host', last_name: 'Optout', email: 'host-optout@example.test', organizer_optin: true
  });
  await pool.query(
    `INSERT INTO follower_optouts (organizer_id,email) VALUES ($1,'host-optout@example.test')`,
    [organizerId]
  );
  await createRsvp(source.id, {
    first_name: 'Already', last_name: 'Going', email: 'already-going@example.test', organizer_optin: true
  });
  await createRsvp(target.id, {
    first_name: 'Already', last_name: 'Going', email: 'already-going@example.test'
  });

  const cookie = `sge_session=${signSession(organizerId)}`;
  const overviewResponse = await fetch(`${baseUrl}/api/events/${target.id}/previous-guests`, {
    headers: { cookie }
  });
  const overview = await overviewResponse.json();
  assert.equal(overviewResponse.status, 200);
  assert.equal(overview.canInvite, true);
  assert.equal(overview.sources.length, 1);
  assert.equal(overview.sources[0].peopleCount, 6);
  assert.equal(overview.sources[0].eligibleCount, 3);

  const reviewResponse = await fetch(
    `${baseUrl}/api/events/${target.id}/previous-guests?sourceEventId=${source.id}`,
    { headers: { cookie } }
  );
  const review = await reviewResponse.json();
  assert.equal(reviewResponse.status, 200);
  assert.deepEqual(review.recipients.map(person => person.email).sort(), [
    'alice@example.test', 'frank@example.test', 'no-consent@example.test'
  ]);
  assert.doesNotMatch(JSON.stringify(review.recipients), /plus-one|cancelled|host-optout|already-going/);

  const sendResponse = await fetch(`${baseUrl}/api/events/${target.id}/previous-guests/invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ sourceEventId: source.id, rsvpIds: [rsvpOnly.id] })
  });
  assert.equal(sendResponse.status, 202);
  assert.equal((await sendResponse.json()).queued, 1);

  let delivery;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { rows } = await pool.query(
      `SELECT recipient, recipient_name, status, attempt_count
         FROM message_log WHERE event_id=$1 AND message_type='previous_guest_invite'`,
      [target.id]
    );
    delivery = rows[0];
    if (delivery?.status === 'sent') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.deepEqual(delivery, {
    recipient: 'no-consent@example.test', recipient_name: 'No Consent', status: 'sent', attempt_count: 1
  });

  const repeated = await fetch(`${baseUrl}/api/events/${target.id}/previous-guests/invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ sourceEventId: source.id, rsvpIds: [rsvpOnly.id] })
  });
  assert.equal(repeated.status, 409);

  const followers = await fetch(`${baseUrl}/api/events/${target.id}/followers`, { headers: { cookie } });
  const followerData = await followers.json();
  assert.equal(followerData.count, 2);
  assert.equal(followerData.canAnnounce, false);
});

test('Familiar Faces keeps verified photos reusable and safely invites selected people across events', async () => {
  const source = await createEvent({
    slug: 'familiar-summer-party',
    title: 'Familiar Summer Party',
    event_date: '2020-07-18'
  });
  const targetOne = await createEvent({
    slug: 'familiar-fall-party',
    title: 'Familiar Fall Party',
    event_date: '2030-10-17'
  });
  const targetTwo = await createEvent({
    slug: 'familiar-winter-party',
    title: 'Familiar Winter Party',
    event_date: '2030-12-12',
    presentation_mode: 'flyer',
    flyer_image_url: 'https://res.cloudinary.com/demo/image/upload/v1/winter.jpg'
  });
  const guestAccount = (await pool.query(
    `INSERT INTO organizers (email, name, avatar_url)
     VALUES ('maya@example.test','Maya Lopez','https://res.cloudinary.com/demo/image/upload/v1/maya.jpg')
     RETURNING id`
  )).rows[0];
  const maya = await createRsvp(source.id, {
    first_name: 'Maya', last_name: 'Lopez', email: 'maya@example.test',
    organizer_optin: true, account_id: guestAccount.id,
    guest_first_name: 'Sam', guest_last_name: 'Friend'
  });
  const ari = await createRsvp(source.id, {
    first_name: 'Ari', last_name: 'Lee', email: 'ari@example.test', organizer_optin: true
  });
  const rsvpOnly = await createRsvp(source.id, {
    first_name: 'No', last_name: 'Consent', email: 'private@example.test', organizer_optin: false
  });
  const priorBatch = (await pool.query(
    `INSERT INTO previous_guest_invitation_batches
       (target_event_id, source_event_id, source_event_title, status, recipient_count, sent_count, completed_at)
     VALUES ($1,NULL,'Earlier Event','sent',1,1,NOW()) RETURNING id`,
    [source.id]
  )).rows[0];
  await pool.query(
    `INSERT INTO message_log
       (event_id, previous_guest_invitation_batch_id, recipient, recipient_name,
        message_type, channel, status, sent_at)
     VALUES ($1,$2,'invited@example.test','Invited Person','previous_guest_invite','email','sent',NOW())`,
    [source.id, priorBatch.id]
  );

  const cookie = `sge_session=${signSession(organizerId)}`;
  const listResponse = await fetch(`${baseUrl}/api/events/${source.id}/familiar-faces`, {
    headers: { cookie }
  });
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.canStartInvitation, true);
  assert.equal(list.totalCount, 5);
  assert.deepEqual(new Set(list.faces.map(face => face.status)), new Set(['RSVP’d', 'Invited']));
  assert.equal(list.faces.find(face => face.id === `rsvp:${maya.id}`).avatarUrl,
    'https://res.cloudinary.com/demo/image/upload/v1/maya.jpg');
  const ariFace = list.faces.find(face => face.id === `rsvp:${ari.id}`);
  assert.equal(ariFace.avatarEmoji, attendeeAvatar('email:ari@example.test'));
  assert.equal(list.faces.find(face => face.name === 'Sam Friend').canInvite, false);
  assert.equal(list.faces.find(face => face.name === 'No Consent').canInvite, true);
  assert.doesNotMatch(JSON.stringify(list), /maya@example|ari@example|private@example|invited@example/);

  const emailSearch = await fetch(
    `${baseUrl}/api/events/${source.id}/familiar-faces?search=${encodeURIComponent('maya@example.test')}`,
    { headers: { cookie } }
  );
  const searchResults = await emailSearch.json();
  assert.equal(searchResults.faces.length, 1);
  assert.equal(searchResults.faces[0].name, 'Maya Lopez');
  assert.doesNotMatch(JSON.stringify(searchResults), /maya@example/);

  const previewResponse = await fetch(`${baseUrl}/api/events/${source.id}/familiar-faces/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ faceIds: [`rsvp:${maya.id}`, `rsvp:${ari.id}`, `rsvp:${rsvpOnly.id}`] })
  });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.selectedCount, 3);
  assert.deepEqual(preview.events.map(event => event.id), [targetOne.id, targetTwo.id]);
  assert.ok(preview.events.every(event => event.eligibleCount === 3));

  async function invite(targetEventId, faceIds) {
    return fetch(`${baseUrl}/api/events/${source.id}/familiar-faces/invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ targetEventId, faceIds })
    });
  }
  const firstSend = await invite(targetOne.id, [`rsvp:${maya.id}`]);
  assert.equal(firstSend.status, 202);
  assert.equal((await firstSend.json()).queued, 1);

  const repeatSend = await invite(targetOne.id, [`rsvp:${maya.id}`]);
  assert.equal(repeatSend.status, 400);

  const secondGroup = await invite(targetOne.id, [`rsvp:${ari.id}`]);
  assert.equal(secondGroup.status, 202);
  assert.equal((await secondGroup.json()).queued, 1);

  const reuseForAnotherEvent = await invite(targetTwo.id, [`rsvp:${maya.id}`]);
  assert.equal(reuseForAnotherEvent.status, 202);
  assert.equal((await reuseForAnotherEvent.json()).queued, 1);

  const targetOneLogs = await pool.query(
    `SELECT LOWER(recipient) AS recipient FROM message_log
      WHERE event_id=$1 AND message_type='previous_guest_invite' ORDER BY recipient`,
    [targetOne.id]
  );
  assert.deepEqual(targetOneLogs.rows, [
    { recipient: 'ari@example.test' },
    { recipient: 'maya@example.test' }
  ]);
  const targetOneBatches = await pool.query(
    'SELECT COUNT(*)::int AS count FROM previous_guest_invitation_batches WHERE target_event_id=$1',
    [targetOne.id]
  );
  assert.equal(targetOneBatches.rows[0].count, 2);

  const targetFacesResponse = await fetch(`${baseUrl}/api/events/${targetOne.id}/familiar-faces`, {
    headers: { cookie }
  });
  assert.equal(targetFacesResponse.status, 200);
  const targetFaces = await targetFacesResponse.json();
  assert.equal(targetFaces.faces.find(face => face.name === 'Ari Lee').avatarEmoji, ariFace.avatarEmoji);
});

test('RSVP confirmation photo links verify one guest and reuse their persistent identity', async () => {
  const event = await createEvent({
    slug: 'photo-opportunity-night',
    title: 'Photo Opportunity Night',
    event_date: '2030-09-20'
  });
  const email = 'photo-opportunity@example.test';
  const rsvpResponse = await fetch(`${baseUrl}/api/public/events/${event.slug}/rsvp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ full_name: 'Photo Opportunity', email })
  });
  assert.equal(rsvpResponse.status, 201);
  await waitForConfirmation(email);

  const tokenRow = (await pool.query(
    `SELECT token, return_path, expires_at, used_at FROM magic_link_tokens
      WHERE email=$1 ORDER BY id DESC LIMIT 1`,
    [email]
  )).rows[0];
  assert.equal(tokenRow.return_path, `/add-photo?event=${event.slug}`);
  assert.equal(tokenRow.used_at, null);
  assert.ok(new Date(tokenRow.expires_at) > new Date());

  const verify = await fetch(`${baseUrl}/auth/verify?token=${tokenRow.token}`, { redirect: 'manual' });
  assert.equal(verify.status, 302);
  assert.equal(verify.headers.get('location'), `/add-photo?event=${event.slug}`);
  const guestCookie = verify.headers.get('set-cookie').split(';')[0];
  const page = await fetch(`${baseUrl}/add-photo?event=${event.slug}`, { headers: { cookie: guestCookie } });
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /Add your photo/);
  assert.match(pageHtml, /Help friends recognize you\./);

  const identity = (await pool.query(
    `SELECT r.account_id, o.email
       FROM rsvps r JOIN organizers o ON o.id=r.account_id
      WHERE r.event_id=$1 AND LOWER(r.email)=LOWER($2)`,
    [event.id, email]
  )).rows[0];
  assert.ok(identity.account_id);
  assert.equal(identity.email, email);

  const reused = await fetch(`${baseUrl}/auth/verify?token=${tokenRow.token}`, { redirect: 'manual' });
  assert.equal(reused.status, 302);
  assert.equal(reused.headers.get('location'), '/login?error=expired');

  await pool.query(
    `INSERT INTO organizers (email, name, avatar_url)
     VALUES ('already-visible@example.test','Already Visible',
             'https://res.cloudinary.com/demo/image/upload/v1/already-visible.jpg')
     RETURNING id`
  );
  const secondEvent = await createEvent({
    slug: 'photo-not-needed-night',
    title: 'Photo Not Needed Night',
    event_date: '2030-09-21'
  });
  const withPhoto = await fetch(`${baseUrl}/api/public/events/${secondEvent.slug}/rsvp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ full_name: 'Already Visible', email: 'already-visible@example.test' })
  });
  assert.equal(withPhoto.status, 201);
  await waitForConfirmation('already-visible@example.test');
  const noPromptToken = await pool.query(
    `SELECT 1 FROM magic_link_tokens WHERE email='already-visible@example.test'`
  );
  assert.equal(noPromptToken.rowCount, 0);
  const unverifiedRsvp = await pool.query(
    `SELECT account_id FROM rsvps WHERE event_id=$1 AND email='already-visible@example.test'`,
    [secondEvent.id]
  );
  assert.equal(unverifiedRsvp.rows[0].account_id, null);
});

test('admin-only SMS test route normalizes one recipient and cannot accept custom copy', async () => {
  const cookie = `sge_session=${signSession(organizerId)}`;
  const { rows: currentRows } = await pool.query('SELECT is_admin FROM organizers WHERE id=$1', [organizerId]);
  const wasAdmin = currentRows[0].is_admin;
  const originalSendTestSms = sms.sendTestSms;
  let deliveredTo = null;

  try {
    sms.sendTestSms = async recipient => {
      deliveredTo = recipient;
      return { sid: `SM${'d'.repeat(32)}`, status: 'accepted', recipient };
    };

    await pool.query('UPDATE organizers SET is_admin=FALSE WHERE id=$1', [organizerId]);
    const denied = await fetch(`${baseUrl}/api/admin/sms/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ to: '+14155551234', confirm: 'SEND_TEST_SMS' })
    });
    assert.equal(denied.status, 403);
    assert.equal(deliveredTo, null);

    await pool.query('UPDATE organizers SET is_admin=TRUE WHERE id=$1', [organizerId]);
    const unconfirmed = await fetch(`${baseUrl}/api/admin/sms/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ to: '+14155551234' })
    });
    assert.equal(unconfirmed.status, 400);
    assert.equal(deliveredTo, null);

    const invalid = await fetch(`${baseUrl}/api/admin/sms/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ to: 'not-a-phone', confirm: 'SEND_TEST_SMS' })
    });
    assert.equal(invalid.status, 400);
    assert.equal(deliveredTo, null);

    const sent = await fetch(`${baseUrl}/api/admin/sms/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        to: '(415) 555-1234',
        message: 'This browser-supplied text must never be sent.',
        confirm: 'SEND_TEST_SMS'
      })
    });
    assert.equal(sent.status, 200);
    assert.equal(deliveredTo, '+14155551234');
    assert.deepEqual(await sent.json(), {
      sent: true,
      sid: `SM${'d'.repeat(32)}`,
      status: 'accepted',
      recipient: '+14155551234'
    });
  } finally {
    sms.sendTestSms = originalSendTestSms;
    await pool.query('UPDATE organizers SET is_admin=$2 WHERE id=$1', [organizerId, wasAdmin]);
  }
});

test('host SMS credit checkout fulfills once and verified refund webhooks adjust the ledger', async () => {
  const cookie = `sge_session=${signSession(organizerId)}`;
  const envKeys = [
    'SMS_CREDITS_ENABLED', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET',
    'PAYPAL_ENV', 'PAYPAL_WEBHOOK_ID'
  ];
  const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const originals = {
    createOrder: paypal.paypalClient.createOrder,
    getOrder: paypal.paypalClient.getOrder,
    captureOrder: paypal.paypalClient.captureOrder,
    verifyWebhook: paypal.paypalClient.verifyWebhook
  };
  let createdOrderInput = null;
  const orderId = 'ORDER123456789';
  const captureId = 'CAPTURE12345678';

  try {
    process.env.SMS_CREDITS_ENABLED = 'true';
    process.env.PAYPAL_CLIENT_ID = 'integration-client-id';
    process.env.PAYPAL_CLIENT_SECRET = 'integration-client-secret';
    process.env.PAYPAL_ENV = 'live';
    process.env.PAYPAL_WEBHOOK_ID = 'WEBHOOK12345678';

    const signedOut = await fetch(`${baseUrl}/api/sms-credits`);
    assert.equal(signedOut.status, 401);

    const initialResponse = await fetch(`${baseUrl}/api/sms-credits`, { headers: { cookie } });
    const initial = await initialResponse.json();
    assert.equal(initialResponse.status, 200);
    assert.equal(initial.enabled, true);
    assert.equal(initial.checkoutReady, false);
    assert.equal(initial.balance, 0);
    assert.deepEqual(initial.packs.map(pack => [pack.credits, pack.amountCents]), [
      [300, 2000], [500, 3500], [1000, 6000]
    ]);
    assert.equal(JSON.stringify(initial).includes('integration-client-secret'), false);

    paypal.paypalClient.createOrder = async input => {
      createdOrderInput = input;
      return { id: orderId, status: 'CREATED' };
    };
    const orderResponse = await fetch(`${baseUrl}/api/sms-credits/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ packKey: 'starter', paymentMethod: 'venmo', amountCents: 1, credits: 999999 })
    });
    assert.equal(orderResponse.status, 201);
    assert.deepEqual(await orderResponse.json(), { orderId });
    assert.equal(createdOrderInput.amountCents, 2000);
    assert.equal(createdOrderInput.description, '300 Silver Glider SMS credits');
    assert.equal(createdOrderInput.paymentSource, 'venmo');
    const purchase = (await pool.query(
      'SELECT * FROM sms_credit_purchases WHERE provider_order_id=$1', [orderId]
    )).rows[0];
    assert.equal(purchase.organizer_id, organizerId);
    assert.equal(purchase.credits, 300);
    assert.equal(purchase.amount_cents, 2000);

    paypal.paypalClient.getOrder = async requestedOrderId => ({
      id: requestedOrderId,
      status: 'APPROVED',
      purchase_units: [{
        custom_id: purchase.reference,
        amount: { value: '20.00', currency_code: 'USD' }
      }]
    });
    paypal.paypalClient.captureOrder = async requestedOrderId => ({
      id: requestedOrderId,
      status: 'COMPLETED',
      purchase_units: [{
        custom_id: purchase.reference,
        amount: { value: '20.00', currency_code: 'USD' },
        payments: { captures: [{
          id: captureId,
          status: 'COMPLETED',
          amount: { value: '20.00', currency_code: 'USD' }
        }] }
      }]
    });
    const capturedResponse = await fetch(`${baseUrl}/api/sms-credits/orders/${orderId}/capture`, {
      method: 'POST', headers: { cookie }
    });
    const captured = await capturedResponse.json();
    assert.equal(capturedResponse.status, 200);
    assert.equal(captured.completed, true);
    assert.equal(captured.duplicate, false);
    assert.equal(captured.balance, 300);
    assert.equal(captured.transactions[0].creditsDelta, 300);

    const duplicateResponse = await fetch(`${baseUrl}/api/sms-credits/orders/${orderId}/capture`, {
      method: 'POST', headers: { cookie }
    });
    const duplicate = await duplicateResponse.json();
    assert.equal(duplicateResponse.status, 200);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.balance, 300);
    assert.equal((await pool.query(
      "SELECT COUNT(*)::int AS count FROM sms_credit_transactions WHERE kind='purchase'"
    )).rows[0].count, 1);

    const otherId = (await pool.query(
      "INSERT INTO organizers (email,name) VALUES ('credit-other@example.test','Credit Other') RETURNING id"
    )).rows[0].id;
    const forbiddenCapture = await fetch(`${baseUrl}/api/sms-credits/orders/${orderId}/capture`, {
      method: 'POST', headers: { cookie: `sge_session=${signSession(otherId)}` }
    });
    assert.equal(forbiddenCapture.status, 404);

    paypal.paypalClient.verifyWebhook = async () => true;
    const refundEvent = {
      id: 'WH-REFUND-12345',
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND123456789',
        amount: { value: '10.00', currency_code: 'USD' },
        supplementary_data: { related_ids: { capture_id: captureId } }
      }
    };
    const refundResponse = await fetch(`${baseUrl}/api/webhooks/paypal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'paypal-transmission-id': 'transmission' },
      body: JSON.stringify(refundEvent)
    });
    assert.equal(refundResponse.status, 200);
    assert.deepEqual(await refundResponse.json(), { received: true });
    assert.equal((await pool.query(
      'SELECT sms_credits FROM organizers WHERE id=$1', [organizerId]
    )).rows[0].sms_credits, 150);

    const repeatedRefund = await fetch(`${baseUrl}/api/webhooks/paypal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(refundEvent)
    });
    assert.equal(repeatedRefund.status, 200);
    assert.equal((await repeatedRefund.json()).duplicate, true);
    assert.equal((await pool.query(
      "SELECT COUNT(*)::int AS count FROM sms_credit_transactions WHERE kind='refund'"
    )).rows[0].count, 1);

    paypal.paypalClient.verifyWebhook = async () => false;
    const rejectedWebhook = await fetch(`${baseUrl}/api/webhooks/paypal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...refundEvent, id: 'WH-INVALID-1234' })
    });
    assert.equal(rejectedWebhook.status, 400);
    assert.equal((await pool.query(
      "SELECT COUNT(*)::int AS count FROM paypal_webhook_events WHERE id='WH-INVALID-1234'"
    )).rows[0].count, 0);
  } finally {
    Object.assign(paypal.paypalClient, originals);
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});

test('Stripe-hosted SMS checkout credits only a verified paid pack and is idempotent', async () => {
  const cookie = `sge_session=${signSession(organizerId)}`;
  const envKeys = [
    'SMS_CREDITS_ENABLED', 'STRIPE_SMS_SECRET_KEY', 'STRIPE_SMS_300_PRICE_ID',
    'STRIPE_SMS_500_PRICE_ID', 'STRIPE_SMS_1000_PRICE_ID', 'STRIPE_SMS_WEBHOOK_SECRET'
  ];
  const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const originals = {
    createCheckoutSession: stripeSms.stripeSmsClient.createCheckoutSession,
    retrieveCheckoutSession: stripeSms.stripeSmsClient.retrieveCheckoutSession,
    constructWebhookEvent: stripeSms.stripeSmsClient.constructWebhookEvent
  };
  const priceIds = {
    starter: 'price_integration300',
    standard: 'price_integration500',
    pro: 'price_integration1000'
  };
  let createdInput = null;
  let authoritativeSession = null;

  try {
    process.env.SMS_CREDITS_ENABLED = 'true';
    process.env.STRIPE_SMS_SECRET_KEY = 'sk_live_integration_sms_key';
    process.env.STRIPE_SMS_300_PRICE_ID = priceIds.starter;
    process.env.STRIPE_SMS_500_PRICE_ID = priceIds.standard;
    process.env.STRIPE_SMS_1000_PRICE_ID = priceIds.pro;
    process.env.STRIPE_SMS_WEBHOOK_SECRET = 'whsec_integration_sms_secret';

    stripeSms.stripeSmsClient.createCheckoutSession = async input => {
      createdInput = input;
      return {
        id: 'cs_live_integration12345678',
        url: 'https://checkout.stripe.com/c/pay/integration'
      };
    };
    stripeSms.stripeSmsClient.constructWebhookEvent = (rawBody, signature) => {
      if (signature !== 'valid-signature') {
        throw new stripeSms.StripeSmsError('Invalid Stripe webhook signature', {
          code: 'stripe_sms_signature_invalid', status: 400
        });
      }
      assert.ok(Buffer.isBuffer(rawBody));
      return JSON.parse(rawBody.toString('utf8'));
    };
    stripeSms.stripeSmsClient.retrieveCheckoutSession = async sessionId => ({
      ...authoritativeSession,
      id: sessionId
    });

    const signedOut = await fetch(`${baseUrl}/api/sms-credits/checkout-sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ packKey: 'standard' })
    });
    assert.equal(signedOut.status, 401);

    const initialResponse = await fetch(`${baseUrl}/api/sms-credits`, { headers: { cookie } });
    const initial = await initialResponse.json();
    assert.equal(initialResponse.status, 200);
    assert.equal(initial.checkoutReady, true);
    assert.equal(initial.environment, 'live');
    assert.equal(JSON.stringify(initial).includes('sk_live_integration_sms_key'), false);
    assert.equal(JSON.stringify(initial).includes(priceIds.standard), false);

    const checkoutResponse = await fetch(`${baseUrl}/api/sms-credits/checkout-sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ packKey: 'standard', amountCents: 1, credits: 999999 })
    });
    assert.equal(checkoutResponse.status, 201);
    assert.deepEqual(await checkoutResponse.json(), {
      checkoutUrl: 'https://checkout.stripe.com/c/pay/integration'
    });
    assert.equal(createdInput.pack.key, 'standard');
    assert.equal(createdInput.pack.credits, 500);
    assert.equal(createdInput.pack.amountCents, 3500);
    assert.equal(createdInput.organizerEmail, 'host@example.test');
    assert.equal(createdInput.successUrl, 'http://127.0.0.1/settings/messaging?checkout=success');
    assert.equal(createdInput.cancelUrl, 'http://127.0.0.1/settings/messaging?checkout=cancelled');

    const purchase = (await pool.query(
      "SELECT * FROM sms_credit_purchases WHERE provider='stripe' AND provider_order_id=$1",
      ['cs_live_integration12345678']
    )).rows[0];
    assert.equal(purchase.organizer_id, organizerId);
    assert.equal(purchase.credits, 500);
    assert.equal(purchase.amount_cents, 3500);

    authoritativeSession = {
      payment_status: 'paid',
      mode: 'payment',
      status: 'complete',
      client_reference_id: purchase.reference,
      payment_intent: 'pi_integration12345678',
      amount_total: 3500,
      currency: 'usd',
      metadata: {
        purchaseId: String(purchase.id),
        purchaseReference: purchase.reference,
        organizerId: String(organizerId),
        packKey: 'standard'
      },
      line_items: { data: [{ quantity: 1, price: { id: priceIds.standard } }] }
    };
    const completedEvent = {
      id: 'evt_integration12345678',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_live_integration12345678' } }
    };
    const sendWebhook = (event, signature = 'valid-signature') => fetch(
      `${baseUrl}/api/webhooks/stripe/sms`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': signature },
        body: JSON.stringify(event)
      }
    );

    const completedResponse = await sendWebhook(completedEvent);
    assert.equal(completedResponse.status, 200);
    assert.deepEqual(await completedResponse.json(), { received: true, ignored: false });
    assert.equal((await pool.query(
      'SELECT sms_credits FROM organizers WHERE id=$1', [organizerId]
    )).rows[0].sms_credits, 500);
    const transaction = (await pool.query(
      "SELECT * FROM sms_credit_transactions WHERE kind='purchase'"
    )).rows[0];
    assert.equal(transaction.provider, 'stripe');
    assert.equal(transaction.credits_delta, 500);
    assert.equal(transaction.amount_cents_delta, 3500);

    const duplicateEventResponse = await sendWebhook(completedEvent);
    assert.equal(duplicateEventResponse.status, 200);
    assert.equal((await duplicateEventResponse.json()).duplicate, true);

    const duplicateSessionResponse = await sendWebhook({
      ...completedEvent, id: 'evt_integration87654321'
    });
    assert.equal(duplicateSessionResponse.status, 200);
    assert.equal((await pool.query(
      "SELECT COUNT(*)::int AS count FROM sms_credit_transactions WHERE kind='purchase'"
    )).rows[0].count, 1);
    assert.equal((await pool.query(
      'SELECT sms_credits FROM organizers WHERE id=$1', [organizerId]
    )).rows[0].sms_credits, 500);

    const invalidSignature = await sendWebhook({
      ...completedEvent, id: 'evt_invalidsig12345678'
    }, 'bad-signature');
    assert.equal(invalidSignature.status, 400);
    assert.equal((await pool.query(
      "SELECT COUNT(*)::int AS count FROM stripe_sms_webhook_events WHERE id='evt_invalidsig12345678'"
    )).rows[0].count, 0);

    authoritativeSession = {
      ...authoritativeSession,
      line_items: { data: [{ quantity: 1, price: { id: 'price_notapproved123' } }] }
    };
    const mismatchedPrice = await sendWebhook({
      ...completedEvent, id: 'evt_badprice123456789'
    });
    assert.equal(mismatchedPrice.status, 500);
    assert.equal((await pool.query(
      'SELECT sms_credits FROM organizers WHERE id=$1', [organizerId]
    )).rows[0].sms_credits, 500);
  } finally {
    Object.assign(stripeSms.stripeSmsClient, originals);
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});
