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
process.env.CLOUDINARY_CLOUD_NAME = 'integration-cloud';
// Most pre-operator regression cases exercise the explicitly controlled
// rollback path. Dedicated-boundary tests below turn this off and prove the
// production default rejects customer/organizer sessions.
process.env.LEGACY_ADMIN_AUTH_ENABLED = 'true';
delete process.env.COMMERCE_API_BASE_URL;
delete process.env.RESEND_API_KEY;
delete process.env.CLOUDINARY_API_KEY;
delete process.env.CLOUDINARY_API_SECRET;

const pool = require('../../src/config/db');
const migrate = require('../../src/db/migrate');
const { app } = require('../../src/index');
const { commerceClient } = require('../../src/lib/commerce-client');
const { hashCode } = require('../../src/lib/secret-show');
const { attendeeAvatar } = require('../../src/lib/private-events');
const { signSession } = require('../../src/lib/session');
const { parseAdminSession } = require('../../src/lib/admin-session');
const {
  AdminEditorWorkspaceError,
  openAdminEditorWorkspace
} = require('../../src/lib/admin-editor-workspace');
const { signIdentityStepUp } = require('../../src/lib/identity-step-up');
const { signPhotoAccess } = require('../../src/lib/photo-access');
const { createGuestInvitation } = require('../../src/lib/guest-invitations');
const sms = require('../../src/lib/sms');
const phoneVerification = require('../../src/lib/phone-verification');
const paypal = require('../../src/lib/paypal');
const stripeSms = require('../../src/lib/stripe-sms');
const { runAutomaticReminderPass } = require('../../src/jobs/sms-notifications');
const { settlePreviousGuestInvitationWork } = require('../../src/jobs/previous-guest-invitations');
const mailer = require('../../src/lib/mailer');
const authRoutes = require('../../src/routes/auth');
const publicRoutes = require('../../src/routes/public');
const adminAccountsRoutes = require('../../src/routes/admin-accounts');
const adminAuthRoutes = require('../../src/routes/admin-auth');
const adminIdentityChangeRoutes = require('../../src/routes/admin-identity-changes');
const adminDoneForYouRoutes = require('../../src/routes/admin-done-for-you');
const adminEditorRoutes = require('../../src/routes/admin-editor');
const uploadRoutes = require('../../src/routes/uploads');
const { outboundDeliveryLockKey } = require('../../src/lib/outbound-account-status');

let server;
let baseUrl;
let organizerId;

// Sign-in links and codes are stored only as hashes, so tests read them the
// way a person would: from the (dev-mode) email.
function lastDevEmail(to, kind) {
  for (let index = mailer.devOutbox.length - 1; index >= 0; index -= 1) {
    const message = mailer.devOutbox[index];
    if (message.to === to && (!kind || message.kind === kind)) return message;
  }
  return assert.fail(`no ${kind || 'email'} captured for ${to}`);
}

function tokenFromLink(link) {
  return new URL(link).searchParams.get('token');
}

// Opening a sign-in link renders a Continue page and must not use it up; the
// Continue button's POST signs in. Returns the POST response.
async function followSignInLink(link, { cookie = '', next = '' } = {}) {
  const token = tokenFromLink(link);
  const view = await fetch(`${baseUrl}/auth/verify?token=${token}${next ? `&next=${encodeURIComponent(next)}` : ''}`, {
    redirect: 'manual', headers: cookie ? { cookie } : {}
  });
  assert.equal(view.status, 200);
  assert.match(await view.text(), /<form method="POST" action="\/auth\/verify">/);
  const form = new URLSearchParams({ token });
  if (next) form.set('next', next);
  return fetch(`${baseUrl}/auth/verify`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: form
  });
}

function resetRateLimits() {
  authRoutes.resetRateLimitsForTests();
  publicRoutes.resetRateLimitsForTests();
  adminAccountsRoutes.resetRateLimitsForTests();
  adminAccountsRoutes.setAccountClaimSenderForTests();
  adminAuthRoutes.resetRateLimitsForTests();
  adminIdentityChangeRoutes.resetRateLimitsForTests();
  adminDoneForYouRoutes.resetRateLimitsForTests();
  adminDoneForYouRoutes.setClaimSenderForTests();
  adminEditorRoutes.setEventUploadsForTests({
    configured: false,
    cover: require('../../src/lib/cloudinary').uploadCover,
    flyer: require('../../src/lib/cloudinary').uploadFlyer,
    vibe: require('../../src/lib/cloudinary').uploadVibePhoto
  });
  uploadRoutes.setAdminHostUploadsForTests();
}

async function resetDatabase() {
  await pool.query('TRUNCATE admin_operators, phone_auth_challenges, stripe_sms_webhook_events, paypal_webhook_events, organizers, users RESTART IDENTITY CASCADE');
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

function responseCookie(response, name) {
  const header = response.headers.get('set-cookie') || '';
  const match = header.match(new RegExp(`(?:^|[,;]\\s*)${name}=([^;,]+)`));
  return match ? `${name}=${match[1]}` : '';
}

function cookieHeader(...cookies) {
  return cookies.filter(Boolean).join('; ');
}

async function signInAccount(email, next = '/settings/account') {
  const started = await fetch(`${baseUrl}/api/auth/magic-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, next })
  });
  assert.equal(started.status, 200);
  const requestCookie = responseCookie(started, 'sge_sign_in');
  assert.ok(requestCookie);
  const { code } = lastDevEmail(email, 'magic_link');
  const completed = await fetch(`${baseUrl}/api/auth/verify-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: requestCookie },
    body: JSON.stringify({ code })
  });
  assert.equal(completed.status, 200);
  return {
    body: await completed.json(),
    sessionCookie: responseCookie(completed, 'sge_session'),
    stepUpCookie: responseCookie(completed, 'sge_identity_step_up')
  };
}

async function createAdminOperator(email, role = 'super_admin', status = 'active') {
  return (await pool.query(
    `INSERT INTO admin_operators (email,role,status)
     VALUES ($1,$2,$3) RETURNING *`,
    [email, role, status]
  )).rows[0];
}

async function addVerifiedEmailIdentity(userId, email, { primary = false, source = 'integration_test' } = {}) {
  const identity = (await pool.query(
    `INSERT INTO user_identities
       (user_id,identity_type,value,normalized_value,verified_at,
        verification_scope,verification_source,is_primary)
     VALUES ($1,'email',$2,$2,NOW(),'account',$3,$4)
     RETURNING id`,
    [userId, email, source, primary]
  )).rows[0];
  await pool.query(
    `INSERT INTO user_identity_verifications
       (user_identity_id,verification_scope,verified_at,verification_source)
     VALUES ($1,'account',NOW(),$2)`,
    [identity.id, source]
  );
  return identity;
}

async function signInAdminOperator(email) {
  const started = await fetch(`${baseUrl}/api/admin/auth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email })
  });
  assert.equal(started.status, 200);
  const requestCookie = responseCookie(started, 'sge_admin_sign_in');
  assert.ok(requestCookie);
  await adminAuthRoutes.settleBackgroundWork();
  const { code } = lastDevEmail(email, 'admin_passcode');
  const completed = await fetch(`${baseUrl}/api/admin/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: requestCookie },
    body: JSON.stringify({ code })
  });
  assert.equal(completed.status, 200);
  const sessionCookie = responseCookie(completed, 'sge_admin_session');
  assert.ok(sessionCookie);
  return sessionCookie;
}

async function adminDeletionProof(sessionCookie, targetUserId) {
  const started = await fetch(`${baseUrl}/api/admin/auth/step-up/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: sessionCookie },
    body: JSON.stringify({ action: 'account_delete', targetUserId })
  });
  assert.equal(started.status, 200);
  const requestCookie = responseCookie(started, 'sge_admin_step_up');
  assert.ok(requestCookie);
  const me = await fetch(`${baseUrl}/api/admin/auth/me`, { headers: { cookie: sessionCookie } });
  const operator = (await me.json()).operator;
  const { code } = lastDevEmail(operator.email, 'admin_passcode');
  const completed = await fetch(`${baseUrl}/api/admin/auth/step-up/complete`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(sessionCookie, requestCookie)
    },
    body: JSON.stringify({ code })
  });
  assert.equal(completed.status, 200);
  const proofCookie = responseCookie(completed, 'sge_admin_action');
  assert.ok(proofCookie);
  return cookieHeader(sessionCookie, proofCookie);
}

async function adminOperatorProof(sessionCookie, targetKey) {
  const started = await fetch(`${baseUrl}/api/admin/auth/step-up/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: sessionCookie },
    body: JSON.stringify({ action: 'operator_manage', targetKey })
  });
  assert.equal(started.status, 200);
  const startedBody = await started.json();
  assert.equal(startedBody.action, 'operator_manage');
  assert.equal(startedBody.targetKey, targetKey);
  const requestCookie = responseCookie(started, 'sge_admin_step_up');
  assert.ok(requestCookie);
  const me = await fetch(`${baseUrl}/api/admin/auth/me`, { headers: { cookie: sessionCookie } });
  assert.equal(me.status, 200);
  const operator = (await me.json()).operator;
  const { code } = lastDevEmail(operator.email, 'admin_passcode');
  const completed = await fetch(`${baseUrl}/api/admin/auth/step-up/complete`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(sessionCookie, requestCookie)
    },
    body: JSON.stringify({ code })
  });
  assert.equal(completed.status, 200);
  const completedBody = await completed.json();
  assert.equal(completedBody.action, 'operator_manage');
  assert.equal(completedBody.targetKey, targetKey);
  assert.equal(completedBody.targetUserId, null);
  const proofCookie = responseCookie(completed, 'sge_admin_action');
  assert.ok(proofCookie);
  return cookieHeader(sessionCookie, proofCookie);
}

async function doneForYouLookup(sessionCookie, { email, phone = null }) {
  return fetch(`${baseUrl}/api/admin/done-for-you/lookup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: sessionCookie },
    body: JSON.stringify({ email, phone })
  });
}

async function provisionDoneForYou(sessionCookie, {
  hostName,
  contactName,
  email,
  phone = null,
  expectedUserId
}) {
  return fetch(`${baseUrl}/api/admin/done-for-you`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: sessionCookie },
    body: JSON.stringify({ hostName, contactName, email, phone, expectedUserId })
  });
}

async function createDoneForYouClient(sessionCookie, input) {
  const lookup = await doneForYouLookup(sessionCookie, input);
  assert.equal(lookup.status, 200);
  const preview = await lookup.json();
  const provisioned = await provisionDoneForYou(sessionCookie, {
    ...input,
    expectedUserId: preview.expectedUserId
  });
  assert.ok([200, 201].includes(provisioned.status));
  return { preview, response: provisioned, client: (await provisioned.json()).client };
}

async function openDoneForYouEditor(sessionCookie, markerId, eventId = null) {
  const response = await fetch(
    `${baseUrl}/api/admin/done-for-you/${markerId}/editor-workspaces`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify(eventId == null ? {} : { eventId })
    }
  );
  assert.equal(response.status, 201);
  const body = await response.json();
  const editorCookie = responseCookie(response, 'sge_admin_editor');
  assert.ok(editorCookie);
  return { response, body, editorCookie };
}

async function waitUntilOutboundLockHeld(userId) {
  const probe = await pool.connect();
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const acquired = (await probe.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
        [outboundDeliveryLockKey(userId)]
      )).rows[0].acquired;
      if (!acquired) return;
      await probe.query(
        'SELECT pg_advisory_unlock(hashtext($1))',
        [outboundDeliveryLockKey(userId)]
      );
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`outbound account lock was not acquired for user ${userId}`);
  } finally {
    probe.release();
  }
}

test.before(async () => {
  await migrate();
  await resetDatabase();
  server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

// A confirmation email from the previous test may still be writing rows; let
// it finish so it can't deadlock with the TRUNCATE.
test.beforeEach(async () => {
  await publicRoutes.settleBackgroundWork();
  await adminAuthRoutes.settleBackgroundWork();
  await settlePreviousGuestInvitationWork();
  await resetDatabase();
});

test.after(async () => {
  await publicRoutes.settleBackgroundWork();
  await adminAuthRoutes.settleBackgroundWork();
  await settlePreviousGuestInvitationWork();
  if (server) await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  await pool.end();
});

test('background confirmation work is tracked so tests can settle it before resetting', async () => {
  const event = await createEvent({ slug: 'settle-background', title: 'Settle Background' });
  const response = await fetch(`${baseUrl}/api/public/events/${event.slug}/rsvp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ full_name: 'Settle Person', email: 'settle@example.test' })
  });
  assert.equal(response.status, 201);
  await publicRoutes.settleBackgroundWork();
  const { rows } = await pool.query(
    `SELECT status FROM message_log WHERE recipient='settle@example.test' AND message_type='rsvp_confirmation'`
  );
  assert.equal(rows[0]?.status, 'sent', 'settling waits for the confirmation to finish');
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
  const createHtml = await createPage.text();
  assert.match(createHtml, /<title>Create Event/);
  assert.match(createHtml, /Start with the essentials/);
  assert.match(createHtml, /id="quick-create-form"/);

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

test('minimal creation makes an owner-only draft without exposing guest actions', async () => {
  const ownerCookie = `sge_session=${signSession(organizerId)}`;
  const response = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: ownerCookie },
    body: JSON.stringify({
      status: 'draft',
      title: 'Private Working Draft',
      event_date: '2030-10-12',
      start_time: '20:00',
      venue_name: 'Draft Hall',
      venue_address: '10 Draft Way',
      presentation_mode: 'standard',
      admission_type: 'free_rsvp'
    })
  });
  assert.equal(response.status, 201);
  const event = (await response.json()).event;
  assert.equal(event.status, 'draft');
  assert.equal(event.visibility, 'public');
  assert.match(event.slug, /^[a-f0-9]{16}$/);

  const anonymous = await fetch(`${baseUrl}/e/${event.slug}`);
  assert.equal(anonymous.status, 404);

  const otherOrganizer = (await pool.query(
    `INSERT INTO organizers (email, name) VALUES ('other-owner@example.test','Other Owner') RETURNING id`
  )).rows[0];
  const wrongOwner = await fetch(`${baseUrl}/e/${event.slug}`, {
    headers: { cookie: `sge_session=${signSession(otherOrganizer.id)}` }
  });
  assert.equal(wrongOwner.status, 404);

  const ownerView = await fetch(`${baseUrl}/e/${event.slug}`, { headers: { cookie: ownerCookie } });
  assert.equal(ownerView.status, 200);
  assert.match(ownerView.headers.get('cache-control'), /private, no-store/);
  assert.match(ownerView.headers.get('x-robots-tag'), /noindex/);
  const ownerHtml = await ownerView.text();
  assert.match(ownerHtml, /Draft preview · Only you can see this/);
  assert.match(ownerHtml, /class="owner-draft-notice"/);
  assert.match(ownerHtml, /"status":"draft"/);
  assert.match(ownerHtml, /"rsvpEnabled":false/);
  assert.doesNotMatch(ownerHtml, /data-open-rsvp/);

  const makePrivate = await fetch(`${baseUrl}/api/events/${event.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: ownerCookie },
    body: JSON.stringify({ visibility: 'private' })
  });
  assert.equal(makePrivate.status, 200);
  const privateDraft = (await makePrivate.json()).event;
  assert.equal(privateDraft.visibility, 'private');
  assert.equal(privateDraft.slug, event.slug);

  const wrongPublisher = await fetch(`${baseUrl}/api/events/${event.id}/publish`, {
    method: 'POST', headers: { cookie: `sge_session=${signSession(otherOrganizer.id)}` }
  });
  assert.equal(wrongPublisher.status, 404);

  const publish = await fetch(`${baseUrl}/api/events/${event.id}/publish`, {
    method: 'POST', headers: { cookie: ownerCookie }
  });
  assert.equal(publish.status, 200);
  assert.equal((await publish.json()).event.status, 'published');

  const publishedPage = await fetch(`${baseUrl}/e/${event.slug}`);
  assert.equal(publishedPage.status, 200);
  assert.match(await publishedPage.text(), /data-open-rsvp/);

  const publishAgain = await fetch(`${baseUrl}/api/events/${event.id}/publish`, {
    method: 'POST', headers: { cookie: ownerCookie }
  });
  assert.equal(publishAgain.status, 200);
  assert.equal((await publishAgain.json()).alreadyPublished, true);
});

test('keeps first-RSVP persistence without using its browser cookie as event-page identity', async () => {
  const firstEvent = await createEvent({ slug: 'lucas-first-night', title: 'Lucas First Night' });
  const nextEvent = await createEvent({ slug: 'lucas-next-night', title: 'Lucas Next Night' });
  const protectedEvent = await createEvent({ slug: 'lucas-protected-night', title: 'Lucas Protected Night' });

  const firstRsvp = await fetch(`${baseUrl}/api/public/events/${firstEvent.slug}/rsvp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ full_name: 'Lucas Moon', email: 'lucas@example.test' })
  });
  assert.equal(firstRsvp.status, 201);
  const firstRsvpResult = await firstRsvp.json();
  assert.equal(firstRsvpResult.response, 'going');
  assert.match(firstRsvpResult.rsvpToken, /^[a-f0-9]{32}$/);
  assert.equal(firstRsvpResult.calendarUrl, `/r/${firstRsvpResult.rsvpToken}/calendar.ics`);
  assert.match(firstRsvp.headers.get('cache-control') || '', /private, no-store/);
  const guestCookie = responseCookie(firstRsvp, 'sge_guest');
  assert.match(guestCookie, /^sge_guest=/);
  assert.doesNotMatch(firstRsvp.headers.get('set-cookie') || '', /sge_session=/);
  await waitForConfirmation('lucas@example.test');

  const stored = (await pool.query(
    `SELECT r.account_id,r.user_id AS rsvp_user_id,r.guest_session_id,
            gs.identity_id,gs.user_id AS session_user_id,gs.verified_at
       FROM rsvps r JOIN guest_sessions gs ON gs.id=r.guest_session_id
      WHERE r.event_id=$1`,
    [firstEvent.id]
  )).rows[0];
  assert.equal(stored.account_id, null);
  assert.ok(stored.guest_session_id);
  assert.equal(stored.verified_at, null);
  const provisionalIdentity = (await pool.query(
    `SELECT o.user_id,u.id AS canonical_user_id,ui.verification_scope,ui.verified_at
       FROM organizers o
       JOIN users u ON u.id=o.user_id
       JOIN user_identities ui ON ui.user_id=u.id
      WHERE LOWER(BTRIM(o.email))='lucas@example.test'
        AND ui.identity_type='email' AND ui.revoked_at IS NULL`
  )).rows[0];
  assert.equal(Number(provisionalIdentity.user_id), Number(provisionalIdentity.canonical_user_id));
  assert.equal(Number(stored.rsvp_user_id), Number(provisionalIdentity.canonical_user_id));
  assert.equal(Number(stored.session_user_id), Number(provisionalIdentity.canonical_user_id));
  const confirmationRecipient = (await pool.query(
    `SELECT recipient_user_id FROM message_log
      WHERE event_id=$1 AND message_type='rsvp_confirmation'
      ORDER BY id DESC LIMIT 1`,
    [firstEvent.id]
  )).rows[0];
  assert.equal(Number(confirmationRecipient.recipient_user_id), Number(provisionalIdentity.canonical_user_id));
  assert.equal(provisionalIdentity.verification_scope, 'unverified');
  assert.equal(provisionalIdentity.verified_at, null,
    'submitting an RSVP creates a reusable person record without granting account-level email proof');

  // The RSVP response supplies its event-scoped personal URL proof immediately,
  // so the same confirmation can be reopened on a browser with no cookies.
  const personalConfirmation = await fetch(
    `${baseUrl}/e/${firstEvent.slug}?rsvp=${encodeURIComponent(firstRsvpResult.rsvpToken)}`
  );
  assert.match(personalConfirmation.headers.get('cache-control') || '', /private, no-store/);
  assert.match(await personalConfirmation.text(),
    new RegExp(`"returningGuest":\\{"firstName":"Lucas","source":"rsvp","response":"going","calendarUrl":"\\/r\\/${firstRsvpResult.rsvpToken}\\/calendar\\.ics"\\}`));

  const changedFromOtherDevice = await fetch(`${baseUrl}/api/public/events/${firstEvent.slug}/returning-rsvp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response: 'not_going', rsvpToken: firstRsvpResult.rsvpToken })
  });
  assert.equal(changedFromOtherDevice.status, 200);
  assert.equal((await changedFromOtherDevice.json()).response, 'not_going');

  const returningPage = await fetch(`${baseUrl}/e/${nextEvent.slug}`, { headers: { cookie: guestCookie } });
  assert.match(await returningPage.text(), /"returningGuest":null/);

  const cookieOnlyAnswer = await fetch(`${baseUrl}/api/public/events/${nextEvent.slug}/returning-rsvp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: guestCookie },
    body: JSON.stringify({ response: 'going' })
  });
  assert.equal(cookieOnlyAnswer.status, 401);
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM rsvps WHERE event_id=$1', [nextEvent.id]
  )).rows[0].count, 0);

  await createRsvp(protectedEvent.id, {
    first_name: 'Real', last_name: 'Lucas', email: 'lucas@example.test', status: 'confirmed'
  });
  const blocked = await fetch(`${baseUrl}/api/public/events/${protectedEvent.slug}/returning-rsvp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: guestCookie },
    body: JSON.stringify({ response: 'not_going' })
  });
  assert.equal(blocked.status, 401);
  assert.equal((await pool.query(
    'SELECT status FROM rsvps WHERE event_id=$1 AND email=$2',
    [protectedEvent.id, 'lucas@example.test']
  )).rows[0].status, 'confirmed');

  const guestStatus = await fetch(`${baseUrl}/api/public/guest-session`, { headers: { cookie: guestCookie } });
  assert.deepEqual(await guestStatus.json(), {
    recognized: true,
    firstName: 'Lucas',
    maskedEmail: 'l•••@example.test',
    verified: false
  });
  const creatorLink = await fetch(`${baseUrl}/api/auth/guest-magic-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: guestCookie },
    body: JSON.stringify({ next: '/events/new' })
  });
  assert.equal(creatorLink.status, 200);
  assert.equal((await pool.query(
    `SELECT return_path FROM magic_link_tokens
      WHERE email='lucas@example.test' AND expires_at<NOW() + INTERVAL '1 day'
      ORDER BY id DESC LIMIT 1`
  )).rows[0].return_path, '/events/new');
});

test('personal Familiar Faces links are permanent, cross-device, and link a matching RSVP', async () => {
  const source = await createEvent({ slug: 'invite-source', title: 'Invite Source' });
  const target = await createEvent({ slug: 'invite-target', title: 'Invite Target' });
  const person = await createRsvp(source.id, {
    first_name: 'Maya', last_name: 'Lopez', email: 'maya-personal@example.test'
  });
  const identity = (await pool.query(
    `INSERT INTO organizers (email,name)
     VALUES ('maya-personal@example.test','Maya Lopez') RETURNING id`
  )).rows[0];
  identity.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [identity.id]
  )).rows[0].user_id;
  const message = (await pool.query(
    `INSERT INTO message_log
       (event_id,rsvp_id,recipient,recipient_name,message_type,channel,status)
     VALUES ($1,$2,'maya-personal@example.test','Maya Lopez','previous_guest_invite','email','sent')
     RETURNING id`,
    [target.id, person.id]
  )).rows[0];
  const invitation = await createGuestInvitation(pool, {
    messageLogId: message.id,
    eventId: target.id,
    eventDate: target.event_date,
    email: 'maya-personal@example.test',
    recipientName: 'Maya Lopez'
  });
  assert.equal(invitation.identity.id, identity.id);
  await pool.query(
    `UPDATE guest_invitation_tokens SET expires_at=NOW() - INTERVAL '1 day' WHERE message_log_id=$1`,
    [message.id]
  );

  const opened = await fetch(`${baseUrl}/g/${invitation.token}`, { redirect: 'manual' });
  assert.equal(opened.status, 303);
  const personalLocation = `/e/invite-target?invite=${encodeURIComponent(invitation.token)}`;
  assert.equal(opened.headers.get('location'), personalLocation);
  assert.doesNotMatch(opened.headers.get('set-cookie') || '', /sge_session=[^;]/,
    'an event invitation remains event-scoped');
  assert.equal(responseCookie(opened, 'sge_guest'), '');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM rsvps WHERE event_id=$1', [target.id])).rows[0].count, 0);
  assert.ok((await pool.query('SELECT opened_at FROM guest_invitation_tokens WHERE message_log_id=$1', [message.id])).rows[0].opened_at);

  const page = await fetch(`${baseUrl}${personalLocation}`);
  assert.match(await page.text(), /"returningGuest":null/);
  const answer = await fetch(`${baseUrl}/api/public/events/${target.slug}/rsvp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      full_name: 'Maya Lopez',
      email: 'maya-personal@example.test',
      inviteToken: invitation.token
    })
  });
  assert.equal(answer.status, 201);
  const linked = (await pool.query(
    `SELECT r.status,r.account_id,r.user_id AS rsvp_user_id,
            t.user_id AS invitation_user_id,t.response,t.responded_at,
            ml.recipient_user_id
       FROM rsvps r
       JOIN guest_invitation_tokens t ON t.rsvp_id=r.id
       JOIN message_log ml ON ml.id=t.message_log_id
      WHERE r.event_id=$1`,
    [target.id]
  )).rows[0];
  assert.equal(linked.status, 'confirmed');
  assert.equal(linked.account_id, identity.id);
  assert.equal(Number(linked.rsvp_user_id), Number(identity.user_id));
  assert.equal(Number(linked.invitation_user_id), Number(identity.user_id));
  assert.equal(Number(linked.recipient_user_id), Number(identity.user_id));
  assert.equal(linked.response, 'going');
  assert.ok(linked.responded_at);

  // The token, not a cookie, recognizes the same answer on another device.
  const otherDevice = await (await fetch(`${baseUrl}${personalLocation}`)).text();
  assert.match(otherDevice, /"returningGuest":\{"firstName":"Maya","source":"invitation","response":"going","calendarUrl":"\/r\/[a-f0-9]+\/calendar\.ics"\}/);
  const changed = await fetch(`${baseUrl}/api/public/events/${target.slug}/returning-rsvp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response: 'not_going', inviteToken: invitation.token })
  });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).response, 'not_going');

  await pool.query(
    'UPDATE guest_invitation_tokens SET revoked_at=NOW() WHERE message_log_id=$1', [message.id]
  );
  assert.equal((await fetch(`${baseUrl}/g/${invitation.token}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}${personalLocation}`)).status, 404);
});

test('a changed-email invitation reuses its canonical RSVP instead of creating a duplicate', async () => {
  const event = await createEvent({ slug: 'canonical-rsvp-alias', title: 'Canonical RSVP Alias' });
  const account = (await pool.query(
    `INSERT INTO organizers (email,name)
     VALUES ('canonical-new@example.test','Canonical Guest') RETURNING id`
  )).rows[0];
  const userId = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [account.id]
  )).rows[0].user_id;
  const existing = await createRsvp(event.id, {
    first_name: 'Canonical', last_name: 'Guest', email: 'canonical-old@example.test',
    account_id: null, user_id: userId
  });
  const message = (await pool.query(
    `INSERT INTO message_log
       (event_id,recipient,recipient_name,recipient_user_id,message_type,channel,status)
     VALUES ($1,'canonical-new@example.test','Canonical Guest',$2,'previous_guest_invite','email','sent')
     RETURNING id`,
    [event.id, userId]
  )).rows[0];
  const invitation = await createGuestInvitation(pool, {
    messageLogId: message.id,
    eventId: event.id,
    eventDate: event.event_date,
    email: 'canonical-new@example.test',
    recipientName: 'Canonical Guest'
  });

  const response = await fetch(`${baseUrl}/api/public/events/${event.slug}/rsvp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      full_name: 'Canonical Guest',
      email: 'canonical-new@example.test',
      inviteToken: invitation.token
    })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).alreadyRsvpd, true);
  const rows = (await pool.query(
    `SELECT r.id,r.account_id,r.user_id,t.rsvp_id
       FROM rsvps r
       JOIN guest_invitation_tokens t ON t.message_log_id=$2
      WHERE r.event_id=$1`,
    [event.id, message.id]
  )).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, existing.id);
  assert.equal(Number(rows[0].account_id), Number(account.id));
  assert.equal(Number(rows[0].user_id), Number(userId));
  assert.equal(rows[0].rsvp_id, existing.id);
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
    assert.equal(oneTap.headers.get('location'), `/e/${event.slug}?rsvp=${recipient.manage_token}`);
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

test('an event owner keeps the live editor while their own confirmed RSVP is recognized', async () => {
  const event = await createEvent({ slug: 'owner-rsvp-night', title: 'Owner RSVP Night' });
  await createRsvp(event.id, {
    first_name: 'Test',
    last_name: 'Host',
    email: 'host@example.test',
    account_id: organizerId,
    manage_token: 'owner-rsvp-token'
  });

  const page = await fetch(`${baseUrl}/e/${event.slug}`, {
    headers: { cookie: `sge_session=${signSession(organizerId)}` }
  });
  const html = await page.text();

  assert.equal(page.status, 200);
  assert.match(page.headers.get('cache-control') || '', /private, no-store/);
  assert.match(html, /id="owner-edit-trigger"/);
  assert.match(html, /id="owner-editor"/);
  assert.match(html, /"returningGuest":\{"firstName":"Test","source":"account","response":"going","calendarUrl":"\/r\/owner-rsvp-token\/calendar\.ics"\}/);
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
    user: { id: accountId, email: 'avatar@example.test', name: 'Avatar Person', avatarUrl },
    scope: 'account'
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
  assert.match(duplicateEvent.slug, /^[a-f0-9]{16}$/);

  const privateDuplicateResponse = await fetch(`${baseUrl}/api/events/${duplicateEvent.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: organizerCookie },
    body: JSON.stringify({ visibility: 'private' })
  });
  assert.equal(privateDuplicateResponse.status, 200);
  const privateDuplicate = (await privateDuplicateResponse.json()).event;
  assert.equal(privateDuplicate.visibility, 'private');
  assert.equal(privateDuplicate.slug, duplicateEvent.slug);
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
  assert.deepEqual(await signedInFollow.json(), {
    following: true, emailOn: true, textOn: false, smsAvailable: false, phoneLast4: null
  });
  const canonicalFollow = (await pool.query(
    `SELECT follow.follower_user_id, follower.user_id
       FROM host_follows follow
       JOIN organizers follower ON follower.id=follow.follower_organizer_id
      WHERE follow.follower_organizer_id=$1 AND follow.host_organizer_id=$2`,
    [organizerId, secondHostId]
  )).rows[0];
  assert.equal(Number(canonicalFollow.follower_user_id), Number(canonicalFollow.user_id));
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
  assert.deepEqual(await unfollow.json(), {
    following: false, emailOn: false, textOn: false, smsAvailable: false, phoneLast4: null
  });
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
  assert.equal(pending.return_path, '/h/test-host?followed=1');
  const followEmail = lastDevEmail('new-follower@example.test', 'magic_link');
  assert.notEqual(pending.token, tokenFromLink(followEmail.link), 'only a hash of the link token is stored');

  const verify = await followSignInLink(followEmail.link, { next: '/dashboard' });
  assert.equal(verify.status, 303);
  assert.equal(verify.headers.get('location'), '/h/test-host?followed=1', 'stored intent return must win over URL tampering');
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
  const followerIdentity = (await pool.query(
    `SELECT u.id,ui.verification_scope,ui.verified_at
       FROM users u
       JOIN user_identities ui ON ui.user_id=u.id
      WHERE u.id=$1 AND ui.identity_type='email' AND ui.normalized_value=$2
        AND ui.revoked_at IS NULL`,
    [follower.id, 'new-follower@example.test']
  )).rows[0];
  assert.equal(Number(followerIdentity.id), Number(follower.id));
  assert.equal(followerIdentity.verification_scope, 'account');
  assert.ok(followerIdentity.verified_at);

  // A first-time RSVP still creates only a lightweight remembered guest. If
  // that person later follows a Host, the server uses the remembered email,
  // the typed code completes the pending follow, and the browser becomes
  // globally signed in without asking for the email again.
  const rememberedEvent = await createEvent({
    slug: 'remembered-follower-first-rsvp', title: 'Remembered Follower First RSVP'
  });
  const rememberedRsvp = await fetch(`${baseUrl}/api/public/events/${rememberedEvent.slug}/rsvp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ full_name: 'Riley Remembered', email: 'riley-remembered@example.test' })
  });
  assert.equal(rememberedRsvp.status, 201);
  const rememberedGuestCookie = responseCookie(rememberedRsvp, 'sge_guest');
  assert.ok(rememberedGuestCookie);
  assert.doesNotMatch(rememberedRsvp.headers.get('set-cookie') || '', /sge_session=[^;]/);

  const rememberedFollowRequest = await fetch(`${baseUrl}/api/auth/guest-magic-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: rememberedGuestCookie },
    body: JSON.stringify({
      email: 'ignored-attacker@example.test', intent: 'follow_host', host_slug: 'second-host'
    })
  });
  assert.equal(rememberedFollowRequest.status, 200);
  const rememberedChallenge = (await pool.query(
    `SELECT email,intent,target_organizer_id,return_path
       FROM magic_link_tokens
      WHERE email='riley-remembered@example.test' AND intent='follow_host'
      ORDER BY id DESC LIMIT 1`
  )).rows[0];
  assert.deepEqual(rememberedChallenge, {
    email: 'riley-remembered@example.test',
    intent: 'follow_host',
    target_organizer_id: secondHostId,
    return_path: '/h/second-host?followed=1'
  });
  const rememberedRequestCookie = responseCookie(rememberedFollowRequest, 'sge_sign_in');
  const rememberedCode = lastDevEmail('riley-remembered@example.test', 'magic_link').code;
  const rememberedVerified = await fetch(`${baseUrl}/api/auth/verify-code`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `${rememberedGuestCookie}; ${rememberedRequestCookie}`
    },
    body: JSON.stringify({ code: rememberedCode })
  });
  assert.equal(rememberedVerified.status, 200);
  assert.equal((await rememberedVerified.json()).redirect, '/h/second-host?followed=1');
  const rememberedAccountCookie = responseCookie(rememberedVerified, 'sge_session');
  assert.ok(rememberedAccountCookie);
  const rememberedIdentity = (await pool.query(
    `SELECT id FROM organizers WHERE email='riley-remembered@example.test'`
  )).rows[0];
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM organizers WHERE LOWER(email)=LOWER('riley-remembered@example.test')`
  )).rows[0].count, 1, 'verification reuses the RSVP identity');
  assert.equal(Number((await pool.query(
    `SELECT account_id FROM rsvps WHERE event_id=$1 AND email='riley-remembered@example.test'`,
    [rememberedEvent.id]
  )).rows[0].account_id), Number(rememberedIdentity.id), 'the verified identity retains its RSVP history');
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM host_follows
      WHERE follower_organizer_id=$1 AND host_organizer_id=$2 AND unsubscribed_at IS NULL`,
    [rememberedIdentity.id, secondHostId]
  )).rows[0].count, 1);
  const rememberedHostPage = await fetch(`${baseUrl}/h/second-host`, {
    headers: { cookie: rememberedAccountCookie }
  });
  assert.match(await rememberedHostPage.text(), /data-following="true"/);
});

test('Follow includes email, offers optional paid texts, and sends one audited host update', async () => {
  await pool.query('UPDATE organizers SET sms_credits=10 WHERE id=$1', [organizerId]);
  const follower = (await pool.query(
    `INSERT INTO organizers (email,name)
     VALUES ('follow-updates@example.test','Follow Updates') RETURNING id`
  )).rows[0];
  const followerUserId = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [follower.id]
  )).rows[0].user_id;
  const earlierEvent = await createEvent({
    slug: 'follow-update-history', title: 'Follow Update History', event_date: '2020-04-04'
  });
  await createRsvp(earlierEvent.id, {
    first_name: 'Follow', last_name: 'Updates', email: 'follow-updates-old@example.test',
    organizer_optin: true, user_id: followerUserId
  });
  const followerCookie = `sge_session=${signSession(follower.id)}`;
  const followed = await fetch(`${baseUrl}/api/hosts/test-host/follow`, {
    method: 'POST', headers: { cookie: followerCookie }
  });
  assert.deepEqual(await followed.json(), {
    following: true, emailOn: true, textOn: false, smsAvailable: true, phoneLast4: null
  });
  const textOptIn = await fetch(`${baseUrl}/api/hosts/test-host/follow/texts`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: followerCookie },
    body: JSON.stringify({ phone: '(415) 555-0199' })
  });
  assert.deepEqual(await textOptIn.json(), {
    following: true, emailOn: true, textOn: true, smsAvailable: true, phoneLast4: '0199'
  });
  const consent = (await pool.query(
    `SELECT email_consent_version,sms_phone,sms_consent_version,sms_consent_text
       FROM host_follows WHERE follower_organizer_id=$1 AND host_organizer_id=$2`,
    [follower.id, organizerId]
  )).rows[0];
  assert.equal(consent.email_consent_version, 'host_follow_email_v1');
  assert.equal(consent.sms_phone, '+14155550199');
  assert.equal(consent.sms_consent_version, 'host_follow_sms_v1');
  assert.match(consent.sms_consent_text, /Reply STOP to opt out/);

  const event = await createEvent({ slug: 'follow-update-night', title: 'Follow Update Night' });
  const hostCookie = `sge_session=${signSession(organizerId)}`;
  const previewResponse = await fetch(`${baseUrl}/api/events/${event.id}/followers`, {
    headers: { cookie: hostCookie }
  });
  const preview = await previewResponse.json();
  assert.equal(previewResponse.status, 200);
  assert.equal(preview.count, 1, 'one person receiving two channels is counted once');
  assert.equal(preview.emailCount, 1);
  assert.equal(preview.textCount, 1);
  assert.equal(preview.canIncludeTexts, true);
  assert.ok(preview.textCreditCost >= preview.textCount, 'the preview charges at least one segment per text');

  const originalSendSms = sms.sendSms;
  const sends = [];
  sms.sendSms = async payload => {
    sends.push(payload);
    return { sid: `SM${'f'.repeat(32)}`, status: 'accepted', recipient: payload.to };
  };
  try {
    const send = await fetch(`${baseUrl}/api/events/${event.id}/announce`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: hostCookie },
      body: JSON.stringify({
        confirm: 'SEND_FOLLOWER_UPDATE', includeTexts: true, fingerprint: preview.fingerprint
      })
    });
    const result = await send.json();
    assert.equal(send.status, 200);
    assert.deepEqual(result, { sent: 1, total: 1, textsQueued: 1 });
    const batch = (await pool.query(
      `SELECT * FROM sms_notification_batches
        WHERE event_id=$1 AND kind='follower_announcement'`, [event.id]
    )).rows[0];
    await waitForSmsBatch(batch.id);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].to, '+14155550199');
    assert.match(sends[0].body, /^Test Host: New event - Follow Update Night/);
    assert.match(sends[0].body, /Reply STOP to opt out\.$/);
    const delivery = (await pool.query(
      'SELECT host_follow_id,rsvp_id FROM sms_notification_recipients WHERE batch_id=$1', [batch.id]
    )).rows[0];
    assert.ok(delivery.host_follow_id);
    assert.equal(delivery.rsvp_id, null);
    const announcementLogs = (await pool.query(
      `SELECT recipient,recipient_user_id FROM message_log
        WHERE event_id=$1 AND message_type='announcement' AND status='sent'`, [event.id]
    )).rows;
    assert.deepEqual(announcementLogs.map(row => row.recipient), ['follow-updates@example.test']);
    assert.equal(Number(announcementLogs[0].recipient_user_id), Number(followerUserId));
  } finally {
    sms.sendSms = originalSendSms;
  }

  const stopped = await fetch(`${baseUrl}/api/webhooks/twilio/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: '+14155550199', Body: 'STOP' })
  });
  assert.equal(stopped.status, 200);
  assert.ok((await pool.query(
    'SELECT sms_opted_out_at FROM host_follows WHERE follower_organizer_id=$1 AND host_organizer_id=$2',
    [follower.id, organizerId]
  )).rows[0].sms_opted_out_at instanceof Date);

  const unfollowed = await fetch(`${baseUrl}/api/hosts/test-host/follow`, {
    method: 'DELETE', headers: { cookie: followerCookie }
  });
  assert.deepEqual(await unfollowed.json(), {
    following: false, emailOn: false, textOn: false, smsAvailable: true, phoneLast4: '0199'
  });
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM follower_optouts
      WHERE organizer_id=$1 AND email='follow-updates@example.test'`, [organizerId]
  )).rows[0].count, 1, 'unfollow also suppresses older RSVP-based host updates');
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
  const verify = await followSignInLink(lastDevEmail('creator-flow@example.test', 'magic_link').link);
  assert.equal(verify.status, 303);
  assert.equal(verify.headers.get('location'), '/events/new');
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM host_follows hf
      JOIN organizers o ON o.id=hf.follower_organizer_id
     WHERE o.email='creator-flow@example.test'`
  )).rows[0].count, 0);
});

test('host invitation onboarding preserves context through email auth and claims only on its authenticated POST', async () => {
  resetRateLimits();
  const token = 'heat-34b8bbbbb785ec87';
  const personalNote = 'Chosen for the <script>alert("private")</script> community you built.';
  await pool.query(
    `INSERT INTO host_invitations (token,host_name,personal_note)
     VALUES ($1,'Heat',$2)`,
    [token, personalNote]
  );

  const landing = await fetch(`${baseUrl}/i/${token}`);
  assert.equal(landing.status, 200);
  assert.match(landing.headers.get('cache-control') || '', /private, no-store/);
  assert.equal(landing.headers.get('referrer-policy'), 'no-referrer');
  assert.match(landing.headers.get('x-robots-tag') || '', /noindex/);
  const landingHtml = await landing.text();
  assert.match(landingHtml, /Accept invitation/);
  assert.match(landingHtml, /Publish unique event pages and collect RSVPs\./);
  assert.match(landingHtml, /href="\/login\?next=%2Fhost-invitation%2Fheat-34b8bbbbb785ec87"/);
  assert.match(landingHtml, /&lt;script&gt;alert\(&quot;private&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(landingHtml, /<script>alert\("private"\)<\/script>/);
  assert.deepEqual((await pool.query(
    'SELECT joined_organizer_id,joined_at FROM host_invitations WHERE token=$1',
    [token]
  )).rows[0], { joined_organizer_id: null, joined_at: null });

  const publicContext = await fetch(`${baseUrl}/api/public/host-invitations/${token}`);
  assert.equal(publicContext.status, 200);
  assert.match(publicContext.headers.get('cache-control') || '', /private, no-store/);
  assert.equal(publicContext.headers.get('referrer-policy'), 'no-referrer');
  assert.match(publicContext.headers.get('x-robots-tag') || '', /noindex/);
  assert.equal((await publicContext.json()).invitation.hostName, 'Heat');
  assert.equal((await pool.query(
    'SELECT joined_organizer_id FROM host_invitations WHERE token=$1', [token]
  )).rows[0].joined_organizer_id, null, 'the public context endpoint is read-only');

  const signedOutOnboarding = await fetch(`${baseUrl}/host-invitation/${token}`, { redirect: 'manual' });
  assert.equal(signedOutOnboarding.status, 302);
  assert.equal(
    signedOutOnboarding.headers.get('location'),
    `/login?next=${encodeURIComponent(`/host-invitation/${token}`)}`
  );
  assert.match(signedOutOnboarding.headers.get('cache-control') || '', /private, no-store/);
  assert.equal((await pool.query(
    'SELECT joined_organizer_id FROM host_invitations WHERE token=$1', [token]
  )).rows[0].joined_organizer_id, null, 'opening onboarding before login does not accept it');

  const existingHostCookie = `sge_session=${signSession(organizerId)}`;
  const signedInOnboarding = await fetch(`${baseUrl}/host-invitation/${token}`, {
    headers: { cookie: existingHostCookie }
  });
  assert.equal(signedInOnboarding.status, 200);
  assert.match(await signedInOnboarding.text(), /id="welcome-panel"/);
  const signedInState = await fetch(`${baseUrl}/api/host-invitations/${token}`, {
    headers: { cookie: existingHostCookie }
  });
  assert.equal(signedInState.status, 200);
  assert.equal((await pool.query(
    'SELECT joined_organizer_id FROM host_invitations WHERE token=$1', [token]
  )).rows[0].joined_organizer_id, null, 'authenticated reads remain read-only');
  assert.equal((await fetch(`${baseUrl}/api/host-invitations/${token}/accept`, {
    headers: { cookie: existingHostCookie }
  })).status, 404, 'acceptance is not exposed as a GET');

  const crossOrigin = await fetch(`${baseUrl}/api/host-invitations/${token}/accept`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: existingHostCookie,
      origin: 'https://attacker.example',
      'sec-fetch-site': 'cross-site'
    },
    body: '{}'
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await pool.query(
    'SELECT joined_organizer_id FROM host_invitations WHERE token=$1', [token]
  )).rows[0].joined_organizer_id, null, 'a cross-origin request cannot claim the invitation');

  const invitedEmail = 'heat-invitation@example.test';
  const nextPath = `/host-invitation/${token}`;
  const signInStart = await fetch(`${baseUrl}/api/auth/magic-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: invitedEmail, next: nextPath })
  });
  assert.equal(signInStart.status, 200);
  assert.equal((await pool.query(
    `SELECT return_path FROM magic_link_tokens
      WHERE email=$1 ORDER BY id DESC LIMIT 1`,
    [invitedEmail]
  )).rows[0].return_path, nextPath);
  const completedSignIn = await followSignInLink(lastDevEmail(invitedEmail, 'magic_link').link);
  assert.equal(completedSignIn.status, 303);
  assert.equal(completedSignIn.headers.get('location'), nextPath);
  const invitedCookie = responseCookie(completedSignIn, 'sge_session');
  assert.ok(invitedCookie);
  const invitedAccount = (await pool.query(
    'SELECT id FROM organizers WHERE LOWER(email)=LOWER($1)', [invitedEmail]
  )).rows[0];
  assert.ok(invitedAccount);

  const acceptHeaders = {
    'content-type': 'application/json',
    cookie: invitedCookie,
    origin: baseUrl,
    'sec-fetch-site': 'same-origin'
  };
  const accepted = await fetch(`${baseUrl}/api/host-invitations/${token}/accept`, {
    method: 'POST', headers: acceptHeaders, body: '{}'
  });
  assert.equal(accepted.status, 200);
  const firstClaim = (await pool.query(
    'SELECT joined_organizer_id,joined_at FROM host_invitations WHERE token=$1', [token]
  )).rows[0];
  assert.equal(Number(firstClaim.joined_organizer_id), Number(invitedAccount.id));
  assert.ok(firstClaim.joined_at instanceof Date);

  const acceptedAgain = await fetch(`${baseUrl}/api/host-invitations/${token}/accept`, {
    method: 'POST', headers: acceptHeaders, body: '{}'
  });
  assert.equal(acceptedAgain.status, 200);
  const idempotentClaim = (await pool.query(
    'SELECT joined_organizer_id,joined_at FROM host_invitations WHERE token=$1', [token]
  )).rows[0];
  assert.equal(Number(idempotentClaim.joined_organizer_id), Number(invitedAccount.id));
  assert.equal(idempotentClaim.joined_at.getTime(), firstClaim.joined_at.getTime());

  const otherAccount = await fetch(`${baseUrl}/api/host-invitations/${token}/accept`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: existingHostCookie,
      origin: baseUrl,
      'sec-fetch-site': 'same-origin'
    },
    body: '{}'
  });
  assert.equal(otherAccount.status, 409);
  assert.equal(Number((await pool.query(
    'SELECT joined_organizer_id FROM host_invitations WHERE token=$1', [token]
  )).rows[0].joined_organizer_id), Number(invitedAccount.id));

  const legacyToken = 'legacy-host-1234567890';
  await pool.query(
    `INSERT INTO host_invitations (token,host_name,personal_note)
     VALUES ($1,'Legacy Host','This invitation must remain unclaimed on a legacy GET.')`,
    [legacyToken]
  );
  const signedOutLegacy = await fetch(`${baseUrl}/events/new?invite=${legacyToken}`, {
    redirect: 'manual'
  });
  assert.equal(signedOutLegacy.status, 302);
  assert.equal(signedOutLegacy.headers.get('location'), `/host-invitation/${legacyToken}`);
  assert.equal((await pool.query(
    'SELECT joined_organizer_id FROM host_invitations WHERE token=$1', [legacyToken]
  )).rows[0].joined_organizer_id, null, 'a signed-out legacy GET preserves context without claiming');

  const legacy = await fetch(`${baseUrl}/events/new?invite=${legacyToken}`, {
    redirect: 'manual', headers: { cookie: existingHostCookie }
  });
  assert.equal(legacy.status, 302);
  assert.equal(legacy.headers.get('location'), `/host-invitation/${legacyToken}`);
  assert.equal((await pool.query(
    'SELECT joined_organizer_id FROM host_invitations WHERE token=$1', [legacyToken]
  )).rows[0].joined_organizer_id, null, 'the legacy compatibility redirect never claims an invitation');
});

test('host invitation onboarding handles revoked and missing links without mutating account ownership', async () => {
  const revokedToken = 'revoked-host-123456789';
  const missingToken = 'missing-host-123456789';
  await pool.query(
    `INSERT INTO host_invitations (token,host_name,personal_note,revoked_at)
     VALUES ($1,'Revoked Host','This invitation was intentionally revoked.',NOW())`,
    [revokedToken]
  );
  const cookie = `sge_session=${signSession(organizerId)}`;

  for (const path of [
    `/i/${revokedToken}`,
    `/i/${missingToken}`,
    '/i/INVALID'
  ]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('cache-control') || '', /private, no-store/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('x-robots-tag') || '', /noindex/);
  }
  assert.equal((await fetch(`${baseUrl}/host-invitation/${revokedToken}`)).status, 410);
  assert.equal((await fetch(`${baseUrl}/host-invitation/${missingToken}`)).status, 404);

  for (const [path, expected] of [
    [`/api/public/host-invitations/${revokedToken}`, 410],
    [`/api/public/host-invitations/${missingToken}`, 404]
  ]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, expected);
    assert.match(response.headers.get('cache-control') || '', /private, no-store/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }

  for (const [token, expected] of [[revokedToken, 410], [missingToken, 404]]) {
    const state = await fetch(`${baseUrl}/api/host-invitations/${token}`, {
      headers: { cookie }
    });
    assert.equal(state.status, expected);
    const accept = await fetch(`${baseUrl}/api/host-invitations/${token}/accept`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: baseUrl,
        'sec-fetch-site': 'same-origin'
      },
      body: '{}'
    });
    assert.equal(accept.status, expected);
  }
  assert.deepEqual((await pool.query(
    'SELECT joined_organizer_id,joined_at FROM host_invitations WHERE token=$1',
    [revokedToken]
  )).rows[0], { joined_organizer_id: null, joined_at: null });
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM host_invitations WHERE token=$1', [missingToken]
  )).rows[0].count, 0);
});

test('host invitation onboarding preserves existing hosts and reuses settings to create one new Host Page', async () => {
  const existingToken = 'existing-host-123456789';
  await pool.query(
    `INSERT INTO host_invitations (token,host_name,personal_note)
     VALUES ($1,'Should Not Replace Test Host','An existing Host Page must remain unchanged.')`,
    [existingToken]
  );
  const existingBefore = (await pool.query(
    'SELECT name,org_name,public_slug FROM organizers WHERE id=$1', [organizerId]
  )).rows[0];
  const existingCookie = `sge_session=${signSession(organizerId)}`;
  const existingAccept = await fetch(`${baseUrl}/api/host-invitations/${existingToken}/accept`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: existingCookie,
      origin: baseUrl,
      'sec-fetch-site': 'same-origin'
    },
    body: '{}'
  });
  assert.equal(existingAccept.status, 200);
  assert.deepEqual((await pool.query(
    'SELECT name,org_name,public_slug FROM organizers WHERE id=$1', [organizerId]
  )).rows[0], existingBefore);
  assert.equal(Number((await pool.query(
    'SELECT joined_organizer_id FROM host_invitations WHERE token=$1', [existingToken]
  )).rows[0].joined_organizer_id), Number(organizerId));

  const noSlugAccount = (await pool.query(
    `INSERT INTO organizers (email,name)
     VALUES ('host-page-onboarding@example.test','Profile Keeper')
     RETURNING id`
  )).rows[0];
  const noSlugCookie = `sge_session=${signSession(noSlugAccount.id)}`;
  const setupToken = 'setup-host-123456789012';
  await pool.query(
    `INSERT INTO host_invitations (token,host_name,personal_note)
     VALUES ($1,'Invite Ready Host','This account should create its Host Page through existing settings.')`,
    [setupToken]
  );

  const accepted = await fetch(`${baseUrl}/api/host-invitations/${setupToken}/accept`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: noSlugCookie,
      origin: baseUrl,
      'sec-fetch-site': 'same-origin'
    },
    body: '{}'
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual((await pool.query(
    'SELECT name,org_name,public_slug FROM organizers WHERE id=$1', [noSlugAccount.id]
  )).rows[0], { name: 'Profile Keeper', org_name: null, public_slug: null });

  const saved = await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: noSlugCookie },
    body: JSON.stringify({
      name: 'Profile Keeper',
      org_name: 'Invite Ready Host',
      bio: 'Independent gatherings and thoughtful rooms.',
      instagram_handle: '@InviteReady',
      website_url: ''
    })
  });
  assert.equal(saved.status, 200);
  const firstSavedProfile = (await pool.query(
    `SELECT name,org_name,public_slug,bio,instagram_handle
       FROM organizers WHERE id=$1`,
    [noSlugAccount.id]
  )).rows[0];
  assert.equal(firstSavedProfile.name, 'Profile Keeper');
  assert.equal(firstSavedProfile.org_name, 'Invite Ready Host');
  assert.match(firstSavedProfile.public_slug, /^invite-ready-host(?:-[a-f0-9]{4})?$/);
  assert.equal(firstSavedProfile.bio, 'Independent gatherings and thoughtful rooms.');
  assert.equal(firstSavedProfile.instagram_handle, 'inviteready');
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM organizers
      WHERE id=$1 AND public_slug IS NOT NULL`,
    [noSlugAccount.id]
  )).rows[0].count, 1);

  const savedAgain = await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: noSlugCookie },
    body: JSON.stringify({
      name: 'Profile Keeper',
      org_name: 'Invite Ready Host',
      bio: 'Independent gatherings and thoughtful rooms.',
      instagram_handle: '@InviteReady',
      website_url: ''
    })
  });
  assert.equal(savedAgain.status, 200);
  const savedAgainProfile = (await pool.query(
    'SELECT name,public_slug FROM organizers WHERE id=$1', [noSlugAccount.id]
  )).rows[0];
  assert.deepEqual(savedAgainProfile, {
    name: 'Profile Keeper',
    public_slug: firstSavedProfile.public_slug
  });
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

test('creates, renders, and duplicates three Event Vibe artists with photo and media combinations', async () => {
  const organizerCookie = `sge_session=${signSession(organizerId)}`;
  const fields = {
    event_vibe_url: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
    event_vibe_label: 'DJ Walkin Love',
    event_vibe_image_url: 'https://res.cloudinary.com/dhvavjgnw/image/upload/sg-events-dev/vibes/walkin-love.jpg',
    event_vibe_url_2: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    event_vibe_label_2: 'Fire in the Sky',
    event_vibe_image_url_2: 'https://res.cloudinary.com/dhvavjgnw/image/upload/sg-events-dev/vibes/fire-sky.jpg',
    event_vibe_url_3: null,
    event_vibe_label_3: 'Closing Set',
    event_vibe_image_url_3: 'https://res.cloudinary.com/dhvavjgnw/image/upload/sg-events-dev/vibes/closing-set.jpg'
  };
  const createdResponse = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: organizerCookie },
    body: JSON.stringify({
      title: 'Three Artist Night',
      event_date: '2030-11-02',
      start_time: '20:00',
      venue_name: 'Vibe Hall',
      ...fields
    })
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).event;
  assert.equal(created.event_vibe_label_3, 'Closing Set');
  assert.equal(created.event_vibe_image_url_2, fields.event_vibe_image_url_2);

  const page = await fetch(`${baseUrl}/e/${created.slug}`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, />DJ Walkin Love<\/button>/);
  assert.match(html, />Fire in the Sky<\/button>/);
  assert.match(html, />Closing Set<\/button>/);
  assert.equal((html.match(/data-vibe-template=/g) || []).length, 3);
  assert.match(html, /class="vibe-artist-photo"[^>]+walkin-love\.jpg/);
  assert.match(html, /class="vibe-video-play"/);
  assert.match(html, /fire-sky\.jpg/);
  assert.match(html, /autoplay=1/);
  assert.match(html, /closing-set\.jpg/);

  const duplicateResponse = await fetch(`${baseUrl}/api/events/${created.id}/duplicate`, {
    method: 'POST', headers: { cookie: organizerCookie }
  });
  assert.equal(duplicateResponse.status, 201);
  const duplicate = (await duplicateResponse.json()).event;
  for (const [field, value] of Object.entries(fields)) assert.equal(duplicate[field], value);

  const rejected = await fetch(`${baseUrl}/api/events/${created.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: organizerCookie },
    body: JSON.stringify({ event_vibe_image_url: 'https://images.example.test/not-managed.jpg' })
  });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /Upload Event Vibe photos through Silver Glider Events/);
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

  const photoGuest = (await pool.query(
    `INSERT INTO organizers (email,name)
     VALUES ('photo-guest@example.test','Photo Guest') RETURNING id`
  )).rows[0];
  const photoGuestUserId = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [photoGuest.id]
  )).rows[0].user_id;
  await pool.query(
    `INSERT INTO rsvps (event_id, first_name, last_name, email, wants_reminders, organizer_optin, status, manage_token)
     VALUES ($1,'Photo','Guest','photo-guest@example.test',TRUE,FALSE,'confirmed','photo-guest-token'),
            ($1,'No','Updates','no-updates@example.test',FALSE,FALSE,'confirmed','no-updates-token')`,
    [past.id]
  );
  await pool.query(
    `UPDATE rsvps SET user_id=$2
      WHERE event_id=$1 AND email='photo-guest@example.test'`,
    [past.id, photoGuestUserId]
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
    `SELECT recipient,recipient_user_id,status FROM message_log
      WHERE event_id=$1 AND message_type='photo_request'`,
    [past.id]
  );
  assert.deepEqual(logs.rows, [{
    recipient: 'photo-guest@example.test',
    recipient_user_id: photoGuestUserId,
    status: 'sent'
  }]);

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

test('a private event counts consenting past guests as followers but cannot announce to them', async () => {
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
  await createRsvp(source.id, {
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
  assert.deepEqual(new Set(list.faces.map(face => face.status)), new Set(['RSVP’d', 'Invited', 'Maya’s +1']));
  assert.equal(list.faces.find(face => face.name === 'Sam Friend').status, 'Maya’s +1');
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
    `SELECT token, intent, return_path, expires_at, used_at FROM magic_link_tokens
      WHERE email=$1 ORDER BY id DESC LIMIT 1`,
    [email]
  )).rows[0];
  assert.equal(tokenRow.intent, 'add_photo');
  assert.equal(tokenRow.return_path, `/add-photo?event=${event.slug}`);
  assert.equal(tokenRow.used_at, null);
  assert.ok(new Date(tokenRow.expires_at) > new Date());

  const confirmation = lastDevEmail(email);
  const photoLink = confirmation.html.match(/https?:\/\/[^"]+\/auth\/verify\?token=[a-f0-9]{64}/)[0];
  const verify = await followSignInLink(photoLink);
  assert.equal(verify.status, 303);
  assert.equal(verify.headers.get('location'), `/add-photo?event=${event.slug}`);
  // A forwarded confirmation must not hand out an account: the link grants a
  // photo-only cookie, never sge_session.
  assert.doesNotMatch(verify.headers.get('set-cookie'), /sge_session=[^;]/);
  const guestCookie = responseCookie(verify, 'sge_photo');
  assert.ok(guestCookie);
  const page = await fetch(`${baseUrl}/add-photo?event=${event.slug}`, { headers: { cookie: guestCookie } });
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /Add your photo/);
  assert.match(pageHtml, /Help friends recognize you\./);
  assert.match(pageHtml, /← Back to Photo Opportunity Night/);
  assert.match(pageHtml, /href="\/e\/photo-opportunity-night"/);

  const unrelated = await createEvent({
    slug: 'unrelated-photo-return',
    title: 'Private Name Must Stay Private',
    visibility: 'private',
    event_date: '2030-09-21'
  });
  const unrelatedPage = await fetch(`${baseUrl}/add-photo?event=${unrelated.slug}`, { headers: { cookie: guestCookie } });
  const unrelatedHtml = await unrelatedPage.text();
  assert.doesNotMatch(unrelatedHtml, /Private Name Must Stay Private/);
  assert.match(unrelatedHtml, /data-return-url="\/"/);
  const photoMe = await fetch(`${baseUrl}/api/me`, { headers: { cookie: guestCookie } });
  assert.equal((await photoMe.json()).scope, 'photo');
  const dashboard = await fetch(`${baseUrl}/dashboard`, { headers: { cookie: guestCookie }, redirect: 'manual' });
  assert.equal(dashboard.status, 302);
  assert.equal(dashboard.headers.get('location'), '/login');
  const accountApi = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: guestCookie } });
  assert.equal(accountApi.status, 401);

  const identity = (await pool.query(
    `SELECT r.account_id, o.email
       FROM rsvps r JOIN organizers o ON o.id=r.account_id
      WHERE r.event_id=$1 AND LOWER(r.email)=LOWER($2)`,
    [event.id, email]
  )).rows[0];
  assert.ok(identity.account_id);
  assert.equal(identity.email, email);

  const reused = await fetch(`${baseUrl}/auth/verify?token=${tokenFromLink(photoLink)}`, { redirect: 'manual' });
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

test('signed-in guests see RSVP events in Going and can edit only their own public avatar', async () => {
  const guest = (await pool.query(
    `INSERT INTO organizers (email, name, avatar_url)
     VALUES ('going-guest@example.test','Going Guest','https://res.cloudinary.com/demo/image/upload/v1/going-guest.jpg')
     RETURNING id`
  )).rows[0];
  guest.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [guest.id]
  )).rows[0].user_id;
  const other = (await pool.query(
    `INSERT INTO organizers (email, name)
     VALUES ('other-guest@example.test','Other Guest') RETURNING id`
  )).rows[0];
  const event = await createEvent({
    slug: 'going-list-night',
    title: 'Going List Night',
    show_guest_list: true,
    event_date: '2030-10-10'
  });
  await createRsvp(event.id, {
    first_name: 'Going', last_name: 'Guest', email: 'going-guest@example.test', account_id: guest.id
  });
  const canonicalEvent = await createEvent({
    slug: 'canonical-going-night', title: 'Canonical Going Night', event_date: '2030-10-12'
  });
  await createRsvp(canonicalEvent.id, {
    first_name: 'Going', last_name: 'Guest', email: 'old-going-alias@example.test',
    account_id: null, user_id: guest.user_id
  });
  const emailOnlyEvent = await createEvent({
    slug: 'email-only-going-night', title: 'Email Only Going Night', event_date: '2030-10-11'
  });
  await createRsvp(emailOnlyEvent.id, {
    first_name: 'Going', last_name: 'Guest', email: 'going-guest@example.test', account_id: null
  });

  const guestCookie = `sge_session=${signSession(guest.id)}`;
  const goingResponse = await fetch(`${baseUrl}/api/events/going`, { headers: { cookie: guestCookie } });
  assert.equal(goingResponse.status, 200);
  const going = await goingResponse.json();
  assert.deepEqual(going.events.map(item => item.slug).sort(), ['canonical-going-night', 'going-list-night']);

  const eventsPage = await fetch(`${baseUrl}/events`, { headers: { cookie: guestCookie } });
  const eventsHtml = await eventsPage.text();
  assert.match(eventsHtml, /data-view="going">Going/);
  assert.match(eventsHtml, /data-view="hosting">Hosting/);

  const signedInPage = await fetch(`${baseUrl}/e/${event.slug}`, { headers: { cookie: guestCookie } });
  const signedInHtml = await signedInPage.text();
  assert.match(signedInHtml, /aria-label="Change your photo"/);
  assert.match(signedInHtml, new RegExp(`href="/add-photo\\?event=${event.slug}"`));

  const signedOutHtml = await (await fetch(`${baseUrl}/e/${event.slug}`)).text();
  assert.doesNotMatch(signedOutHtml, /aria-label="Change your photo"/);
  const otherHtml = await (await fetch(`${baseUrl}/e/${event.slug}`, {
    headers: { cookie: `sge_session=${signSession(other.id)}` }
  })).text();
  assert.doesNotMatch(otherHtml, /aria-label="Change your photo"/);
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

// ---------------------------------------------------------------------------
// Sign-in hardening and returning guests (v1.0.85)
// ---------------------------------------------------------------------------

test('creator phone onboarding requires phone and inbox proof, then remembers the verified phone', async () => {
  resetRateLimits();
  const originalStartVerification = phoneVerification.startVerification;
  const originalCheckVerification = phoneVerification.checkVerification;
  const verificationSid = `VE${'a'.repeat(32)}`;
  const phone = '+14155550188';
  let providerStarts = 0;
  let providerChecks = 0;
  phoneVerification.startVerification = async recipient => {
    providerStarts += 1;
    assert.equal(recipient, phone);
    return { verificationSid, phone: recipient, status: 'pending' };
  };
  phoneVerification.checkVerification = async input => {
    providerChecks += 1;
    assert.deepEqual(input, { verificationSid, code: '123456' });
    return { approved: true, verificationSid, phone, status: 'approved' };
  };
  try {
    const crossSite = await fetch(`${baseUrl}/api/auth/phone/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site'
      },
      body: JSON.stringify({ phone, next: '/events/new' })
    });
    assert.equal(crossSite.status, 403, 'another site cannot trigger verification texts');
    assert.equal(providerStarts, 0);

    const outOfScope = await fetch(`${baseUrl}/api/auth/phone/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, next: '/dashboard' })
    });
    assert.equal(outOfScope.status, 400, 'phone-first auth is creator-only');
    assert.equal(providerStarts, 0);

    const started = await fetch(`${baseUrl}/api/auth/phone/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '(415) 555-0188', next: '/events/new' })
    });
    assert.equal(started.status, 200);
    const firstStartBody = await started.json();
    assert.deepEqual(firstStartBody, { ok: true, codeLength: 6 });
    const phoneCookie = responseCookie(started, 'sge_phone_auth');
    assert.ok(phoneCookie);
    assert.equal(providerStarts, 1);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM account_phone_credentials')).rows[0].count, 0);

    const otherBrowser = await fetch(`${baseUrl}/api/auth/phone/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123456' })
    });
    assert.equal(otherBrowser.status, 400, 'the phone proof is bound to the requesting browser');

    const phoneProof = await fetch(`${baseUrl}/api/auth/phone/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: phoneCookie },
      body: JSON.stringify({ code: '123456' })
    });
    assert.equal(phoneProof.status, 200);
    assert.deepEqual(await phoneProof.json(), {
      ok: true, needsEmail: true, maskedPhone: '•••• 0188'
    });
    assert.equal(providerChecks, 1);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM account_phone_credentials')).rows[0].count, 0,
      'phone possession alone never claims an identity');
    assert.equal(responseCookie(phoneProof, 'sge_session'), '');

    await pool.query(
      `UPDATE phone_auth_challenges SET expires_at=NOW() + INTERVAL '5 seconds'
        WHERE phone_e164=$1 AND purpose='enroll' AND used_at IS NULL`,
      [phone]
    );

    const emailStep = await fetch(`${baseUrl}/api/auth/phone/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: phoneCookie },
      body: JSON.stringify({ email: 'host@example.test' })
    });
    assert.equal(emailStep.status, 200);
    const emailCookie = responseCookie(emailStep, 'sge_sign_in');
    assert.ok(emailCookie);
    const emailMessage = lastDevEmail('host@example.test', 'account_verification_code');
    assert.match(emailMessage.code, /^\d{6}$/);
    const extendedExpiry = (await pool.query(
      `SELECT EXTRACT(EPOCH FROM (expires_at - NOW())) AS seconds
         FROM phone_auth_challenges WHERE phone_e164=$1 AND purpose='enroll' AND used_at IS NULL`,
      [phone]
    )).rows[0];
    assert.ok(Number(extendedExpiry.seconds) > 19 * 60,
      'starting inbox proof preserves the full email-code verification window');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM account_phone_credentials')).rows[0].count, 0,
      'requesting an email code still does not bind the phone');

    const noBrowserCookie = await fetch(`${baseUrl}/api/auth/verify-code`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: emailMessage.code })
    });
    assert.equal(noBrowserCookie.status, 400);

    const completed = await fetch(`${baseUrl}/api/auth/verify-code`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: emailCookie },
      body: JSON.stringify({ code: emailMessage.code })
    });
    assert.equal(completed.status, 200);
    assert.equal((await completed.json()).redirect, '/events/new');
    const sessionCookie = responseCookie(completed, 'sge_session');
    assert.ok(sessionCookie);
    assert.equal((await fetch(`${baseUrl}/events/new`, { headers: { cookie: sessionCookie } })).status, 200);
    const credential = (await pool.query(
      'SELECT organizer_id,phone_e164 FROM account_phone_credentials WHERE revoked_at IS NULL'
    )).rows[0];
    assert.deepEqual({ organizerId: credential.organizer_id, phone: credential.phone_e164 }, {
      organizerId, phone
    });
    const authIdentities = (await pool.query(
      `SELECT identity_type,normalized_value,verification_scope,verified_at
         FROM user_identities
        WHERE user_id=$1 AND revoked_at IS NULL
        ORDER BY identity_type`,
      [organizerId]
    )).rows;
    assert.deepEqual(authIdentities.map(identity => ({
      type: identity.identity_type,
      value: identity.normalized_value,
      scope: identity.verification_scope,
      verified: Boolean(identity.verified_at)
    })), [
      { type: 'email', value: 'host@example.test', scope: 'account', verified: true },
      { type: 'phone', value: phone, scope: 'account', verified: true }
    ]);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM host_follows')).rows[0].count, 0,
      'an authentication phone never creates follow or text consent');

    // During the compatibility window, the canonical credential is the source
    // of truth. A missing legacy projection must still start and complete sign
    // in, then be repaired only after Twilio proves phone possession.
    await pool.query(
      'DELETE FROM account_phone_credentials WHERE organizer_id=$1 AND phone_e164=$2',
      [organizerId, phone]
    );
    const returningStart = await fetch(`${baseUrl}/api/auth/phone/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, next: '/events/new' })
    });
    assert.equal(returningStart.status, 200);
    assert.deepEqual(await returningStart.clone().json(), firstStartBody,
      'the start response does not reveal whether a phone is already bound');
    assert.equal(providerStarts, 2, 'a bound phone stays inside Twilio Verify');
    assert.equal((await pool.query(
      `SELECT provider_sid FROM phone_auth_challenges
        WHERE phone_e164=$1 AND purpose='sign_in' ORDER BY id DESC LIMIT 1`,
      [phone]
    )).rows[0].provider_sid, verificationSid);
    const returningCookie = responseCookie(returningStart, 'sge_phone_auth');
    const returningVerify = await fetch(`${baseUrl}/api/auth/phone/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: returningCookie },
      body: JSON.stringify({ code: '123456' })
    });
    assert.equal(returningVerify.status, 200);
    assert.deepEqual(await returningVerify.json(), { ok: true, redirect: '/events/new' });
    assert.equal(providerChecks, 2);
    const returningSession = responseCookie(returningVerify, 'sge_session');
    assert.ok(returningSession);
    assert.equal((await pool.query(
      `SELECT COUNT(*)::int AS count FROM account_phone_credentials
        WHERE organizer_id=$1 AND phone_e164=$2 AND revoked_at IS NULL`,
      [organizerId, phone]
    )).rows[0].count, 1, 'verified sign-in repairs the missing legacy phone projection');
    const replay = await fetch(`${baseUrl}/api/auth/phone/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: returningCookie },
      body: JSON.stringify({ code: '123456' })
    });
    assert.equal(replay.status, 400, 'a completed phone challenge cannot be replayed');
    assert.equal(responseCookie(replay, 'sge_session'), '');

    const pendingStart = await fetch(`${baseUrl}/api/auth/phone/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, next: '/events/new' })
    });
    assert.equal(pendingStart.status, 200);
    assert.equal(providerStarts, 3);
    const logoutAll = await fetch(`${baseUrl}/api/auth/logout-all`, {
      method: 'POST', headers: { cookie: returningSession }
    });
    assert.equal(logoutAll.status, 200);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::int AS count FROM account_phone_credentials WHERE phone_e164=$1 AND revoked_at IS NULL', [phone]
    )).rows[0].count, 0, 'account recovery revokes phone sign-in');
    assert.equal((await pool.query(
      `SELECT COUNT(*)::int AS count FROM user_identities
        WHERE user_id=$1 AND identity_type='phone' AND normalized_value=$2 AND revoked_at IS NULL`,
      [organizerId, phone]
    )).rows[0].count, 0, 'account recovery revokes the canonical phone identity too');
    assert.equal((await pool.query(
      'SELECT COUNT(*)::int AS count FROM phone_auth_challenges WHERE phone_e164=$1 AND used_at IS NULL', [phone]
    )).rows[0].count, 0, 'account recovery invalidates pending phone codes');

    const reenrollStart = await fetch(`${baseUrl}/api/auth/phone/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, next: '/events/new' })
    });
    assert.equal(reenrollStart.status, 200);
    assert.equal(providerStarts, 4, 'a revoked phone must repeat Verify plus inbox proof');
    const reenrollProof = await fetch(`${baseUrl}/api/auth/phone/verify`, {
      method: 'POST', headers: {
        'content-type': 'application/json',
        cookie: responseCookie(reenrollStart, 'sge_phone_auth')
      },
      body: JSON.stringify({ code: '123456' })
    });
    assert.equal(reenrollProof.status, 200);
    assert.equal((await reenrollProof.json()).needsEmail, true);
    assert.equal(responseCookie(reenrollProof, 'sge_session'), '');
  } finally {
    phoneVerification.startVerification = originalStartVerification;
    phoneVerification.checkVerification = originalCheckVerification;
  }
});

test('administrator identities remain email-only even if a phone was previously bound', async () => {
  resetRateLimits();
  await pool.query('UPDATE organizers SET is_admin=TRUE WHERE id=$1', [organizerId]);
  const originalStartVerification = phoneVerification.startVerification;
  const originalCheckVerification = phoneVerification.checkVerification;
  const verificationSid = `VE${'e'.repeat(32)}`;
  const phone = '+14155550191';
  phoneVerification.startVerification = async () => ({ verificationSid, phone, status: 'pending' });
  phoneVerification.checkVerification = async () => ({ approved: true, verificationSid, phone, status: 'approved' });

  try {
    const started = await fetch(`${baseUrl}/api/auth/phone/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, next: '/events/new' })
    });
    const phoneCookie = responseCookie(started, 'sge_phone_auth');
    await fetch(`${baseUrl}/api/auth/phone/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: phoneCookie },
      body: JSON.stringify({ code: '123456' })
    });
    const emailStep = await fetch(`${baseUrl}/api/auth/phone/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: phoneCookie },
      body: JSON.stringify({ email: 'host@example.test' })
    });
    const emailCookie = responseCookie(emailStep, 'sge_sign_in');
    const emailCode = lastDevEmail('host@example.test', 'account_verification_code').code;
    const bindAttempt = await fetch(`${baseUrl}/api/auth/verify-code`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: emailCookie },
      body: JSON.stringify({ code: emailCode })
    });
    assert.equal(bindAttempt.status, 403);
    assert.equal((await bindAttempt.json()).error, 'email_sign_in_required');
    assert.equal(responseCookie(bindAttempt, 'sge_session'), '');
    assert.equal((await pool.query(
      'SELECT COUNT(*)::int AS count FROM account_phone_credentials WHERE organizer_id=$1 AND revoked_at IS NULL', [organizerId]
    )).rows[0].count, 0);

    await pool.query(
      `INSERT INTO account_phone_credentials (organizer_id,phone_e164,verified_at)
       VALUES ($1,$2,NOW())`,
      [organizerId, phone]
    );
    const returningStart = await fetch(`${baseUrl}/api/auth/phone/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, next: '/events/new' })
    });
    assert.equal(returningStart.status, 200);
    const returningAttempt = await fetch(`${baseUrl}/api/auth/phone/verify`, {
      method: 'POST', headers: {
        'content-type': 'application/json',
        cookie: responseCookie(returningStart, 'sge_phone_auth')
      },
      body: JSON.stringify({ code: '123456' })
    });
    assert.equal(returningAttempt.status, 403);
    assert.equal((await returningAttempt.json()).error, 'email_sign_in_required');
    assert.equal(responseCookie(returningAttempt, 'sge_session'), '');
  } finally {
    phoneVerification.startVerification = originalStartVerification;
    phoneVerification.checkVerification = originalCheckVerification;
  }
});

test('unverified phone requests cannot exhaust another person’s email sign-in limit', async () => {
  resetRateLimits();
  const email = 'rate-limit-victim@example.test';
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/auth/phone/email`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email })
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'phone_verification_required');
  }
  const normalLogin = await fetch(`${baseUrl}/api/auth/magic-link`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, next: '/dashboard' })
  });
  assert.equal(normalLogin.status, 200, 'the shared email limiter remains untouched');
});

test('phone-code delivery failures do not reveal whether a phone is already bound', async () => {
  resetRateLimits();
  const boundPhone = '+14155550192';
  const newPhone = '+14155550193';
  await pool.query(
    `INSERT INTO account_phone_credentials (organizer_id,phone_e164,verified_at)
     VALUES ($1,$2,NOW())`,
    [organizerId, boundPhone]
  );
  const originalStartVerification = phoneVerification.startVerification;
  phoneVerification.startVerification = async () => {
    throw new phoneVerification.PhoneVerificationError('verify-specific failure', {
      code: 'phone_verification_rejected', status: 422
    });
  };
  try {
    const responses = [];
    for (const phone of [boundPhone, newPhone]) {
      const response = await fetch(`${baseUrl}/api/auth/phone/start`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone, next: '/events/new' })
      });
      responses.push({ status: response.status, body: await response.json() });
    }
    assert.deepEqual(responses[0], responses[1]);
    assert.deepEqual(responses[0], {
      status: 503,
      body: {
        error: 'phone_code_unavailable',
        message: 'We couldn’t send a code. Try again or use email.'
      }
    });
  } finally {
    phoneVerification.startVerification = originalStartVerification;
  }
});

test('phone enrollment collisions never merge identities or create a session', async () => {
  resetRateLimits();
  const originalStartVerification = phoneVerification.startVerification;
  const originalCheckVerification = phoneVerification.checkVerification;
  const verificationSid = `VE${'c'.repeat(32)}`;
  const phone = '+14155550189';
  phoneVerification.startVerification = async () => ({ verificationSid, phone, status: 'pending' });
  phoneVerification.checkVerification = async () => ({ approved: true, verificationSid, phone, status: 'approved' });

  try {
    const started = await fetch(`${baseUrl}/api/auth/phone/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, next: '/events/new' })
    });
    const phoneCookie = responseCookie(started, 'sge_phone_auth');
    const verified = await fetch(`${baseUrl}/api/auth/phone/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: phoneCookie },
      body: JSON.stringify({ code: '654321' })
    });
    assert.equal(verified.status, 200);

    const competing = (await pool.query(
      `INSERT INTO organizers (email,name) VALUES ('phone-owner@example.test','Phone Owner') RETURNING id`
    )).rows[0];
    await pool.query(
      `INSERT INTO account_phone_credentials (organizer_id,phone_e164) VALUES ($1,$2)`,
      [competing.id, phone]
    );

    const email = 'must-not-merge@example.test';
    const emailStep = await fetch(`${baseUrl}/api/auth/phone/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: phoneCookie },
      body: JSON.stringify({ email })
    });
    const emailCookie = responseCookie(emailStep, 'sge_sign_in');
    const code = lastDevEmail(email, 'account_verification_code').code;
    const completion = await fetch(`${baseUrl}/api/auth/verify-code`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: emailCookie },
      body: JSON.stringify({ code })
    });
    assert.equal(completion.status, 409);
    assert.equal((await completion.json()).error, 'phone_identity_conflict');
    assert.equal(responseCookie(completion, 'sge_session'), '');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM organizers WHERE email=$1', [email])).rows[0].count, 0,
      'the rolled-back bind does not leave a duplicate identity');
    assert.equal((await pool.query(
      `SELECT COUNT(*)::int AS count FROM user_identities
        WHERE identity_type='email' AND normalized_value=$1 AND revoked_at IS NULL`,
      [email]
    )).rows[0].count, 0, 'the rolled-back bind leaves no canonical email identity');
    assert.equal((await pool.query(
      'SELECT organizer_id FROM account_phone_credentials WHERE phone_e164=$1 AND revoked_at IS NULL', [phone]
    )).rows[0].organizer_id, competing.id);
  } finally {
    phoneVerification.startVerification = originalStartVerification;
    phoneVerification.checkVerification = originalCheckVerification;
  }
});

test('email scanners cannot use up a sign-in link, and signed-in people are not sent to "expired"', async () => {
  resetRateLimits();
  const email = 'scanner-safe@example.test';
  const request = await fetch(`${baseUrl}/api/auth/magic-link`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, next: '/events' })
  });
  assert.equal(request.status, 200);
  const { link } = lastDevEmail(email, 'magic_link');

  // A scanner (or link preview) opens the link twice. Nothing is consumed.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const scanned = await fetch(`${baseUrl}/auth/verify?token=${tokenFromLink(link)}`, { redirect: 'manual' });
    assert.equal(scanned.status, 200);
    assert.doesNotMatch(scanned.headers.get('set-cookie') || '', /sge_session=/);
  }
  const { rows: pending } = await pool.query('SELECT used_at FROM magic_link_tokens WHERE email=$1', [email]);
  assert.equal(pending[0].used_at, null);

  const signedIn = await followSignInLink(link);
  assert.equal(signedIn.status, 303);
  assert.equal(signedIn.headers.get('location'), '/events');
  const sessionCookie = responseCookie(signedIn, 'sge_session');
  assert.ok(sessionCookie);
  const canonicalLogin = (await pool.query(
    `SELECT o.id,o.user_id,ui.verification_scope,ui.verified_at
       FROM organizers o
       JOIN users u ON u.id=o.user_id
       JOIN user_identities ui ON ui.user_id=u.id
      WHERE ui.identity_type='email' AND ui.normalized_value=$1 AND ui.revoked_at IS NULL`,
    [email]
  )).rows[0];
  assert.equal(Number(canonicalLogin.id), Number(canonicalLogin.user_id));
  assert.equal(canonicalLogin.verification_scope, 'account');
  assert.ok(canonicalLogin.verified_at);

  // The same link again: signed in → straight to the app, signed out → expired.
  const againSignedIn = await fetch(`${baseUrl}/auth/verify?token=${tokenFromLink(link)}`, {
    redirect: 'manual', headers: { cookie: sessionCookie }
  });
  assert.equal(againSignedIn.headers.get('location'), '/dashboard');
  const againSignedOut = await fetch(`${baseUrl}/auth/verify?token=${tokenFromLink(link)}&next=%2Fevents`, { redirect: 'manual' });
  assert.equal(againSignedOut.headers.get('location'), '/login?error=expired&next=%2Fevents');

  // Login CSRF: another origin cannot post a token into this browser.
  const second = await fetch(`${baseUrl}/api/auth/magic-link`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email })
  });
  assert.equal(second.status, 200);
  const secondToken = tokenFromLink(lastDevEmail(email, 'magic_link').link);
  const crossSite = await fetch(`${baseUrl}/auth/verify`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
    body: new URLSearchParams({ token: secondToken })
  });
  assert.equal(crossSite.status, 403);
  const crossSiteMetadata = await fetch(`${baseUrl}/auth/verify`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null', 'sec-fetch-site': 'cross-site' },
    body: new URLSearchParams({ token: secondToken })
  });
  assert.equal(crossSiteMetadata.status, 403);
  // Regression: a real browser submitting the Continue page may send
  // `Origin: null`; same-origin fetch metadata must still be accepted.
  const realBrowser = await fetch(`${baseUrl}/auth/verify`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null', 'sec-fetch-site': 'same-origin' },
    body: new URLSearchParams({ token: secondToken })
  });
  assert.equal(realBrowser.status, 303);
  const continuePage = await fetch(`${baseUrl}/auth/verify?token=${secondToken}`, { redirect: 'manual' });
  assert.equal(continuePage.status, 302, 'the link is used up after the successful Continue');
});

test('a 6-digit code signs in only the browser that asked for it and locks after five wrong tries', async () => {
  resetRateLimits();
  const email = 'code-sign-in@example.test';
  const request = await fetch(`${baseUrl}/api/auth/magic-link`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, next: '/events/new' })
  });
  assert.equal(request.status, 200);
  assert.equal((await request.json()).codeLength, 6);
  const requestCookie = responseCookie(request, 'sge_sign_in');
  assert.ok(requestCookie);
  const { code } = lastDevEmail(email, 'magic_link');
  assert.match(code, /^\d{6}$/);
  const wrong = code === '000000' ? '111111' : '000000';

  const otherBrowser = await fetch(`${baseUrl}/api/auth/verify-code`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code })
  });
  assert.equal(otherBrowser.status, 400);
  assert.equal((await otherBrowser.json()).error, 'expired');

  const miss = await fetch(`${baseUrl}/api/auth/verify-code`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: requestCookie },
    body: JSON.stringify({ code: wrong })
  });
  assert.equal(miss.status, 400);
  assert.deepEqual(
    { error: (await miss.clone().json()).error, remaining: (await miss.json()).remaining },
    { error: 'invalid', remaining: 4 }
  );

  const ok = await fetch(`${baseUrl}/api/auth/verify-code`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: requestCookie },
    body: JSON.stringify({ code: `${code.slice(0, 3)} ${code.slice(3)}` })
  });
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.kind, 'account');
  assert.equal(okBody.redirect, '/events/new');
  const sessionCookie = responseCookie(ok, 'sge_session');
  const dashboard = await fetch(`${baseUrl}/dashboard`, { headers: { cookie: sessionCookie }, redirect: 'manual' });
  assert.equal(dashboard.status, 200);

  // The link from the same email is now used up too.
  const link = lastDevEmail(email, 'magic_link').link;
  const usedLink = await fetch(`${baseUrl}/auth/verify?token=${tokenFromLink(link)}`, { redirect: 'manual' });
  assert.equal(usedLink.headers.get('location'), '/login?error=expired');

  // Brute force: five wrong codes lock that request; the right code then fails.
  const again = await fetch(`${baseUrl}/api/auth/magic-link`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email })
  });
  const lockCookie = responseCookie(again, 'sge_sign_in');
  const lockCode = lastDevEmail(email, 'magic_link').code;
  const lockWrong = lockCode === '000000' ? '111111' : '000000';
  let last;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    last = await fetch(`${baseUrl}/api/auth/verify-code`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: lockCookie },
      body: JSON.stringify({ code: lockWrong })
    });
  }
  assert.equal((await last.json()).error, 'locked');
  const tooLate = await fetch(`${baseUrl}/api/auth/verify-code`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: lockCookie },
    body: JSON.stringify({ code: lockCode })
  });
  assert.equal((await tooLate.json()).error, 'locked');
});

test('sign out of all devices rejects older cookies everywhere, including pre-upgrade cookies', async () => {
  resetRateLimits();
  const account = (await pool.query(
    `INSERT INTO organizers (email, name, last_login_at) VALUES ('revoke-me@example.test','Revoke Me',NOW()) RETURNING id`
  )).rows[0];
  const laptop = `sge_session=${signSession(account.id, Date.now() - 60000)}`;
  const phone = `sge_session=${signSession(account.id, Date.now() - 30000)}`;
  // A cookie in the pre-v1.0.85 format (id.exp.sig) still works until revoked.
  const crypto = require('node:crypto');
  const legacyPayload = `${account.id}.${Math.floor(Date.now() / 1000) + 3600}`;
  const legacy = `sge_session=${legacyPayload}.${crypto.createHmac('sha256', process.env.SESSION_SECRET).update(legacyPayload).digest('hex')}`;
  for (const cookie of [laptop, phone, legacy]) {
    assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } })).status, 200);
  }

  const signOutAll = await fetch(`${baseUrl}/api/auth/logout-all`, { method: 'POST', headers: { cookie: laptop } });
  assert.equal(signOutAll.status, 200);
  for (const cookie of [laptop, phone, legacy]) {
    assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } })).status, 401);
  }
  // A revoked cookie on /login shows the sign-in page instead of looping.
  const login = await fetch(`${baseUrl}/login`, { headers: { cookie: phone }, redirect: 'manual' });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie') || '', /sge_session=;/);

  // Signing in again afterwards works normally.
  const fresh = `sge_session=${signSession(account.id)}`;
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: fresh } })).status, 200);
});

test('sign out everywhere stays available during quarantined phone ownership drift', async () => {
  resetRateLimits();
  const account = (await pool.query(
    `INSERT INTO organizers (email,name,last_login_at)
     VALUES ('drift-session@example.test','Drift Session',NOW()) RETURNING id`
  )).rows[0];
  const other = (await pool.query(
    `INSERT INTO organizers (email,name,last_login_at)
     VALUES ('drift-owner@example.test','Drift Owner',NOW()) RETURNING id`
  )).rows[0];
  const phone = '+14155550191';
  await pool.query(
    `INSERT INTO account_phone_credentials (organizer_id,phone_e164,verified_at)
     VALUES ($1,$2,NOW())`,
    [account.id, phone]
  );
  await pool.query(
    `INSERT INTO user_identities
       (user_id,identity_type,value,normalized_value,verified_at,
        verification_scope,verification_source,is_primary)
     VALUES ($1,'phone',$2,$2,NOW(),'account','drift_fixture',TRUE)`,
    [other.id, phone]
  );
  await pool.query(
    `INSERT INTO phone_auth_challenges
       (request_hash,phone_e164,purpose,organizer_id,provider_sid,expires_at)
     VALUES ('drift-request-hash',$1,'sign_in',$2,'VE123456789012345678901234567890',NOW() + INTERVAL '20 minutes')`,
    [phone, account.id]
  );

  const cookie = `sge_session=${signSession(account.id, Date.now() - 1000)}`;
  const response = await fetch(`${baseUrl}/api/auth/logout-all`, {
    method: 'POST', headers: { cookie }
  });
  assert.equal(response.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } })).status, 401);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM account_phone_credentials
      WHERE organizer_id=$1 AND revoked_at IS NULL`,
    [account.id]
  )).rows[0].count, 0, 'the account-owned legacy credential is revoked');
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM user_identities
      WHERE user_id=$1 AND identity_type='phone' AND normalized_value=$2 AND revoked_at IS NULL`,
    [other.id, phone]
  )).rows[0].count, 1, 'another canonical owner is never changed by recovery');
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM phone_auth_challenges
      WHERE phone_e164=$1 AND used_at IS NULL`,
    [phone]
  )).rows[0].count, 0, 'pending challenges for the drifted phone are invalidated');
});

// ---------------------------------------------------------------------------
// Account identity controls
// ---------------------------------------------------------------------------

test('account email controls require matching step-up and preserve one user through add, primary, login, and removal', async () => {
  resetRateLimits();
  const originalEmail = 'host@example.test';
  const secondaryEmail = 'host-secondary@example.test';
  const initialSignIn = await signInAccount(originalEmail);
  assert.equal(initialSignIn.body.kind, 'account');
  assert.ok(initialSignIn.sessionCookie);

  // A normal account session can inspect identities, but it cannot mutate
  // credentials until the current primary inbox has just been proved.
  const beforeStepUp = await fetch(`${baseUrl}/api/me/identities`, {
    headers: { cookie: initialSignIn.sessionCookie }
  });
  assert.equal(beforeStepUp.status, 200);
  const beforeStepUpBody = await beforeStepUp.json();
  assert.equal(beforeStepUpBody.capabilities.identityStepUpVerified, false);
  assert.deepEqual(beforeStepUpBody.identities.map(identity => ({
    type: identity.type,
    value: identity.value,
    primary: identity.isPrimary
  })), [{ type: 'email', value: originalEmail, primary: true }]);

  const unprovedAdd = await fetch(`${baseUrl}/api/me/identities/email/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: initialSignIn.sessionCookie },
    body: JSON.stringify({ email: secondaryEmail })
  });
  assert.equal(unprovedAdd.status, 403);
  assert.equal((await unprovedAdd.json()).error, 'identity_step_up_required');

  const stepUpStart = await fetch(`${baseUrl}/api/me/identities/step-up/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: initialSignIn.sessionCookie }
  });
  assert.equal(stepUpStart.status, 200);
  const stepUpRequestCookie = responseCookie(stepUpStart, 'sge_sign_in');
  const stepUpCode = lastDevEmail(originalEmail, 'account_verification_code').code;
  const otherAccount = (await pool.query(
    `INSERT INTO organizers (email,name,last_login_at)
     VALUES ('step-up-other@example.test','Other Account',NOW()) RETURNING id`
  )).rows[0];
  const wrongSession = `sge_session=${signSession(otherAccount.id)}`;
  const wrongAccountAttempt = await fetch(`${baseUrl}/api/auth/verify-code`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(wrongSession, stepUpRequestCookie)
    },
    body: JSON.stringify({ code: stepUpCode })
  });
  assert.equal(wrongAccountAttempt.status, 401);
  assert.equal((await wrongAccountAttempt.json()).error, 'identity_session_mismatch');
  assert.equal(responseCookie(wrongAccountAttempt, 'sge_identity_step_up'), '');

  // The mismatched session rolls the challenge back, so the rightful account
  // can still finish without asking for another email.
  const stepUpComplete = await fetch(`${baseUrl}/api/auth/verify-code`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(initialSignIn.sessionCookie, stepUpRequestCookie)
    },
    body: JSON.stringify({ code: stepUpCode })
  });
  assert.equal(stepUpComplete.status, 200);
  assert.equal((await stepUpComplete.json()).kind, 'identity_step_up');
  const stepUpCookie = responseCookie(stepUpComplete, 'sge_identity_step_up');
  assert.ok(stepUpCookie);
  const settingsCookies = cookieHeader(initialSignIn.sessionCookie, stepUpCookie);
  const stolenStepUp = await fetch(`${baseUrl}/api/me/identities/email/start`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(wrongSession, stepUpCookie)
    },
    body: JSON.stringify({ email: 'must-not-attach@example.test' })
  });
  assert.equal(stolenStepUp.status, 403);
  assert.equal((await stolenStepUp.json()).error, 'identity_step_up_required');

  const countsBeforeAdd = (await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM users) AS users,
            (SELECT COUNT(*)::int FROM organizers) AS organizers`
  )).rows[0];
  const addStart = await fetch(`${baseUrl}/api/me/identities/email/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: settingsCookies },
    body: JSON.stringify({ email: `  ${secondaryEmail.toUpperCase()}  ` })
  });
  assert.equal(addStart.status, 200);
  const addRequestCookie = responseCookie(addStart, 'sge_sign_in');
  assert.ok(addRequestCookie);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM user_identities
      WHERE normalized_value=$1 AND revoked_at IS NULL`, [secondaryEmail]
  )).rows[0].count, 0, 'delivery alone never attaches an email');

  const addComplete = await fetch(`${baseUrl}/api/auth/verify-code`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(settingsCookies, addRequestCookie)
    },
    body: JSON.stringify({
      code: lastDevEmail(secondaryEmail, 'account_verification_code').code
    })
  });
  assert.equal(addComplete.status, 200);
  assert.equal((await addComplete.json()).kind, 'identity');

  const countsAfterAdd = (await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM users) AS users,
            (SELECT COUNT(*)::int FROM organizers) AS organizers`
  )).rows[0];
  assert.deepEqual(countsAfterAdd, countsBeforeAdd,
    'a secondary login belongs to the existing user instead of creating an organizer');
  const emails = (await pool.query(
    `SELECT id,user_id,normalized_value,is_primary,revoked_at
       FROM user_identities
      WHERE user_id=$1 AND identity_type='email'
      ORDER BY normalized_value`,
    [organizerId]
  )).rows;
  assert.equal(emails.length, 2);
  assert.ok(emails.every(identity => Number(identity.user_id) === Number(organizerId)));
  const originalIdentity = emails.find(identity => identity.normalized_value === originalEmail);
  const secondaryIdentity = emails.find(identity => identity.normalized_value === secondaryEmail);
  assert.equal(originalIdentity.is_primary, true);
  assert.equal(secondaryIdentity.is_primary, false);

  const makePrimary = await fetch(
    `${baseUrl}/api/me/identities/${secondaryIdentity.id}/primary`,
    { method: 'PATCH', headers: { cookie: settingsCookies } }
  );
  assert.equal(makePrimary.status, 200);
  const primaryBody = await makePrimary.json();
  assert.equal(primaryBody.primaryEmail, secondaryEmail);
  assert.equal(primaryBody.identities.find(identity => identity.id === Number(secondaryIdentity.id)).isPrimary, true);
  const sameSession = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { cookie: initialSignIn.sessionCookie }
  });
  assert.equal(sameSession.status, 200);
  const sameSessionOrganizer = (await sameSession.json()).organizer;
  assert.equal(Number(sameSessionOrganizer.id), Number(organizerId));
  assert.equal(sameSessionOrganizer.email, secondaryEmail);

  // Changing the compatibility primary does not strand the old alias: either
  // verified email still resolves to the same canonical user and host row.
  resetRateLimits();
  const oldAliasSignIn = await signInAccount(originalEmail);
  const oldAliasMe = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { cookie: oldAliasSignIn.sessionCookie }
  });
  assert.equal(oldAliasMe.status, 200);
  const oldAliasOrganizer = (await oldAliasMe.json()).organizer;
  assert.equal(Number(oldAliasOrganizer.id), Number(organizerId));
  assert.equal(oldAliasOrganizer.email, secondaryEmail);
  assert.deepEqual((await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM users) AS users,
            (SELECT COUNT(*)::int FROM organizers) AS organizers`
  )).rows[0], countsBeforeAdd);

  const removePrimary = await fetch(`${baseUrl}/api/me/identities/${secondaryIdentity.id}`, {
    method: 'DELETE', headers: { cookie: settingsCookies }
  });
  assert.equal(removePrimary.status, 409);
  assert.equal((await removePrimary.json()).error, 'primary_identity_required');

  resetRateLimits();
  const pendingOldAlias = await fetch(`${baseUrl}/api/auth/magic-link`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: originalEmail, next: '/dashboard' })
  });
  assert.equal(pendingOldAlias.status, 200);
  const pendingOldAliasToken = tokenFromLink(lastDevEmail(originalEmail, 'magic_link').link);
  const removeSecondary = await fetch(`${baseUrl}/api/me/identities/${originalIdentity.id}`, {
    method: 'DELETE', headers: { cookie: settingsCookies }
  });
  assert.equal(removeSecondary.status, 200);
  const removalBody = await removeSecondary.json();
  assert.deepEqual(removalBody.identities.map(identity => identity.value), [secondaryEmail]);
  const removedState = (await pool.query(
    `SELECT identity.revoked_at,
            COUNT(proof.id) FILTER (WHERE proof.revoked_at IS NULL)::int AS active_proofs
       FROM user_identities identity
       LEFT JOIN user_identity_verifications proof ON proof.user_identity_id=identity.id
      WHERE identity.id=$1
      GROUP BY identity.id`,
    [originalIdentity.id]
  )).rows[0];
  assert.ok(removedState.revoked_at);
  assert.equal(removedState.active_proofs, 0);
  const invalidatedAliasLink = await fetch(
    `${baseUrl}/auth/verify?token=${pendingOldAliasToken}`,
    { redirect: 'manual' }
  );
  assert.equal(invalidatedAliasLink.status, 302);
  assert.equal(invalidatedAliasLink.headers.get('location'), '/login?error=expired');
});

test('verified email ownership conflicts are quarantined without merging either account', async () => {
  resetRateLimits();
  const host = await signInAccount('host@example.test');
  const claimedEmail = 'claimed-identity@example.test';
  const claimant = await signInAccount(claimedEmail);
  const claimantMe = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { cookie: claimant.sessionCookie }
  });
  const claimantId = Number((await claimantMe.json()).organizer.id);
  const before = (await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM users) AS users,
            (SELECT COUNT(*)::int FROM organizers) AS organizers`
  )).rows[0];
  const hostCookies = cookieHeader(host.sessionCookie, host.stepUpCookie);

  const started = await fetch(`${baseUrl}/api/me/identities/email/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: hostCookies },
    body: JSON.stringify({ email: claimedEmail })
  });
  assert.equal(started.status, 200,
    'ownership is deliberately checked only after inbox proof');
  const requestCookie = responseCookie(started, 'sge_sign_in');
  const pending = (await pool.query(
    `SELECT id FROM magic_link_tokens
      WHERE email=$1 AND intent='attach_email' ORDER BY id DESC LIMIT 1`,
    [claimedEmail]
  )).rows[0];
  const completion = await fetch(`${baseUrl}/api/auth/verify-code`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(hostCookies, requestCookie)
    },
    body: JSON.stringify({
      code: lastDevEmail(claimedEmail, 'account_verification_code').code
    })
  });
  assert.equal(completion.status, 409);
  assert.equal((await completion.json()).error, 'identity_conflict');

  const conflict = (await pool.query(
    `SELECT identity_type,normalized_value,candidate_user_id,conflicting_user_id,
            verification_source,source_record_id,reason,resolved_at
       FROM user_identity_conflicts
      WHERE source_record_id=$1 AND verification_source='account_settings.email_code'`,
    [pending.id]
  )).rows[0];
  assert.deepEqual({
    type: conflict.identity_type,
    value: conflict.normalized_value,
    candidate: Number(conflict.candidate_user_id),
    owner: Number(conflict.conflicting_user_id),
    sourceId: Number(conflict.source_record_id),
    reason: conflict.reason,
    resolved: conflict.resolved_at
  }, {
    type: 'email',
    value: claimedEmail,
    candidate: Number(organizerId),
    owner: claimantId,
    sourceId: Number(pending.id),
    reason: 'already_claimed',
    resolved: null
  });
  const ownership = (await pool.query(
    `SELECT user_id FROM user_identities
      WHERE identity_type='email' AND normalized_value=$1 AND revoked_at IS NULL`,
    [claimedEmail]
  )).rows;
  assert.deepEqual(ownership.map(row => Number(row.user_id)), [claimantId]);
  assert.deepEqual((await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM users) AS users,
            (SELECT COUNT(*)::int FROM organizers) AS organizers`
  )).rows[0], before);
  assert.ok((await pool.query(
    'SELECT used_at FROM magic_link_tokens WHERE id=$1', [pending.id]
  )).rows[0].used_at, 'the conflicted proof is consumed instead of remaining replayable');
});

test('administrators cannot add phone sign-in even after fresh account proof', async () => {
  resetRateLimits();
  await pool.query('UPDATE organizers SET is_admin=TRUE WHERE id=$1', [organizerId]);
  const account = await signInAccount('host@example.test');
  const cookies = cookieHeader(account.sessionCookie, account.stepUpCookie);
  const state = await fetch(`${baseUrl}/api/me/identities`, { headers: { cookie: cookies } });
  assert.equal(state.status, 200);
  assert.equal((await state.json()).capabilities.canAddPhone, false);

  const originalStartVerification = phoneVerification.startVerification;
  let providerStarts = 0;
  phoneVerification.startVerification = async () => {
    providerStarts += 1;
    return { verificationSid: `VE${'f'.repeat(32)}`, phone: '+14155550195', status: 'pending' };
  };
  try {
    const response = await fetch(`${baseUrl}/api/me/identities/phone/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookies },
      body: JSON.stringify({ phone: '+1 (415) 555-0195' })
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'email_sign_in_required');
    assert.equal(providerStarts, 0);
    assert.equal((await pool.query(
      `SELECT COUNT(*)::int AS count FROM phone_auth_challenges
        WHERE purpose='add_phone'`
    )).rows[0].count, 0);
  } finally {
    phoneVerification.startVerification = originalStartVerification;
  }
});

test('a freshly verified replacement phone revokes the old credential without changing the user', async () => {
  resetRateLimits();
  const account = await signInAccount('host@example.test');
  const cookies = cookieHeader(account.sessionCookie, account.stepUpCookie);
  const oldPhone = '+14155550196';
  const newPhone = '+14155550197';
  const credential = (await pool.query(
    `INSERT INTO account_phone_credentials (organizer_id,phone_e164,verified_at)
     VALUES ($1,$2,NOW()) RETURNING id`,
    [organizerId, oldPhone]
  )).rows[0];
  const oldIdentity = (await pool.query(
    `INSERT INTO user_identities (
       user_id,identity_type,value,normalized_value,verified_at,
       verification_scope,verification_source,source_record_id,is_primary
     ) VALUES ($1,'phone',$2,$2,NOW(),'account','phone_replacement_fixture',$3,TRUE)
     RETURNING id`,
    [organizerId, oldPhone, credential.id]
  )).rows[0];
  await pool.query(
    `INSERT INTO user_identity_verifications (
       user_identity_id,verification_scope,verified_at,verification_source,source_record_id
     ) VALUES ($1,'account',NOW(),'phone_replacement_fixture',$2)`,
    [oldIdentity.id, credential.id]
  );
  const countsBefore = (await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM users) AS users,
            (SELECT COUNT(*)::int FROM organizers) AS organizers`
  )).rows[0];

  const originalStartVerification = phoneVerification.startVerification;
  const originalCheckVerification = phoneVerification.checkVerification;
  const verificationSid = `VE${'d'.repeat(32)}`;
  let providerStarts = 0;
  let providerChecks = 0;
  phoneVerification.startVerification = async phone => {
    providerStarts += 1;
    assert.equal(phone, newPhone);
    return { verificationSid, phone, status: 'pending' };
  };
  phoneVerification.checkVerification = async input => {
    providerChecks += 1;
    assert.deepEqual(input, { verificationSid, code: '246810' });
    return { approved: true, verificationSid, phone: newPhone, status: 'approved' };
  };
  try {
    const started = await fetch(`${baseUrl}/api/me/identities/phone/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookies },
      body: JSON.stringify({ phone: '+1 (415) 555-0197' })
    });
    assert.equal(started.status, 200);
    const phoneCookie = responseCookie(started, 'sge_phone_auth');
    assert.ok(phoneCookie);
    assert.equal(providerStarts, 1);

    const verified = await fetch(`${baseUrl}/api/me/identities/phone/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader(cookies, phoneCookie)
      },
      body: JSON.stringify({ code: '246810' })
    });
    assert.equal(verified.status, 200);
    const verifiedBody = await verified.json();
    assert.deepEqual(
      verifiedBody.identities.filter(identity => identity.type === 'phone').map(identity => ({
        value: identity.value,
        primary: identity.isPrimary
      })),
      [{ value: newPhone, primary: true }]
    );
    assert.equal(providerChecks, 1);

    const phoneIdentities = (await pool.query(
      `SELECT normalized_value,is_primary,revoked_at
         FROM user_identities
        WHERE user_id=$1 AND identity_type='phone'
        ORDER BY id`,
      [organizerId]
    )).rows;
    assert.equal(phoneIdentities.length, 2);
    assert.equal(phoneIdentities[0].normalized_value, oldPhone);
    assert.ok(phoneIdentities[0].revoked_at);
    assert.equal(phoneIdentities[1].normalized_value, newPhone);
    assert.equal(phoneIdentities[1].revoked_at, null);
    assert.equal(phoneIdentities[1].is_primary, true);
    const credentials = (await pool.query(
      `SELECT phone_e164,revoked_at FROM account_phone_credentials
        WHERE organizer_id=$1 ORDER BY id`, [organizerId]
    )).rows;
    assert.equal(credentials.length, 2);
    assert.equal(credentials[0].phone_e164, oldPhone);
    assert.ok(credentials[0].revoked_at);
    assert.equal(credentials[1].phone_e164, newPhone);
    assert.equal(credentials[1].revoked_at, null);
    assert.equal((await pool.query(
      `SELECT COUNT(*)::int AS count FROM user_identity_verifications
        WHERE user_identity_id=$1 AND revoked_at IS NULL`, [oldIdentity.id]
    )).rows[0].count, 0);
    assert.deepEqual((await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM users) AS users,
              (SELECT COUNT(*)::int FROM organizers) AS organizers`
    )).rows[0], countsBefore);
    assert.equal((await fetch(`${baseUrl}/api/auth/me`, {
      headers: { cookie: account.sessionCookie }
    })).status, 200, 'phone replacement keeps the existing session and account');
  } finally {
    phoneVerification.startVerification = originalStartVerification;
    phoneVerification.checkVerification = originalCheckVerification;
  }
});

test('remembered guest cookies remain forgettable but never drive event-page greetings', async () => {
  resetRateLimits();
  const event = await createEvent({ slug: 'shared-laptop-one', title: 'Shared Laptop One' });
  const next = await createEvent({ slug: 'shared-laptop-two', title: 'Shared Laptop Two' });
  const rsvp = await fetch(`${baseUrl}/api/public/events/${event.slug}/rsvp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ full_name: 'Robin Shared', email: 'robin-shared@example.test' })
  });
  const guestCookie = responseCookie(rsvp, 'sge_guest');
  assert.ok(guestCookie);
  assert.match(await (await fetch(`${baseUrl}/e/${next.slug}`, { headers: { cookie: guestCookie } })).text(), /"returningGuest":null/);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie: guestCookie } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /sge_guest=;/);
  // Even if the old cookie lingered, the server no longer honors it.
  const after = await fetch(`${baseUrl}/e/${next.slug}`, { headers: { cookie: guestCookie } });
  assert.match(await after.text(), /"returningGuest":null/);
});

test('a forwarded invitation cannot act elsewhere or attach a different email to the invited identity', async () => {
  resetRateLimits();
  const invited = await createEvent({ slug: 'forwarded-invite-target', title: 'Forwarded Invite Target' });
  const elsewhere = await createEvent({ slug: 'forwarded-invite-elsewhere', title: 'Somewhere Else' });
  const identity = (await pool.query(
    `INSERT INTO organizers (email,name) VALUES ('lucas-forward@example.test','Lucas Forward') RETURNING id`
  )).rows[0];
  // Lucas already RSVP'd to another event under his verified identity.
  await createRsvp(elsewhere.id, { first_name: 'Lucas', email: 'lucas-forward@example.test', account_id: identity.id });
  const message = (await pool.query(
    `INSERT INTO message_log (event_id,recipient,recipient_name,message_type,channel,status)
     VALUES ($1,'lucas-forward@example.test','Lucas Forward','previous_guest_invite','email','sent') RETURNING id`,
    [invited.id]
  )).rows[0];
  const invitation = await createGuestInvitation(pool, {
    messageLogId: message.id, eventId: invited.id, eventDate: invited.event_date,
    email: 'lucas-forward@example.test', recipientName: 'Lucas Forward'
  });

  // Lucas forwards the email; his friend opens it.
  const opened = await fetch(`${baseUrl}/g/${invitation.token}`, { redirect: 'manual' });
  assert.equal(opened.headers.get('location'), `/e/${invited.slug}?invite=${encodeURIComponent(invitation.token)}`);
  assert.equal(responseCookie(opened, 'sge_guest'), '');

  const cancelElsewhere = await fetch(`${baseUrl}/api/public/events/${elsewhere.slug}/returning-rsvp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response: 'not_going', inviteToken: invitation.token })
  });
  assert.equal(cancelElsewhere.status, 401);
  const { rows: untouched } = await pool.query(
    `SELECT status FROM rsvps WHERE event_id=$1 AND email='lucas-forward@example.test'`, [elsewhere.id]
  );
  assert.equal(untouched[0].status, 'confirmed');

  const answerInvited = await fetch(`${baseUrl}/api/public/events/${invited.slug}/rsvp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      full_name: 'Forwarded Friend',
      email: 'friend-forward@example.test',
      inviteToken: invitation.token
    })
  });
  assert.equal(answerInvited.status, 201);
  const friendRsvp = (await pool.query(
    `SELECT account_id FROM rsvps WHERE event_id=$1 AND email='friend-forward@example.test'`, [invited.id]
  )).rows[0];
  assert.equal(friendRsvp.account_id, null);
  assert.equal((await pool.query(
    'SELECT rsvp_id FROM guest_invitation_tokens WHERE message_log_id=$1', [message.id]
  )).rows[0].rsvp_id, null);
});

test('rejoining after cancelling needs an emailed code, then signs in globally and keeps the new details', async () => {
  resetRateLimits();
  const event = await createEvent({ slug: 'rejoin-night', title: 'Rejoin Night', comments_enabled: true });
  const email = 'rejoin@example.test';
  await createRsvp(event.id, { first_name: 'Sam', last_name: 'Original', email, status: 'cancelled', manage_token: 'rejoin-token' });

  // Someone who merely knows the email cannot overwrite the cancelled RSVP.
  const stranger = await fetch(`${baseUrl}/api/public/events/${event.slug}/rsvp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ full_name: 'Not Sam', email, phone: '+14155550123', sms_optin: true })
  });
  assert.equal(stranger.status, 409);
  const strangerBody = await stranger.json();
  assert.equal(strangerBody.error, 'verification_required');
  assert.equal(strangerBody.maskedEmail, 'r•••@example.test');
  const { rows: stillCancelled } = await pool.query('SELECT status, last_name FROM rsvps WHERE event_id=$1', [event.id]);
  assert.deepEqual(stillCancelled[0], { status: 'cancelled', last_name: 'Original' });

  // Sam, on a new phone: request a code, type it, and the retry goes through.
  const codeRequest = await fetch(`${baseUrl}/api/auth/guest-code`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email })
  });
  assert.equal(codeRequest.status, 200);
  const requestCookie = responseCookie(codeRequest, 'sge_sign_in');
  const { code } = lastDevEmail(email, 'verification_code');
  const verified = await fetch(`${baseUrl}/api/auth/verify-code`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: requestCookie },
    body: JSON.stringify({ code })
  });
  assert.equal(verified.status, 200);
  const verifiedBody = await verified.json();
  assert.equal(verifiedBody.kind, 'guest');
  assert.equal(verifiedBody.firstName, 'Sam');
  const accountCookie = responseCookie(verified, 'sge_session');
  assert.ok(accountCookie, 'typing the guest verification code establishes the global account session');
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: accountCookie } })).status, 200);
  const guestCookie = responseCookie(verified, 'sge_guest');

  const rejoin = await fetch(`${baseUrl}/api/public/events/${event.slug}/rsvp`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: guestCookie },
    body: JSON.stringify({ full_name: 'Sam Updated', email })
  });
  assert.equal(rejoin.status, 201);
  assert.ok(responseCookie(rejoin, `sge_attendee_${event.id}`), 'the proven owner gets comment access');
  const { rows: rejoined } = await pool.query('SELECT status, last_name, account_id FROM rsvps WHERE event_id=$1', [event.id]);
  assert.equal(rejoined[0].status, 'confirmed');
  assert.equal(rejoined[0].last_name, 'Updated');
  assert.ok(rejoined[0].account_id);

  const forget = await fetch(`${baseUrl}/api/public/guest-session/forget`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${guestCookie}; ${accountCookie}` },
    body: JSON.stringify({ eventSlug: event.slug })
  });
  assert.match(forget.headers.get('set-cookie') || '', /sge_guest=;/);
  assert.match(forget.headers.get('set-cookie') || '', /sge_session=;/,
    'Not Sam clears the promoted global session on this browser too');
});

test('"already on the list" says truthfully whether a confirmation email went out', async () => {
  resetRateLimits();
  const event = await createEvent({ slug: 'truthful-resend', title: 'Truthful Resend' });
  const email = 'truthful@example.test';
  const first = await fetch(`${baseUrl}/api/public/events/${event.slug}/rsvp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ full_name: 'True Person', email })
  });
  assert.equal(first.status, 201);
  await waitForConfirmation(email);
  const again = await fetch(`${baseUrl}/api/public/events/${event.slug}/rsvp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ full_name: 'True Person', email })
  });
  assert.deepEqual(await again.json(), { ok: true, alreadyRsvpd: true, confirmationResent: false });

  await pool.query(
    `UPDATE message_log SET sent_at=NOW() - INTERVAL '20 minutes', created_at=NOW() - INTERVAL '20 minutes'
      WHERE recipient=$1 AND message_type='rsvp_confirmation'`,
    [email]
  );
  const later = await fetch(`${baseUrl}/api/public/events/${event.slug}/rsvp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ full_name: 'True Person', email })
  });
  assert.equal((await later.json()).confirmationResent, true);
});

test('hosts see who can’t make it, and the admin Hosts list excludes RSVP-only identities', async () => {
  resetRateLimits();
  const event = await createEvent({ slug: 'cant-make-it', title: 'Can’t Make It Night' });
  await createRsvp(event.id, { first_name: 'Dana', last_name: 'Declines', email: 'dana-declines@example.test', status: 'cancelled' });
  await createRsvp(event.id, { first_name: 'Gia', last_name: 'Going', email: 'gia-going@example.test' });
  const faces = await (await fetch(`${baseUrl}/api/events/${event.id}/familiar-faces`, {
    headers: { cookie: `sge_session=${signSession(organizerId)}` }
  })).json();
  const dana = faces.faces.find(face => face.name === 'Dana Declines');
  assert.equal(dana.status, 'Can’t make it');
  assert.equal(dana.canInvite, false);
  assert.equal(faces.faces.find(face => face.name === 'Gia Going').status, 'RSVP’d');

  const admin = (await pool.query(
    `INSERT INTO organizers (email,name,is_admin,last_login_at) VALUES ('hosts-admin@example.test','Hosts Admin',TRUE,NOW()) RETURNING id`
  )).rows[0];
  await pool.query(`INSERT INTO organizers (email,name) VALUES ('rsvp-only-identity@example.test','RSVP Only')`);
  const hosts = await (await fetch(`${baseUrl}/api/admin/hosts`, {
    headers: { cookie: `sge_session=${signSession(admin.id)}` }
  })).json();
  const emails = hosts.hosts.map(host => host.email);
  assert.ok(emails.includes('host@example.test'));
  assert.ok(emails.includes('hosts-admin@example.test'));
  assert.ok(!emails.includes('rsvp-only-identity@example.test'));
  assert.ok(hosts.guestIdentityCount >= 1);
});

test('Admin Events securely searches and filters every host event while reusing only eligible draft workspaces', async () => {
  resetRateLimits();
  const operator = await createAdminOperator('events-support@example.test', 'support');
  const adminCookie = await signInAdminOperator(operator.email);
  const signedOutPage = await fetch(`${baseUrl}/admin/events`, { redirect: 'manual' });
  assert.equal(signedOutPage.status, 302);
  assert.match(signedOutPage.headers.get('location') || '', /^\/admin\/login/);
  const signedOutApi = await fetch(`${baseUrl}/api/admin/events`);
  assert.equal(signedOutApi.status, 401);
  const customerApi = await fetch(`${baseUrl}/api/admin/events`, {
    headers: { cookie: `sge_session=${signSession(organizerId)}` }
  });
  assert.equal(customerApi.status, 403);
  const page = await fetch(`${baseUrl}/admin/events`, { headers: { cookie: adminCookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /data-admin-section="events"/);

  await pool.query(
    `UPDATE organizers SET name='Harbor Host',org_name='Harbor House',public_slug='harbor-house'
      WHERE id=$1`,
    [organizerId]
  );
  const secondHost = (await pool.query(
    `INSERT INTO organizers (email,name,org_name,public_slug,last_login_at)
     VALUES ('north-star@example.test','Nora Star','North Star Studio','north-star-studio',NOW())
     RETURNING id,user_id`
  )).rows[0];
  secondHost.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [secondHost.id]
  )).rows[0].user_id;
  const insertEvent = async (hostId, values) => (await pool.query(
    `INSERT INTO events
       (organizer_id,slug,title,event_date,start_time,timezone,venue_name,visibility,
        secret_show_enabled,admission_type,status,archived_at)
     VALUES ($1,$2,$3,$4,$5,'America/Los_Angeles',$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [hostId, values.slug, values.title, values.date, values.time || '19:00', values.venue || 'Main Hall',
      values.visibility || 'public', Boolean(values.secret), values.admission || 'free_rsvp',
      values.status || 'published', values.archived || null]
  )).rows[0];

  const live = await insertEvent(organizerId, {
    slug: 'admin-events-live', title: 'Harbor Future', date: '2099-06-10'
  });
  const ownerDraft = await insertEvent(organizerId, {
    slug: 'admin-events-owner-draft', title: 'Owner Draft', date: '2099-07-10', status: 'draft'
  });
  await insertEvent(organizerId, {
    slug: 'admin-events-past', title: 'Harbor Archive Night', date: '2001-04-12',
    visibility: 'private', admission: 'paid'
  });
  await insertEvent(organizerId, {
    slug: 'admin-events-archived', title: 'Cancelled Archive', date: '2099-08-10',
    admission: 'external_tickets', status: 'cancelled', archived: '2026-09-01T12:00:00Z'
  });
  await insertEvent(secondHost.id, {
    slug: 'admin-events-secret', title: 'North Star Secret', date: '2099-09-10',
    visibility: 'private', secret: true
  });
  const dfyDraft = await insertEvent(secondHost.id, {
    slug: 'admin-events-dfy-draft', title: 'North Star Draft', date: '2099-10-10',
    visibility: 'private', admission: 'silver_glider_tickets', status: 'draft'
  });
  const marker = (await pool.query(
    `INSERT INTO admin_done_for_you_clients (target_user_id,created_by_admin_operator_id)
     VALUES ($1,$2) RETURNING id`,
    [secondHost.user_id, operator.id]
  )).rows[0];
  await createRsvp(live.id, { email: 'confirmed-admin-events@example.test', status: 'confirmed' });
  await createRsvp(live.id, { email: 'cancelled-admin-events@example.test', status: 'cancelled' });

  const load = async query => {
    const response = await fetch(`${baseUrl}/api/admin/events${query || ''}`, {
      headers: { cookie: adminCookie }
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const all = await load();
  assert.equal(all.pagination.total, 6, 'default includes drafts, cancelled, past, and archived events');
  assert.equal(all.events.length, 6);
  assert.equal(all.events.find(event => event.id === live.id).rsvp_count, 1,
    'only confirmed RSVP records are counted');
  assert.equal(all.events.find(event => event.id === ownerDraft.id).done_for_you_client_id, null,
    'ordinary owner drafts are never granted an admin editor workspace');
  assert.equal(all.events.find(event => event.id === dfyDraft.id).done_for_you_client_id, Number(marker.id));
  assert.equal(all.events.find(event => event.slug === 'admin-events-secret').done_for_you_client_id, null,
    'published Done For You events remain outside the draft editor');
  assert.ok(all.hosts.some(host => host.id === Number(secondHost.id) && host.event_count === 2));
  const serialized = JSON.stringify(all);
  for (const forbidden of ['photo_upload_token', 'photo_short_token', 'secret_show_code_hash',
    'confirmed-admin-events@example.test', 'cancelled-admin-events@example.test']) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} must stay out of the directory response`);
  }

  assert.equal((await load('?status=published')).pagination.total, 3);
  assert.equal((await load('?status=draft')).pagination.total, 2);
  assert.equal((await load('?status=cancelled')).pagination.total, 1);
  assert.equal((await load('?timing=past')).pagination.total, 1);
  assert.equal((await load('?timing=upcoming')).pagination.total, 5);
  assert.equal((await load('?visibility=public')).pagination.total, 3);
  assert.equal((await load('?visibility=private')).pagination.total, 2);
  assert.equal((await load('?visibility=secret')).pagination.total, 1);
  assert.equal((await load('?admission=external_tickets')).pagination.total, 2,
    'legacy paid events normalize into the external-ticket filter');
  assert.equal((await load('?archived=archived')).pagination.total, 1);
  assert.equal((await load(`?host=${secondHost.id}`)).pagination.total, 2);
  assert.equal((await load('?q=north%20star')).pagination.total, 2);
  assert.equal((await load(`?host=${secondHost.id}&status=published&timing=upcoming&visibility=secret`)).pagination.total, 1);
  const secondPage = await load('?per_page=2&page=2');
  assert.deepEqual({ page: secondPage.pagination.page, pages: secondPage.pagination.pages,
    count: secondPage.events.length }, { page: 2, pages: 3, count: 2 });

  const invalid = await fetch(`${baseUrl}/api/admin/events?visibility=members-only`, {
    headers: { cookie: adminCookie }
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'invalid_event_filter');

  const opened = await openDoneForYouEditor(adminCookie, marker.id, dfyDraft.id);
  assert.equal(opened.body.workspace.eventId, Number(dfyDraft.id));
  assert.match(opened.body.redirect, new RegExp(`id=${dfyDraft.id}`));
});

test('upcoming events offer every past guest once as a face and invite them without leaving the event', async () => {
  const cookie = `sge_session=${signSession(organizerId)}`;
  const target = await createEvent({ slug: 'people-halloween', title: 'Halloween at Corbett', event_date: '2030-10-30' });
  const birthday = await createEvent({ slug: 'people-birthday', title: 'Birthday Bash', event_date: '2020-05-01' });
  const summer = await createEvent({ slug: 'people-summer', title: 'Summer Social', event_date: '2020-07-01' });

  // Lucas came twice; Casey once, with a +1; the rest must never be offered.
  await createRsvp(birthday.id, { first_name: 'Lucas', last_name: 'Moon', email: 'lucas-people@example.test' });
  const lucasSummer = await createRsvp(summer.id, { first_name: 'Lucas', last_name: 'Moon', email: 'LUCAS-people@example.test' });
  const casey = await createRsvp(birthday.id, {
    first_name: 'Casey', last_name: 'Gee', email: 'casey-people@example.test',
    guest_first_name: 'Maya', guest_last_name: 'Guest'
  });
  await createRsvp(birthday.id, { first_name: 'Uma', email: 'uma-people@example.test' });
  await pool.query(`INSERT INTO follower_optouts (organizer_id, email) VALUES ($1,'uma-people@example.test')`, [organizerId]);
  const ana = await createRsvp(birthday.id, { first_name: 'Ana', email: 'ana-people@example.test' });
  await createRsvp(target.id, { first_name: 'Ana', email: 'ana-people@example.test' });
  await createRsvp(birthday.id, { first_name: 'Dee', email: 'dee-people@example.test' });
  await createRsvp(target.id, { first_name: 'Dee', email: 'dee-people@example.test', status: 'cancelled' });
  await createRsvp(birthday.id, { first_name: 'Ivy', email: 'ivy-people@example.test' });
  const priorBatch = (await pool.query(
    `INSERT INTO previous_guest_invitation_batches (target_event_id, source_event_id, source_event_title, status, recipient_count)
     VALUES ($1,$2,'Birthday Bash','sent',1) RETURNING id`, [target.id, birthday.id]
  )).rows[0];
  await pool.query(
    `INSERT INTO message_log (event_id, previous_guest_invitation_batch_id, recipient, recipient_name, message_type, channel, status)
     VALUES ($1,$2,'ivy-people@example.test','Ivy','previous_guest_invite','email','sent')`, [target.id, priorBatch.id]
  );
  await createRsvp(birthday.id, { first_name: 'Carl', email: 'carl-people@example.test', status: 'cancelled' });
  const otherHost = (await pool.query(
    `INSERT INTO organizers (email, org_name, public_slug) VALUES ('other-people-host@example.test','Other','other-people') RETURNING id`
  )).rows[0];
  const otherEvent = (await pool.query(
    `INSERT INTO events (organizer_id, slug, title, event_date, start_time, venue_name, visibility, status)
     VALUES ($1,'other-people-past','Other Past','2020-06-01','20:00','Hall','public','published') RETURNING id`,
    [otherHost.id]
  )).rows[0];
  const otto = await createRsvp(otherEvent.id, { first_name: 'Otto', email: 'otto-people@example.test' });

  const load = async query => (await fetch(`${baseUrl}/api/events/${target.id}/familiar-faces/people${query || ''}`, { headers: { cookie } })).json();
  const all = await load();
  assert.equal(all.canInvite, true);
  assert.deepEqual(all.people.map(face => face.name), ['Lucas Moon', 'Casey Gee'], 'regulars first, each person once');
  const lucas = all.people[0];
  assert.equal(lucas.detail, '2 of your events');
  assert.equal(lucas.id, `rsvp:${lucasSummer.id}`, 'the most recent RSVP names the invitation’s source');
  assert.equal(lucas.avatarEmoji, attendeeAvatar('email:lucas-people@example.test'));
  assert.equal(all.people[1].detail, 'Birthday Bash');
  assert.deepEqual(all.plusOnes.map(face => [face.name, face.detail]), [['Maya Guest', 'Casey’s +1']]);
  assert.equal(all.unsubscribedCount, 1);
  assert.deepEqual(all.sources.map(source => source.title), ['Summer Social', 'Birthday Bash']);
  assert.equal(all.total, 2);
  assert.equal(all.hasMore, false);
  assert.ok(!JSON.stringify(all).includes('@example.test'), 'emails are searchable but never sent to the page');

  assert.deepEqual((await load('?search=casey-people%40')).people.map(face => face.name), ['Casey Gee']);
  assert.deepEqual((await load('?search=maya')).plusOnes.map(face => face.name), ['Maya Guest']);
  const summerOnly = await load(`?sourceEventId=${summer.id}`);
  assert.deepEqual(summerOnly.people.map(face => [face.name, face.detail]), [['Lucas Moon', 'Summer Social']]);
  assert.deepEqual(summerOnly.plusOnes, []);

  const invite = await fetch(`${baseUrl}/api/events/${target.id}/familiar-faces/people/invite`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ faceIds: [lucas.id, all.people[1].id, `rsvp:${ana.id}`, `rsvp:${otto.id}`, `guest:${casey.id}`] })
  });
  assert.equal(invite.status, 202);
  assert.equal((await invite.json()).queued, 2, 'only Lucas and Casey are eligible');

  let deliveries = [];
  for (let attempt = 0; attempt < 80; attempt += 1) {
    deliveries = (await pool.query(
      `SELECT ml.recipient, ml.status, b.source_event_title
         FROM message_log ml JOIN previous_guest_invitation_batches b ON b.id=ml.previous_guest_invitation_batch_id
        WHERE ml.event_id=$1 AND ml.recipient <> 'ivy-people@example.test' ORDER BY ml.recipient`,
      [target.id]
    )).rows;
    if (deliveries.length === 2 && deliveries.every(row => row.status === 'sent')) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.deepEqual(deliveries, [
    { recipient: 'casey-people@example.test', status: 'sent', source_event_title: 'Birthday Bash' },
    { recipient: 'lucas-people@example.test', status: 'sent', source_event_title: 'Summer Social' }
  ]);

  const after = await load();
  assert.deepEqual(after.people, [], 'invited people move up into the connected faces');
  const connected = await (await fetch(`${baseUrl}/api/events/${target.id}/familiar-faces`, { headers: { cookie } })).json();
  assert.equal(connected.faces.filter(face => face.status === 'Invited').length, 3);

  const again = await fetch(`${baseUrl}/api/events/${target.id}/familiar-faces/people/invite`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ faceIds: [lucas.id] })
  });
  assert.equal(again.status, 409);

  const pastTarget = await (await fetch(`${baseUrl}/api/events/${summer.id}/familiar-faces/people`, { headers: { cookie } })).json();
  assert.equal(pastTarget.canInvite, false);
  const strangers = await fetch(`${baseUrl}/api/events/${target.id}/familiar-faces/people`, {
    headers: { cookie: `sge_session=${signSession(otherHost.id)}` }
  });
  assert.equal(strangers.status, 404);
});

test('Familiar Faces dedupes canonical aliases without merging different canonical people', async () => {
  const cookie = `sge_session=${signSession(organizerId)}`;
  const target = await createEvent({
    slug: 'canonical-faces-target', title: 'Canonical Faces Target', event_date: '2030-11-01'
  });
  const aliasPast = await createEvent({
    slug: 'canonical-alias-past', title: 'Alias Past', event_date: '2020-04-01'
  });
  const aliasRecent = await createEvent({
    slug: 'canonical-alias-recent', title: 'Alias Recent', event_date: '2020-04-02'
  });
  const sharedPast = await createEvent({
    slug: 'canonical-shared-past', title: 'Shared Past', event_date: '2020-04-03'
  });
  const sharedRecent = await createEvent({
    slug: 'canonical-shared-recent', title: 'Shared Recent', event_date: '2020-04-04'
  });
  const aliasPerson = (await pool.query(
    `INSERT INTO organizers (email,name)
     VALUES ('alias-current@example.test','Alias Person') RETURNING id`
  )).rows[0];
  const connectedPerson = (await pool.query(
    `INSERT INTO organizers (email,name)
     VALUES ('shared-snapshot@example.test','Connected Person') RETURNING id`
  )).rows[0];
  const separatePerson = (await pool.query(
    `INSERT INTO organizers (email,name)
     VALUES ('separate-person@example.test','Separate Person') RETURNING id`
  )).rows[0];
  for (const person of [aliasPerson, connectedPerson, separatePerson]) {
    person.user_id = (await pool.query(
      'SELECT user_id FROM organizers WHERE id=$1', [person.id]
    )).rows[0].user_id;
  }

  await createRsvp(aliasPast.id, {
    first_name: 'Alias', last_name: 'Person', email: 'alias-old@example.test', user_id: aliasPerson.user_id
  });
  const latestAlias = await createRsvp(aliasRecent.id, {
    first_name: 'Alias', last_name: 'Person', email: 'alias-current@example.test', user_id: aliasPerson.user_id
  });
  await createRsvp(sharedPast.id, {
    first_name: 'Connected', last_name: 'Person', email: 'shared-snapshot@example.test',
    user_id: connectedPerson.user_id
  });
  await createRsvp(sharedRecent.id, {
    first_name: 'Separate', last_name: 'Person', email: 'shared-snapshot@example.test',
    user_id: separatePerson.user_id
  });
  await createRsvp(target.id, {
    first_name: 'Connected', last_name: 'Person', email: 'shared-snapshot@example.test',
    user_id: connectedPerson.user_id
  });

  const payload = await (await fetch(
    `${baseUrl}/api/events/${target.id}/familiar-faces/people`, { headers: { cookie } }
  )).json();
  assert.equal(payload.total, 2);
  const aliasFace = payload.people.find(face => face.name === 'Alias Person');
  assert.equal(aliasFace.id, `rsvp:${latestAlias.id}`);
  assert.equal(aliasFace.eventCount, 2, 'different email snapshots for one user stay one face');
  assert.equal(aliasFace.detail, '2 of your events');
  assert.ok(payload.people.some(face => face.name === 'Separate Person'),
    'a different non-null user remains eligible even when its email snapshot matches');
  assert.ok(!payload.people.some(face => face.name === 'Connected Person'),
    'only the canonical person already connected to the target is excluded');

  const invite = await fetch(`${baseUrl}/api/events/${target.id}/familiar-faces/people/invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ faceIds: [aliasFace.id] })
  });
  assert.equal(invite.status, 202);
  assert.equal((await invite.json()).queued, 1);
  const delivery = (await pool.query(
    `SELECT recipient_user_id FROM message_log
      WHERE event_id=$1 AND message_type='previous_guest_invite'`,
    [target.id]
  )).rows[0];
  assert.equal(Number(delivery.recipient_user_id), Number(aliasPerson.user_id));
});

test('past-event pickers explain why a face can’t be selected', async () => {
  const cookie = `sge_session=${signSession(organizerId)}`;
  const past = await createEvent({ slug: 'picker-notes', title: 'Picker Notes', event_date: '2020-03-03' });
  await createRsvp(past.id, { first_name: 'Una', email: 'una-picker@example.test' });
  await pool.query(`INSERT INTO follower_optouts (organizer_id, email) VALUES ($1,'una-picker@example.test')`, [organizerId]);
  await createRsvp(past.id, { first_name: 'Ok', email: 'ok-picker@example.test' });
  const faces = await (await fetch(`${baseUrl}/api/events/${past.id}/familiar-faces`, { headers: { cookie } })).json();
  assert.equal(faces.faces.find(face => face.name === 'Una Person').note, 'Unsubscribed');
  assert.equal(faces.faces.find(face => face.name === 'Ok Person').note, null);
});

test('an event-scoped attendee cookie restores that RSVP on reload and nowhere else', async () => {
  resetRateLimits();
  const event = await createEvent({
    slug: 'attendee-cookie-reload',
    title: 'Attendee Cookie Reload',
    comments_enabled: true
  });
  const other = await createEvent({
    slug: 'attendee-cookie-other',
    title: 'Attendee Cookie Other'
  });

  const created = await fetch(`${baseUrl}/api/public/events/${event.slug}/rsvp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ full_name: 'Cookie Guest', email: 'cookie-guest@example.test' })
  });
  assert.equal(created.status, 201);
  const payload = await created.json();
  const attendeeCookie = responseCookie(created, `sge_attendee_${event.id}`);
  assert.ok(attendeeCookie);

  const reloaded = await fetch(`${baseUrl}/e/${event.slug}`, {
    headers: { cookie: attendeeCookie }
  });
  const reloadedHtml = await reloaded.text();
  assert.match(reloaded.headers.get('cache-control') || '', /private, no-store/);
  assert.match(reloadedHtml, new RegExp(
    `"returningGuest":\\{"firstName":"Cookie","source":"attendee","response":"going","calendarUrl":"\\/r\\/${payload.rsvpToken}\\/calendar\\.ics"\\}`
  ));

  const unrelatedHtml = await (await fetch(`${baseUrl}/e/${other.slug}`, {
    headers: { cookie: attendeeCookie }
  })).text();
  assert.match(unrelatedHtml, /"returningGuest":null/);
});

test('a personal link from the guest’s own email shows their RSVP on that event only', async () => {
  resetRateLimits();
  const event = await createEvent({ slug: 'personal-link-night', title: 'Personal Link Night' });
  const other = await createEvent({ slug: 'personal-link-other', title: 'Somewhere Else' });
  await createRsvp(event.id, { first_name: 'Lucas', email: 'lucas-link@example.test', manage_token: 'personal-link-token' });

  const opened = await fetch(`${baseUrl}/r/personal-link-token/event`, { redirect: 'manual' });
  assert.equal(opened.status, 303);
  assert.equal(opened.headers.get('location'), `/e/${event.slug}?rsvp=personal-link-token`);
  const attendeeCookie = responseCookie(opened, `sge_attendee_${event.id}`);
  assert.ok(attendeeCookie);

  const personalUrl = `${baseUrl}/e/${event.slug}?rsvp=personal-link-token`;
  const page = await (await fetch(personalUrl)).text();
  assert.match(page, /"returningGuest":\{"firstName":"Lucas","source":"rsvp","response":"going","calendarUrl":"\/r\/personal-link-token\/calendar\.ics"\}/);

  const change = await fetch(`${baseUrl}/api/public/events/${event.slug}/returning-rsvp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response: 'not_going', rsvpToken: 'personal-link-token' })
  });
  assert.equal(change.status, 200);
  assert.equal((await pool.query(`SELECT status FROM rsvps WHERE manage_token='personal-link-token'`)).rows[0].status, 'cancelled');
  assert.match(await (await fetch(personalUrl)).text(),
    /"returningGuest":\{"firstName":"Lucas","source":"rsvp","response":"not_going","calendarUrl":"\/r\/personal-link-token\/calendar\.ics"\}/);

  // The proof is per event: it doesn't recognize Lucas anywhere else.
  assert.match(await (await fetch(`${baseUrl}/e/${other.slug}`, { headers: { cookie: attendeeCookie } })).text(),
    /"returningGuest":null/);

  // "Not Lucas?" forgets this event's attendee access too.
  const forget = await fetch(`${baseUrl}/api/public/guest-session/forget`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: attendeeCookie },
    body: JSON.stringify({ eventSlug: event.slug })
  });
  assert.match(forget.headers.get('set-cookie'), new RegExp(`sge_attendee_${event.id}=;`));
});

test('“already on the list” in a new browser can be managed there after an emailed code', async () => {
  resetRateLimits();
  const event = await createEvent({ slug: 'already-listed-night', title: 'Already Listed Night' });
  const email = 'already-listed@example.test';
  await createRsvp(event.id, { first_name: 'Robin', email });

  const again = await fetch(`${baseUrl}/api/public/events/${event.slug}/rsvp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ full_name: 'Robin Person', email })
  });
  assert.equal((await again.json()).alreadyRsvpd, true);
  assert.equal(responseCookie(again, 'sge_guest'), '', 'typing an email alone never remembers the browser');

  const codeRequest = await fetch(`${baseUrl}/api/auth/guest-code`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email })
  });
  const verified = await fetch(`${baseUrl}/api/auth/verify-code`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: responseCookie(codeRequest, 'sge_sign_in') },
    body: JSON.stringify({ code: lastDevEmail(email, 'verification_code').code })
  });
  assert.equal(verified.status, 200);
  const page = await (await fetch(`${baseUrl}/e/${event.slug}`, {
    headers: { cookie: responseCookie(verified, 'sge_session') }
  })).text();
  assert.match(page, /"returningGuest":\{"firstName":"Robin","source":"account","response":"going","calendarUrl":"\/r\/[^"]+\/calendar\.ics"\}/);
});

test('a bookmarked /events/:id lands on the manage page, and Create your event opens the builder', async () => {
  const event = await createEvent({ slug: 'bookmarked-event', title: 'Bookmarked Event' });
  const cookie = `sge_session=${signSession(organizerId)}`;

  const owner = await fetch(`${baseUrl}/events/${event.id}`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(owner.status, 302);
  assert.equal(owner.headers.get('location'), `/events/${event.id}/manage`);

  const edit = await fetch(`${baseUrl}/events/${event.id}/edit`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(edit.status, 302);
  assert.equal(edit.headers.get('location'), `/e/${event.slug}?edit=details`);

  const signedOut = await fetch(`${baseUrl}/events/${event.id}`, { redirect: 'manual' });
  assert.equal(signedOut.headers.get('location'), '/login');

  const notAnId = await fetch(`${baseUrl}/events/not-an-id`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(notAnId.status, 404);

  // Unchanged flow: the home CTA still goes through sign-in, but lands in the builder.
  const home = await (await fetch(`${baseUrl}/`)).text();
  assert.match(home, /href="\/login\?next=%2Fevents%2Fnew"[^>]*>Create your event</);
  const signedInLogin = await fetch(`${baseUrl}/login?next=%2Fevents%2Fnew`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(signedInLogin.headers.get('location'), '/events/new');
});

test('profile stats count past events attended elsewhere and past events hosted', async () => {
  const cookie = `sge_session=${signSession(organizerId)}`;
  const organizerUserId = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [organizerId]
  )).rows[0].user_id;
  const hostedPast = await createEvent({ slug: 'stats-hosted-past', event_date: '2020-02-02' });
  await createEvent({ slug: 'stats-hosted-future', event_date: '2099-02-02' });
  await createEvent({ slug: 'stats-hosted-draft', event_date: '2020-03-03', status: 'draft' });
  const otherHost = (await pool.query(
    `INSERT INTO organizers (email, org_name, public_slug) VALUES ('stats-host@example.test','Stats Host','stats-host') RETURNING id`
  )).rows[0];
  const insertOther = async (slug, date, status = 'published') => (await pool.query(
    `INSERT INTO events (organizer_id, slug, title, event_date, start_time, venue_name, visibility, status)
     VALUES ($1,$2,'Other','${date}','20:00','Hall','public',$3) RETURNING id`,
    [otherHost.id, slug, status]
  )).rows[0];
  const went = await insertOther('stats-went', '2020-04-04');
  const cancelled = await insertOther('stats-cancelled', '2020-05-05');
  const upcoming = await insertOther('stats-upcoming', '2099-05-05');
  const cancelledEvent = await insertOther('stats-event-cancelled', '2020-06-06', 'cancelled');
  await createRsvp(hostedPast.id, { account_id: organizerId });
  await createRsvp(went.id, {
    account_id: null, user_id: organizerUserId, email: 'old-stats-alias@example.test'
  });
  await createRsvp(went.id, { account_id: organizerId });
  await createRsvp(cancelled.id, { account_id: organizerId, status: 'cancelled' });
  await createRsvp(upcoming.id, { account_id: organizerId });
  await createRsvp(cancelledEvent.id, { account_id: organizerId });

  const response = await fetch(`${baseUrl}/api/me/stats`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { attended: 1, hosted: 1 });
  assert.equal((await fetch(`${baseUrl}/api/me/stats`)).status, 401);
});

test('admin login returns while passcode delivery is still pending', async () => {
  resetRateLimits();
  const operator = await createAdminOperator('nonblocking-admin@example.test', 'super_admin');
  let releaseDelivery;
  let deliveryStarted = false;
  let deliveryFinished = false;
  const deliveryGate = new Promise(resolve => { releaseDelivery = resolve; });
  adminAuthRoutes.setAdminPasscodeSenderForTests(async () => {
    deliveryStarted = true;
    await deliveryGate;
    deliveryFinished = true;
  });

  let timeout;
  try {
    const response = await Promise.race([
      fetch(`${baseUrl}/api/admin/auth/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: operator.email })
      }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('login waited for the email provider')), 2500);
      })
    ]);
    clearTimeout(timeout);
    assert.equal(response.status, 200);
    assert.equal(deliveryStarted, true);
    assert.equal(deliveryFinished, false, 'provider completion is outside the response path');
  } finally {
    clearTimeout(timeout);
    releaseDelivery();
    await adminAuthRoutes.settleBackgroundWork();
    adminAuthRoutes.setAdminPasscodeSenderForTests();
  }
});

test('dedicated admin operators sign in without enumerating unknown or disabled emails', async () => {
  resetRateLimits();
  const activeEmail = 'dedicated-admin@example.test';
  const disabledEmail = 'disabled-admin@example.test';
  const operator = await createAdminOperator(activeEmail, 'super_admin');
  await createAdminOperator(disabledEmail, 'support', 'disabled');
  const legacyAdmin = (await pool.query(
    `INSERT INTO organizers (email,name,is_admin,last_login_at)
     VALUES ('legacy-boundary-admin@example.test','Legacy Boundary Admin',TRUE,NOW()) RETURNING id`
  )).rows[0];
  process.env.LEGACY_ADMIN_AUTH_ENABLED = 'false';
  try {
    const legacyApi = await fetch(`${baseUrl}/api/admin/accounts`, {
      headers: { cookie: `sge_session=${signSession(legacyAdmin.id)}` }
    });
    assert.equal(legacyApi.status, 401);
    const legacyPage = await fetch(`${baseUrl}/admin/accounts`, {
      redirect: 'manual',
      headers: { cookie: `sge_session=${signSession(legacyAdmin.id)}` }
    });
    assert.equal(legacyPage.status, 302);
    assert.equal(legacyPage.headers.get('location'), '/admin/login?next=%2Fadmin%2Faccounts');
  } finally {
    process.env.LEGACY_ADMIN_AUTH_ENABLED = 'true';
  }
  const outboxBefore = mailer.devOutbox.length;

  const unknown = await fetch(`${baseUrl}/api/admin/auth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'unknown-admin@example.test' })
  });
  assert.equal(unknown.status, 200);
  const unknownBody = await unknown.json();
  assert.deepEqual(unknownBody, { ok: true, codeLength: 6 });
  const unknownRequestCookie = responseCookie(unknown, 'sge_admin_sign_in');
  assert.ok(unknownRequestCookie);
  assert.equal(mailer.devOutbox.length, outboxBefore);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM admin_operators
      WHERE email='unknown-admin@example.test'`
  )).rows[0].count, 0, 'an unknown admin email is never provisioned');

  const disabled = await fetch(`${baseUrl}/api/admin/auth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: disabledEmail })
  });
  assert.equal(disabled.status, 200);
  assert.deepEqual(await disabled.json(), unknownBody);
  assert.equal(mailer.devOutbox.length, outboxBefore);

  const started = await fetch(`${baseUrl}/api/admin/auth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: activeEmail })
  });
  assert.equal(started.status, 200);
  assert.deepEqual(await started.json(), unknownBody);
  const requestCookie = responseCookie(started, 'sge_admin_sign_in');
  await adminAuthRoutes.settleBackgroundWork();
  const code = lastDevEmail(activeEmail, 'admin_passcode').code;
  const unknownVerify = await fetch(`${baseUrl}/api/admin/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: unknownRequestCookie },
    body: JSON.stringify({ code: '000000' })
  });
  const knownWrongVerify = await fetch(`${baseUrl}/api/admin/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: requestCookie },
    body: JSON.stringify({ code: code === '000000' ? '111111' : '000000' })
  });
  assert.equal(unknownVerify.status, 400);
  assert.equal(knownWrongVerify.status, unknownVerify.status);
  assert.deepEqual(await knownWrongVerify.json(), await unknownVerify.json(),
    'verification cannot turn the generic login start into an email-enumeration oracle');
  const verified = await fetch(`${baseUrl}/api/admin/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: requestCookie },
    body: JSON.stringify({ code })
  });
  assert.equal(verified.status, 200);
  const setCookie = verified.headers.get('set-cookie') || '';
  assert.match(setCookie, /sge_admin_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.deepEqual(await verified.json(), { ok: true, redirect: '/admin' });
  const sessionCookie = responseCookie(verified, 'sge_admin_session');
  assert.equal((await fetch(`${baseUrl}/admin/accounts`, {
    redirect: 'manual'
  })).headers.get('location'), '/admin/login?next=%2Fadmin%2Faccounts');
  assert.equal((await fetch(`${baseUrl}/admin/accounts`, {
    headers: { cookie: sessionCookie }
  })).status, 200);
  const me = await fetch(`${baseUrl}/api/admin/auth/me`, { headers: { cookie: sessionCookie } });
  assert.deepEqual(await me.json(), {
    operator: {
      id: Number(operator.id), email: activeEmail, role: 'super_admin', status: 'active', legacy: false
    },
    capabilities: {
      manageAccounts: true,
      manageIdentities: true,
      manageDoneForYou: true,
      suspendAccounts: true,
      deleteAccounts: true,
      manageOperators: true
    }
  });

  const proofTarget = (await pool.query(
    `INSERT INTO organizers (email,name,last_login_at)
     VALUES ('operator-proof-target@example.test','Operator Proof Target',NOW())
     RETURNING id,user_id`
  )).rows[0];
  proofTarget.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [proofTarget.id]
  )).rows[0].user_id;
  const deletionCookie = await adminDeletionProof(sessionCookie, proofTarget.user_id);

  const proofClient = await pool.connect();
  try {
    await proofClient.query('BEGIN');
    assert.equal(await adminAuthRoutes.consumeAdminActionProof(
      proofClient,
      { headers: { cookie: deletionCookie } },
      { operatorId: operator.id, action: 'account_delete', targetUserId: proofTarget.user_id }
    ), true);
    await proofClient.query('ROLLBACK');
  } finally {
    proofClient.release();
  }
  assert.equal((await pool.query(
    `SELECT consumed_at FROM admin_action_proofs
      WHERE operator_id=$1 ORDER BY id DESC LIMIT 1`,
    [operator.id]
  )).rows[0].consumed_at, null, 'rolling back the destructive transaction restores the proof');

  const pendingLogin = await fetch(`${baseUrl}/api/admin/auth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: activeEmail })
  });
  assert.equal(pendingLogin.status, 200);
  const pendingRequestCookie = responseCookie(pendingLogin, 'sge_admin_sign_in');
  await adminAuthRoutes.settleBackgroundWork();
  const pendingCode = lastDevEmail(activeEmail, 'admin_passcode').code;
  const beforeDisable = (await pool.query(
    'SELECT sessions_valid_after FROM admin_operators WHERE id=$1', [operator.id]
  )).rows[0].sessions_valid_after;

  const disabledOperator = (await pool.query(
    `UPDATE admin_operators SET status='disabled' WHERE id=$1
     RETURNING status,sessions_valid_after`,
    [operator.id]
  )).rows[0];
  assert.equal(disabledOperator.status, 'disabled');
  assert.ok(disabledOperator.sessions_valid_after > beforeDisable);
  assert.ok((await pool.query(
    `SELECT consumed_at FROM admin_action_proofs
      WHERE operator_id=$1 ORDER BY id DESC LIMIT 1`,
    [operator.id]
  )).rows[0].consumed_at, 'disabling consumes pending destructive-action proofs');
  assert.ok((await pool.query(
    `SELECT used_at FROM admin_auth_challenges
      WHERE operator_id=$1 AND purpose='login' ORDER BY id DESC LIMIT 1`,
    [operator.id]
  )).rows[0].used_at, 'disabling invalidates pending passcode challenges');

  const disabledSession = await fetch(`${baseUrl}/api/admin/auth/me`, {
    headers: { cookie: sessionCookie }
  });
  assert.equal(disabledSession.status, 401);
  assert.match(disabledSession.headers.get('set-cookie') || '', /sge_admin_session=;/);

  const reenabled = (await pool.query(
    `UPDATE admin_operators SET status='active' WHERE id=$1
     RETURNING sessions_valid_after`,
    [operator.id]
  )).rows[0];
  assert.ok(reenabled.sessions_valid_after > disabledOperator.sessions_valid_after,
    're-enabling advances the credential cutoff again');
  assert.equal((await fetch(`${baseUrl}/api/admin/auth/me`, {
    headers: { cookie: sessionCookie }
  })).status, 401, 're-enabling never resurrects a disabled session');

  const invalidatedChallenge = await fetch(`${baseUrl}/api/admin/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: pendingRequestCookie },
    body: JSON.stringify({ code: pendingCode })
  });
  assert.equal(invalidatedChallenge.status, 400);

  const freshSession = await signInAdminOperator(activeEmail);
  const actionProofCookie = deletionCookie.split('; ')
    .find(cookie => cookie.startsWith('sge_admin_action='));
  const invalidatedProof = await fetch(
    `${baseUrl}/api/admin/accounts/${proofTarget.user_id}/delete-account`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader(freshSession, actionProofCookie)
      },
      body: JSON.stringify({
        reason: 'This disabled operator proof must remain revoked',
        confirmation: `DELETE USER ${proofTarget.user_id}`
      })
    }
  );
  assert.equal(invalidatedProof.status, 403);
  assert.equal((await invalidatedProof.json()).error, 'admin_step_up_required');
});

test('operator roster access and mutations require dedicated target-bound Super Admin proof', async () => {
  resetRateLimits();
  const actor = await createAdminOperator('roster-actor@example.test', 'super_admin');
  const peer = await createAdminOperator('roster-peer@example.test', 'super_admin');
  const support = await createAdminOperator('roster-support@example.test', 'support');
  const actorSession = await signInAdminOperator(actor.email);
  const supportSession = await signInAdminOperator(support.email);
  const legacyAdmin = (await pool.query(
    `INSERT INTO organizers (email,name,is_admin,last_login_at)
     VALUES ('roster-legacy@example.test','Roster Legacy',TRUE,NOW()) RETURNING id`
  )).rows[0];
  const legacySession = `sge_session=${signSession(legacyAdmin.id)}`;

  const signedOutOverview = await fetch(`${baseUrl}/admin`, { redirect: 'manual' });
  assert.equal(signedOutOverview.status, 302);
  assert.equal(signedOutOverview.headers.get('location'), '/admin/login?next=%2Fadmin');
  assert.equal((await fetch(`${baseUrl}/admin`, {
    headers: { cookie: supportSession }
  })).status, 200, 'support operators can use the control-center overview');
  const supportTeamPage = await fetch(`${baseUrl}/admin/team`, {
    redirect: 'manual',
    headers: { cookie: supportSession }
  });
  assert.equal(supportTeamPage.status, 302);
  assert.equal(supportTeamPage.headers.get('location'), '/admin');
  assert.equal((await fetch(`${baseUrl}/admin/team`, {
    headers: { cookie: actorSession }
  })).status, 200, 'dedicated Super Admins can manage the operator roster');
  const legacyTeamPage = await fetch(`${baseUrl}/admin/team`, {
    redirect: 'manual',
    headers: { cookie: legacySession }
  });
  assert.equal(legacyTeamPage.status, 302);
  assert.equal(legacyTeamPage.headers.get('location'), '/admin');
  const exactOverviewNext = await fetch(`${baseUrl}/admin/login?next=%2Fadmin`, {
    redirect: 'manual',
    headers: { cookie: actorSession }
  });
  assert.equal(exactOverviewNext.headers.get('location'), '/admin');
  const loginLoopNext = await fetch(`${baseUrl}/admin/login?next=%2Fadmin%2Flogin%3Fx%3D1`, {
    redirect: 'manual',
    headers: { cookie: actorSession }
  });
  assert.equal(loginLoopNext.headers.get('location'), '/admin');

  assert.equal((await fetch(`${baseUrl}/api/admin/operators`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/admin/operators`, {
    headers: { cookie: supportSession }
  })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/admin/operators`, {
    headers: { cookie: legacySession }
  })).status, 403, 'legacy customer-admin sessions cannot manage independent operators');

  const actorMe = await fetch(`${baseUrl}/api/admin/auth/me`, {
    headers: { cookie: actorSession }
  });
  assert.equal((await actorMe.json()).capabilities.manageOperators, true);
  const supportMe = await fetch(`${baseUrl}/api/admin/auth/me`, {
    headers: { cookie: supportSession }
  });
  const supportCapabilities = (await supportMe.json()).capabilities;
  assert.equal(supportCapabilities.manageAccounts, true);
  assert.equal(supportCapabilities.suspendAccounts, true);
  assert.equal(supportCapabilities.deleteAccounts, false);
  assert.equal(supportCapabilities.manageOperators, false);
  const legacyMe = await fetch(`${baseUrl}/api/admin/auth/me`, {
    headers: { cookie: legacySession }
  });
  const legacyCapabilities = (await legacyMe.json()).capabilities;
  assert.equal(legacyCapabilities.manageAccounts, true);
  assert.equal(legacyCapabilities.deleteAccounts, false);
  assert.equal(legacyCapabilities.manageOperators, false);

  const initial = await fetch(`${baseUrl}/api/admin/operators`, {
    headers: { cookie: actorSession }
  });
  assert.equal(initial.status, 200);
  const initialBody = await initial.json();
  assert.equal(initialBody.operators.length, 3);
  assert.equal(initialBody.activeSuperAdminCount, 2);
  assert.deepEqual(initialBody.audit, []);

  const missingProof = await fetch(`${baseUrl}/api/admin/operators`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: actorSession },
    body: JSON.stringify({
      email: 'new-operator@example.test',
      role: 'support',
      reason: 'Cover the weekend support rotation'
    })
  });
  assert.equal(missingProof.status, 403);
  assert.equal((await missingProof.json()).error, 'admin_step_up_required');

  const creationProof = await adminOperatorProof(
    actorSession,
    'new:new-operator@example.test'
  );
  const created = await fetch(`${baseUrl}/api/admin/operators`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: creationProof },
    body: JSON.stringify({
      email: 'New-Operator@Example.Test',
      role: 'support',
      reason: 'Cover the weekend support rotation'
    })
  });
  assert.equal(created.status, 201);
  const createdOperator = (await created.json()).operator;
  assert.equal(createdOperator.email, 'new-operator@example.test');
  assert.equal(createdOperator.role, 'support');
  assert.equal(createdOperator.status, 'active');

  const reusedForAnotherTarget = await fetch(`${baseUrl}/api/admin/operators`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: creationProof },
    body: JSON.stringify({
      email: 'wrong-target@example.test',
      role: 'support',
      reason: 'This target was never verified'
    })
  });
  assert.equal(reusedForAnotherTarget.status, 403);
  assert.equal((await reusedForAnotherTarget.json()).error, 'admin_step_up_required');

  const supportProof = await adminOperatorProof(actorSession, `operator:${support.id}`);
  const wrongTarget = await fetch(`${baseUrl}/api/admin/operators/${peer.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: supportProof },
    body: JSON.stringify({ role: 'support', reason: 'Wrong target rollback check' })
  });
  assert.equal(wrongTarget.status, 403);
  assert.equal((await wrongTarget.json()).error, 'admin_step_up_required');
  const pendingProof = (await pool.query(
    `SELECT consumed_at FROM admin_action_proofs
      WHERE operator_id=$1 AND target_key=$2 ORDER BY id DESC LIMIT 1`,
    [actor.id, `operator:${support.id}`]
  )).rows[0];
  assert.equal(pendingProof.consumed_at, null,
    'a target mismatch rolls back without consuming the one-time proof');

  const promoted = await fetch(`${baseUrl}/api/admin/operators/${support.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: supportProof },
    body: JSON.stringify({ role: 'super_admin', reason: 'Promote the on-call lead' })
  });
  assert.equal(promoted.status, 200);
  assert.equal((await promoted.json()).operator.role, 'super_admin');
  assert.equal((await fetch(`${baseUrl}/api/admin/auth/me`, {
    headers: { cookie: supportSession }
  })).status, 401, 'a role change invalidates sessions minted for the previous role');

  const roster = await fetch(`${baseUrl}/api/admin/operators`, {
    headers: { cookie: actorSession }
  });
  const rosterBody = await roster.json();
  assert.deepEqual(rosterBody.audit.map(entry => entry.action), [
    'operator_updated',
    'operator_created'
  ]);
  assert.ok(rosterBody.audit.every(entry => entry.actorOperatorId === Number(actor.id)));
  assert.deepEqual(rosterBody.audit.map(entry => entry.actorEmail), [actor.email, actor.email]);

  await assert.rejects(
    pool.query(
      `UPDATE admin_operator_audit_log SET reason='rewritten history' WHERE id=$1`,
      [rosterBody.audit[0].id]
    ),
    /append-only|immutable/i
  );
  await assert.rejects(
    pool.query('DELETE FROM admin_operators WHERE id=$1', [createdOperator.id]),
    /retained for immutable audit attribution/i
  );
});

test('operator roster protects self/final Super Admin and explicitly revokes target sessions', async () => {
  resetRateLimits();
  const actor = await createAdminOperator('guard-actor@example.test', 'super_admin');
  const peer = await createAdminOperator('guard-peer@example.test', 'super_admin');
  const support = await createAdminOperator('guard-support@example.test', 'support');
  const actorSession = await signInAdminOperator(actor.email);
  const peerSession = await signInAdminOperator(peer.email);
  const supportSession = await signInAdminOperator(support.email);

  const selfProof = await adminOperatorProof(actorSession, `operator:${actor.id}`);
  const selfDemotion = await fetch(`${baseUrl}/api/admin/operators/${actor.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: selfProof },
    body: JSON.stringify({ role: 'support', reason: 'Self demotion must be blocked' })
  });
  assert.equal(selfDemotion.status, 409);
  assert.equal((await selfDemotion.json()).error, 'cannot_demote_self');
  const selfDisable = await fetch(`${baseUrl}/api/admin/operators/${actor.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: selfProof },
    body: JSON.stringify({ status: 'disabled', reason: 'Self disable must be blocked' })
  });
  assert.equal(selfDisable.status, 409);
  assert.equal((await selfDisable.json()).error, 'cannot_disable_self');

  const disablePeerProof = await adminOperatorProof(actorSession, `operator:${peer.id}`);
  const disabledPeer = await fetch(`${baseUrl}/api/admin/operators/${peer.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: disablePeerProof },
    body: JSON.stringify({ status: 'disabled', reason: 'Remove access during leave' })
  });
  assert.equal(disabledPeer.status, 200);
  assert.equal((await disabledPeer.json()).operator.status, 'disabled');
  assert.equal((await fetch(`${baseUrl}/api/admin/auth/me`, {
    headers: { cookie: peerSession }
  })).status, 401);

  const finalSuperAdmin = await fetch(`${baseUrl}/api/admin/operators/${actor.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: selfProof },
    body: JSON.stringify({ role: 'support', reason: 'Final administrator guard' })
  });
  assert.equal(finalSuperAdmin.status, 409);
  assert.equal((await finalSuperAdmin.json()).error, 'last_active_super_admin');

  const enablePeerProof = await adminOperatorProof(actorSession, `operator:${peer.id}`);
  const enabledPeer = await fetch(`${baseUrl}/api/admin/operators/${peer.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: enablePeerProof },
    body: JSON.stringify({ status: 'active', reason: 'Restore access after leave' })
  });
  assert.equal(enabledPeer.status, 200);
  assert.equal((await enabledPeer.json()).operator.status, 'active');
  assert.equal((await fetch(`${baseUrl}/api/admin/auth/me`, {
    headers: { cookie: peerSession }
  })).status, 401, 're-enabling cannot revive the session invalidated at disable time');

  const revokeProof = await adminOperatorProof(actorSession, `operator:${support.id}`);
  const revoked = await fetch(`${baseUrl}/api/admin/operators/${support.id}/revoke-sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: revokeProof },
    body: JSON.stringify({ reason: 'End sessions after device loss' })
  });
  assert.equal(revoked.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/admin/auth/me`, {
    headers: { cookie: supportSession }
  })).status, 401);
  const audit = (await pool.query(
    `SELECT action_type,actor_email,target_email
       FROM admin_operator_audit_log ORDER BY id`
  )).rows;
  assert.deepEqual(audit.map(entry => entry.action_type), [
    'operator_updated',
    'operator_updated',
    'operator_sessions_revoked'
  ]);
  assert.equal(audit[2].actor_email, actor.email);
  assert.equal(audit[2].target_email, support.email);
});

test('dedicated admin mutations enforce same-origin and retain the operator audit actor', async () => {
  resetRateLimits();
  const operator = await createAdminOperator('audited-operator@example.test', 'super_admin');
  const adminSession = await signInAdminOperator(operator.email);
  const target = (await pool.query(
    `INSERT INTO organizers (email,name,last_login_at)
     VALUES ('operator-audit-target@example.test','Operator Audit Target',NOW())
     RETURNING id,user_id`
  )).rows[0];
  target.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [target.id]
  )).rows[0].user_id;

  const crossOriginLogout = await fetch(`${baseUrl}/api/admin/auth/logout`, {
    method: 'POST',
    headers: { cookie: adminSession, origin: 'https://attacker.example' }
  });
  assert.equal(crossOriginLogout.status, 403);
  assert.doesNotMatch(crossOriginLogout.headers.get('set-cookie') || '', /sge_admin_session=;/);
  assert.equal((await fetch(`${baseUrl}/api/admin/auth/me`, {
    headers: { cookie: adminSession }
  })).status, 200, 'a rejected logout leaves the valid operator session intact');

  const crossOriginInvitation = await fetch(`${baseUrl}/api/admin/invitations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: adminSession,
      'sec-fetch-site': 'same-site'
    },
    body: JSON.stringify({
      host_name: 'Cross Origin Host',
      personal_note: 'This request must be rejected before mutation.'
    })
  });
  assert.equal(crossOriginInvitation.status, 403);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM host_invitations
      WHERE host_name='Cross Origin Host'`
  )).rows[0].count, 0);

  const hostInvitation = await fetch(`${baseUrl}/api/admin/invitations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: adminSession,
      origin: baseUrl,
      'sec-fetch-site': 'same-origin'
    },
    body: JSON.stringify({
      host_name: 'Dedicated Operator Host',
      personal_note: 'Invited after a direct conversation with the host.'
    })
  });
  assert.equal(hostInvitation.status, 201);
  const hostInvitationId = (await hostInvitation.json()).invitation.id;
  assert.deepEqual((await pool.query(
    `SELECT created_by_organizer_id,created_by_admin_operator_id
       FROM host_invitations WHERE id=$1`,
    [hostInvitationId]
  )).rows[0], {
    created_by_organizer_id: null,
    created_by_admin_operator_id: operator.id
  });

  const suspended = await fetch(`${baseUrl}/api/admin/accounts/${target.user_id}/suspend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminSession },
    body: JSON.stringify({ reason: 'Dedicated operator security review' })
  });
  assert.equal(suspended.status, 200);
  assert.deepEqual((await pool.query(
    `SELECT suspended_by_user_id,suspended_by_admin_operator_id
       FROM users WHERE id=$1`,
    [target.user_id]
  )).rows[0], {
    suspended_by_user_id: null,
    suspended_by_admin_operator_id: operator.id
  });

  const reactivated = await fetch(`${baseUrl}/api/admin/accounts/${target.user_id}/reactivate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminSession },
    body: JSON.stringify({ reason: 'Dedicated operator review completed' })
  });
  assert.equal(reactivated.status, 200);

  const note = await fetch(`${baseUrl}/api/admin/accounts/${target.user_id}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminSession },
    body: JSON.stringify({ note: 'Reviewed with the account owner.' })
  });
  assert.equal(note.status, 201);
  assert.deepEqual((await pool.query(
    `SELECT author_user_id,author_admin_operator_id
       FROM admin_account_support_notes WHERE target_user_id=$1`,
    [target.user_id]
  )).rows[0], {
    author_user_id: null,
    author_admin_operator_id: operator.id
  });

  const accountInvitation = await fetch(`${baseUrl}/api/admin/accounts/invitations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminSession },
    body: JSON.stringify({
      name: 'Dedicated Invitee',
      email: 'dedicated-invitee@example.test',
      prepareHostPage: true
    })
  });
  assert.equal(accountInvitation.status, 201);
  assert.deepEqual((await pool.query(
    `SELECT created_by_user_id,created_by_admin_operator_id
       FROM admin_account_invitations WHERE email='dedicated-invitee@example.test'`
  )).rows[0], {
    created_by_user_id: null,
    created_by_admin_operator_id: operator.id
  });

  const audits = (await pool.query(
    `SELECT actor_user_id,actor_admin_operator_id,action_type
       FROM admin_account_audit_log
      WHERE actor_admin_operator_id=$1
      ORDER BY id`,
    [operator.id]
  )).rows;
  assert.deepEqual(audits.map(row => row.action_type), [
    'account_suspended',
    'account_reactivated',
    'support_note_added',
    'account_invitation_created',
    'account_invitation_sent'
  ]);
  assert.ok(audits.every(row => row.actor_user_id === null));
  assert.ok(audits.every(row => row.actor_admin_operator_id === operator.id));

  const logout = await fetch(`${baseUrl}/api/admin/auth/logout`, {
    method: 'POST',
    headers: { cookie: adminSession, origin: baseUrl, 'sec-fetch-site': 'same-origin' }
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie') || '', /sge_admin_session=;/);
});

test('Accounts & Support returns complete verified and contact-only identity data to admins', async () => {
  const admin = (await pool.query(
    `INSERT INTO organizers (email,name,is_admin,last_login_at)
     VALUES ('accounts-admin@example.test','Accounts Admin',TRUE,NOW()) RETURNING id,user_id`
  )).rows[0];
  admin.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [admin.id]
  )).rows[0].user_id;
  const guest = (await pool.query(
    `INSERT INTO organizers (email,name,contact_email)
     VALUES ('rsvp-only-support@example.test','RSVP Only Support','booking-support@example.test')
     RETURNING id,user_id`
  )).rows[0];
  guest.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [guest.id]
  )).rows[0].user_id;
  await pool.query(
    `INSERT INTO user_identities
       (user_id,identity_type,value,normalized_value,verified_at,
        verification_scope,verification_source,is_primary)
     VALUES ($1,'email','rsvp-only-support@example.test','rsvp-only-support@example.test',
             NOW(),'account','integration_test',TRUE),
            ($1,'phone','+14155550129','+14155550129',NOW(),
             'account','integration_test',TRUE)`,
    [guest.user_id]
  );
  const attended = await createEvent({ slug: 'support-guest-rsvp', title: 'Support Guest RSVP' });
  await createRsvp(attended.id, {
    first_name: 'RSVP', last_name: 'Only Support',
    email: 'rsvp-contact@example.test', phone: '+14155550188',
    account_id: guest.id, user_id: guest.user_id
  });

  const adminCookie = `sge_session=${signSession(admin.id)}`;
  assert.equal((await fetch(`${baseUrl}/api/admin/accounts`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/admin/accounts`, {
    headers: { cookie: `sge_session=${signSession(organizerId)}` }
  })).status, 403);

  const page = await fetch(`${baseUrl}/admin/accounts`, { headers: { cookie: adminCookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Accounts &amp; Support/);

  const search = await fetch(
    `${baseUrl}/api/admin/accounts?q=${encodeURIComponent('rsvp-only-support@example.test')}&type=guest`,
    { headers: { cookie: adminCookie } }
  );
  assert.equal(search.status, 200);
  assert.match(search.headers.get('cache-control'), /no-store/);
  const searchPayload = await search.json();
  assert.equal(searchPayload.accounts.length, 1);
  assert.equal(searchPayload.accounts[0].id, Number(guest.user_id));
  assert.equal(searchPayload.accounts[0].kind, 'guest');
  assert.equal(searchPayload.accounts[0].rsvpCount, 1);
  assert.equal(searchPayload.accounts[0].email, 'rsvp-only-support@example.test');
  assert.equal(searchPayload.accounts[0].phone, '+14155550129');
  assert.equal(searchPayload.accounts[0].emailLabel, 'Verified sign-in email');
  assert.equal(searchPayload.accounts[0].phoneLabel, 'Verified sign-in phone');
  assert.equal(searchPayload.accounts[0].contactEmail, 'booking-support@example.test');

  const detail = await fetch(`${baseUrl}/api/admin/accounts/${guest.user_id}`, {
    headers: { cookie: adminCookie }
  });
  assert.equal(detail.status, 200);
  assert.match(detail.headers.get('cache-control'), /no-store/);
  const detailPayload = await detail.json();
  assert.equal(detailPayload.account.id, Number(guest.user_id));
  assert.equal(detailPayload.account.email, 'rsvp-only-support@example.test');
  assert.equal(detailPayload.account.phone, '+14155550129');
  assert.equal(detailPayload.account.contactEmail, 'booking-support@example.test');
  assert.equal(detailPayload.account.contactPhone, '+14155550188');
  assert.deepEqual(
    detailPayload.identities.map(identity => [identity.type, identity.value, identity.label]).sort(),
    [
      ['email', 'rsvp-only-support@example.test', 'Verified sign-in email'],
      ['phone', '+14155550129', 'Verified sign-in phone']
    ]
  );
  assert.deepEqual(
    detailPayload.contactMethods.map(method => [method.type, method.value, method.label]),
    [
      ['email', 'booking-support@example.test', 'Contact email (not verified for sign-in)'],
      ['email', 'rsvp-contact@example.test', 'RSVP email (not verified for sign-in)'],
      ['phone', '+14155550188', 'RSVP phone (not verified for sign-in)']
    ]
  );
  assert.equal(detailPayload.contactSummary.email.value, 'rsvp-only-support@example.test');
  assert.equal(detailPayload.contactSummary.email.verifiedForSignIn, true);
  assert.equal(detailPayload.contactSummary.phone.value, '+14155550129');
  assert.equal(detailPayload.deletion.allowed, false);
  assert.deepEqual(
    detailPayload.deletion.blockers.map(blocker => blocker.code),
    ['dedicated_super_admin_session']
  );
  assert.ok(Array.isArray(detailPayload.deletion.warnings));
  assert.equal(detailPayload.deletion.confirmationText, `DELETE USER ${guest.user_id}`);
  assert.equal(detailPayload.deletion.requiresFreshVerification, true);
  for (const key of ['events', 'rsvps', 'ownedEventRsvps', 'ownedEventGuestSessions',
    'ownedEventInvitations', 'ownedEventComments', 'ownedEventMessages',
    'ownedEventPhotos', 'ownedEventRecipients', 'following', 'followers', 'identities']) {
    assert.equal(typeof detailPayload.deletion.summary[key], 'number', `missing deletion summary: ${key}`);
  }

  const profileWithoutReason = await fetch(`${baseUrl}/api/admin/accounts/${guest.user_id}/profile`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ name: 'Support Renamed' })
  });
  assert.equal(profileWithoutReason.status, 400);
  const profileUpdate = await fetch(`${baseUrl}/api/admin/accounts/${guest.user_id}/profile`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ name: 'Support Renamed', reason: 'Correcting the display name at their request' })
  });
  assert.equal(profileUpdate.status, 200);
  assert.deepEqual((await pool.query(
    'SELECT u.name AS user_name,o.name AS organizer_name FROM users u JOIN organizers o ON o.user_id=u.id WHERE u.id=$1',
    [guest.user_id]
  )).rows[0], { user_name: 'Support Renamed', organizer_name: 'Support Renamed' });
  assert.deepEqual((await pool.query(
    `SELECT action_type,reason FROM admin_account_audit_log
      WHERE target_user_id=$1 ORDER BY id`, [guest.user_id]
  )).rows, [{
    action_type: 'profile_name_updated',
    reason: 'Correcting the display name at their request'
  }]);

  const selfSignOut = await fetch(`${baseUrl}/api/admin/accounts/${admin.user_id}/sign-out-all`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ reason: 'This should use Account settings instead' })
  });
  assert.equal(selfSignOut.status, 400);
  const guestOldCookie = `sge_session=${signSession(guest.id, Date.now() - 5000)}`;
  assert.equal((await fetch(`${baseUrl}/profile`, { headers: { cookie: guestOldCookie } })).status, 200);
  const signedOutEverywhere = await fetch(`${baseUrl}/api/admin/accounts/${guest.user_id}/sign-out-all`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ reason: 'Account owner reported a lost device' })
  });
  assert.equal(signedOutEverywhere.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: guestOldCookie } })).status, 401);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM admin_account_audit_log
      WHERE target_user_id=$1 AND action_type='sessions_revoked'
        AND reason='Account owner reported a lost device'`, [guest.user_id]
  )).rows[0].count, 1);

  for (const [method, suffix] of [['DELETE', ''], ['POST', '/impersonate'], ['PATCH', '/identities/1']]) {
    const response = await fetch(`${baseUrl}/api/admin/accounts/${guest.user_id}${suffix}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: method === 'DELETE' ? undefined : JSON.stringify({ value: 'attacker@example.test' })
    });
    assert.equal(response.status, 404, `${method} ${suffix || '/'} is intentionally absent`);
  }
});

test('admin suspension is audited, revokes access, preserves public property, and can be reversed safely', async () => {
  resetRateLimits();
  const admin = (await pool.query(
    `INSERT INTO organizers (email,name,is_admin,last_login_at)
     VALUES ('suspension-admin@example.test','Suspension Admin',TRUE,NOW()) RETURNING id,user_id`
  )).rows[0];
  admin.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [admin.id]
  )).rows[0].user_id;
  const target = (await pool.query(
    `INSERT INTO organizers (email,name,org_name,public_slug,last_login_at)
     VALUES ('suspended-host@example.test','Suspended Host','Suspended Host','suspended-host',NOW())
     RETURNING id,user_id`
  )).rows[0];
  target.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [target.id]
  )).rows[0].user_id;
  await pool.query(
    `INSERT INTO user_identities
       (user_id,identity_type,value,normalized_value,verified_at,
        verification_scope,verification_source,is_primary)
     VALUES ($1,'email','suspended-host@example.test','suspended-host@example.test',
             NOW(),'account','integration_test',TRUE)`,
    [target.user_id]
  );
  const publicEvent = (await pool.query(
    `INSERT INTO events
       (organizer_id,slug,title,event_date,start_time,venue_name,visibility,status)
     VALUES ($1,'suspension-public-event','Still Public','2030-12-20','20:00','Public Hall','public','published')
     RETURNING id`,
    [target.id]
  )).rows[0];
  assert.ok(publicEvent.id);

  const adminCookie = `sge_session=${signSession(admin.id)}`;
  const oldTargetCookie = `sge_session=${signSession(target.id, Date.now() - 5000)}`;
  const oldPhotoCookie = `sge_photo=${signPhotoAccess(target.id)}`;
  const photoScopeBeforeSuspension = await fetch(`${baseUrl}/api/me`, {
    headers: { cookie: oldPhotoCookie }
  });
  assert.equal(photoScopeBeforeSuspension.status, 200);
  assert.equal((await photoScopeBeforeSuspension.json()).scope, 'photo');

  const preexistingLogin = await fetch(`${baseUrl}/api/auth/magic-link`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'suspended-host@example.test', next: '/dashboard' })
  });
  assert.equal(preexistingLogin.status, 200);
  const preexistingRequestCookie = responseCookie(preexistingLogin, 'sge_sign_in');
  const preexistingCode = lastDevEmail('suspended-host@example.test', 'magic_link').code;

  const missingReason = await fetch(`${baseUrl}/api/admin/accounts/${target.user_id}/suspend`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ reason: '' })
  });
  assert.equal(missingReason.status, 400);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM admin_account_audit_log
      WHERE target_user_id=$1 AND action_type='account_suspended'`, [target.user_id]
  )).rows[0].count, 0);

  const selfSuspend = await fetch(`${baseUrl}/api/admin/accounts/${admin.user_id}/suspend`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ reason: 'Accidental self action' })
  });
  assert.equal(selfSuspend.status, 400);

  const suspended = await fetch(`${baseUrl}/api/admin/accounts/${target.user_id}/suspend`, {
    method: 'POST', headers: {
      'content-type': 'application/json', cookie: adminCookie,
      'user-agent': 'Silver Glider Integration Support'
    },
    body: JSON.stringify({ reason: 'Owner requested a temporary security hold' })
  });
  assert.equal(suspended.status, 200);
  assert.equal((await suspended.json()).status, 'suspended');

  const blockedDashboard = await fetch(`${baseUrl}/dashboard`, {
    headers: { cookie: oldTargetCookie }, redirect: 'manual'
  });
  assert.equal(blockedDashboard.status, 302);
  assert.equal(blockedDashboard.headers.get('location'), '/login');
  assert.match(blockedDashboard.headers.get('set-cookie') || '', /sge_session=;/);
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: oldTargetCookie } })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/me`, {
    headers: { cookie: oldPhotoCookie }
  })).status, 401, 'suspension immediately revokes a previously issued photo-only grant');

  const invalidatedCode = await fetch(`${baseUrl}/api/auth/verify-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: preexistingRequestCookie },
    body: JSON.stringify({ code: preexistingCode })
  });
  assert.notEqual(invalidatedCode.status, 200);
  assert.equal((await fetch(`${baseUrl}/e/suspension-public-event`)).status, 200,
    'suspension preserves the public event rather than deleting property');

  const audit = (await pool.query(
    `SELECT action_type,reason,before_state,after_state,request_ip,user_agent
       FROM admin_account_audit_log
      WHERE target_user_id=$1 ORDER BY id`,
    [target.user_id]
  )).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action_type, 'account_suspended');
  assert.equal(audit[0].reason, 'Owner requested a temporary security hold');
  assert.equal(audit[0].before_state.status, 'active');
  assert.equal(audit[0].after_state.status, 'suspended');
  assert.equal(audit[0].user_agent, 'Silver Glider Integration Support');

  const reactivated = await fetch(`${baseUrl}/api/admin/accounts/${target.user_id}/reactivate`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ reason: 'Security review completed with the owner' })
  });
  assert.equal(reactivated.status, 200);
  assert.equal((await reactivated.json()).status, 'active');

  assert.equal((await fetch(`${baseUrl}/dashboard`, {
    headers: { cookie: oldTargetCookie }, redirect: 'manual'
  })).status, 302, 'reactivation never resurrects an old session');
  const freshSignIn = await signInAccount('suspended-host@example.test', '/dashboard');
  assert.ok(freshSignIn.sessionCookie);
  assert.equal((await fetch(`${baseUrl}/dashboard`, {
    headers: { cookie: freshSignIn.sessionCookie }
  })).status, 200);

  const actions = (await pool.query(
    `SELECT action_type FROM admin_account_audit_log
      WHERE target_user_id=$1 ORDER BY id`, [target.user_id]
  )).rows.map(row => row.action_type);
  assert.deepEqual(actions, ['account_suspended', 'account_reactivated']);
});

test('permanent account deletion requires admin auth, fresh proof, and exact confirmation', async () => {
  resetRateLimits();
  const admin = (await pool.query(
    `INSERT INTO organizers (email,name,is_admin,last_login_at)
     VALUES ('delete-guard-admin@example.test','Delete Guard Admin',TRUE,NOW()) RETURNING id`
  )).rows[0];
  admin.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [admin.id]
  )).rows[0].user_id;
  const target = (await pool.query(
    `INSERT INTO organizers (email,name,last_login_at)
     VALUES ('delete-guard-target@example.test','Delete Guard Target',NOW()) RETURNING id`
  )).rows[0];
  target.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [target.id]
  )).rows[0].user_id;
  const otherAdmin = (await pool.query(
    `INSERT INTO organizers (email,name,is_admin,last_login_at)
     VALUES ('delete-other-admin@example.test','Other Delete Admin',TRUE,NOW()) RETURNING id`
  )).rows[0];
  otherAdmin.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [otherAdmin.id]
  )).rows[0].user_id;

  const operator = await createAdminOperator('delete-operator@example.test', 'super_admin');
  const adminSession = await signInAdminOperator(operator.email);
  const support = await createAdminOperator('delete-support@example.test', 'support');
  const supportSession = await signInAdminOperator(support.email);
  assert.equal((await fetch(`${baseUrl}/api/admin/accounts`, {
    headers: { cookie: supportSession }
  })).status, 200, 'support operators retain read-only support access');
  const supportSms = await fetch(`${baseUrl}/api/admin/sms/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: supportSession },
    body: JSON.stringify({ confirm: 'SEND_TEST_SMS', to: '+14155551234' })
  });
  assert.equal(supportSms.status, 403);
  assert.equal((await supportSms.json()).error, 'super_admin_required');
  const legacyAdminSession = cookieHeader(
    `sge_session=${signSession(admin.id)}`,
    `sge_identity_step_up=${signIdentityStepUp(admin.user_id)}`
  );
  const validBody = id => ({
    reason: 'Owner requested permanent account deletion',
    confirmation: `DELETE USER ${id}`
  });
  const requestDelete = (id, { cookie = adminSession, body = validBody(id), headers = {} } = {}) => fetch(
    `${baseUrl}/api/admin/accounts/${id}/delete-account`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
      body: JSON.stringify(body)
    }
  );
  assert.equal((await fetch(`${baseUrl}/api/admin/accounts/${target.user_id}`, {
    method: 'DELETE', headers: { cookie: adminSession }
  })).status, 404, 'the generic account DELETE endpoint stays absent');
  assert.equal((await requestDelete(target.user_id, { cookie: '' })).status, 401);
  assert.equal((await requestDelete(target.user_id, {
    cookie: `sge_session=${signSession(organizerId)}`
  })).status, 403);

  const legacyAttempt = await requestDelete(target.user_id, { cookie: legacyAdminSession });
  assert.equal(legacyAttempt.status, 403);
  assert.equal((await legacyAttempt.json()).error, 'dedicated_super_admin_required');
  const supportAttempt = await requestDelete(target.user_id, { cookie: supportSession });
  assert.equal(supportAttempt.status, 403);
  assert.equal((await supportAttempt.json()).error, 'dedicated_super_admin_required');

  const withoutFreshProof = await requestDelete(target.user_id);
  assert.equal(withoutFreshProof.status, 403);
  assert.equal((await withoutFreshProof.json()).error, 'admin_step_up_required');

  const wrongPhrase = await requestDelete(target.user_id, {
    body: { ...validBody(target.user_id), confirmation: `DELETE USER ${target.user_id + 1}` }
  });
  assert.equal(wrongPhrase.status, 400);
  const shortReason = await requestDelete(target.user_id, {
    body: { ...validBody(target.user_id), reason: 'testing' }
  });
  assert.equal(shortReason.status, 400);
  assert.equal((await requestDelete(target.user_id, {
    headers: { origin: 'https://attacker.example' }
  })).status, 403);

  const selfDelete = await requestDelete(admin.user_id, { body: validBody(admin.user_id) });
  assert.ok([400, 409].includes(selfDelete.status));
  const adminDelete = await requestDelete(otherAdmin.user_id, { body: validBody(otherAdmin.user_id) });
  assert.ok([400, 409].includes(adminDelete.status));

  assert.deepEqual((await pool.query(
    'SELECT account_status,name FROM users WHERE id=$1', [target.user_id]
  )).rows[0], { account_status: 'active', name: 'Delete Guard Target' });
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM admin_account_audit_log
      WHERE target_user_id=$1 AND action_type='account_deleted'`, [target.user_id]
  )).rows[0].count, 0, 'failed guard checks never create a deletion audit');
});

test('ordinary account history becomes deletion warnings instead of eligibility blockers', async () => {
  resetRateLimits();
  const admin = (await pool.query(
    `INSERT INTO organizers (email,name,is_admin,last_login_at)
     VALUES ('delete-blocker-admin@example.test','Delete Blocker Admin',TRUE,NOW()) RETURNING id`
  )).rows[0];
  admin.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [admin.id]
  )).rows[0].user_id;
  const target = (await pool.query(
    `INSERT INTO organizers
       (email,name,org_name,public_slug,plan,sms_credits,last_login_at)
     VALUES ('delete-blocked@example.test','Blocked Test Account','Blocked Test Account',
             'blocked-test-account','pro',9,NOW()) RETURNING id`
  )).rows[0];
  target.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [target.id]
  )).rows[0].user_id;
  await pool.query(
    `INSERT INTO user_identities
       (user_id,identity_type,value,normalized_value,verified_at,
        verification_scope,verification_source,is_primary,revoked_at)
     VALUES ($1,'email','old-delete-blocked@example.test','old-delete-blocked@example.test',
             NOW(),'account','integration_test',FALSE,NOW())`,
    [target.user_id]
  );
  await pool.query(
    `INSERT INTO account_phone_credentials
       (organizer_id,phone_e164,verified_at,revoked_at)
     VALUES ($1,'+14155550991',NOW(),NOW())`,
    [target.id]
  );
  await pool.query(
    `INSERT INTO follower_optouts (organizer_id,email)
     VALUES ($1,'delete-blocked@example.test')`,
    [organizerId]
  );

  const commerceEvent = (await pool.query(
    `INSERT INTO events
       (organizer_id,slug,title,event_date,start_time,venue_name,visibility,
        admission_type,status,commerce_event_id)
     VALUES ($1,'blocked-commerce-event','Blocked Commerce Event','2031-02-03','20:00',
             'Commerce Hall','public','silver_glider_tickets','published','commerce_blocked_123')
     RETURNING id`, [target.id]
  )).rows[0];
  const purchase = (await pool.query(
    `INSERT INTO sms_credit_purchases
       (reference,organizer_id,pack_key,credits,amount_cents,status,completed_at)
     VALUES ('blocked-delete-purchase',$1,'starter',100,500,'completed',NOW()) RETURNING id`,
    [target.id]
  )).rows[0];
  await pool.query(
    `INSERT INTO sms_credit_transactions
       (organizer_id,purchase_id,kind,credits_delta,balance_after,amount_cents_delta,
        currency,provider,external_key)
     VALUES ($1,$2,'purchase',100,100,500,'USD','paypal','blocked-delete-ledger')`,
    [target.id, purchase.id]
  );
  const smsBatch = (await pool.query(
    `INSERT INTO sms_notification_batches
       (event_id,organizer_id,kind,message_body,segment_count,recipient_count,
        credit_cost,status)
     VALUES ($1,$2,'event_tomorrow','Blocked SMS history',1,1,1,'sent')
     RETURNING id`,
    [commerceEvent.id, target.id]
  )).rows[0];
  const ownedDependentRsvp = await createRsvp(commerceEvent.id, {
    first_name: 'Owned', last_name: 'Dependent', email: 'owned-dependent@example.test'
  });
  const ownedDependentMessage = (await pool.query(
    `INSERT INTO message_log
       (rsvp_id,event_id,recipient,message_type,channel,status)
     VALUES ($1,$2,'owned-dependent@example.test','announcement','email','pending')
     RETURNING id`,
    [ownedDependentRsvp.id, commerceEvent.id]
  )).rows[0];
  await pool.query(
    `INSERT INTO guest_sessions
       (identity_id,token_hash,display_first_name,display_name,verified_at,
        verified_event_id,expires_at)
     VALUES ($1,'owned-dependent-session','Owned','Owned Dependent',NOW(),$2,
             NOW() + INTERVAL '1 day')`,
    [target.id, commerceEvent.id]
  );
  await pool.query(
    `INSERT INTO guest_invitation_tokens
       (message_log_id,target_event_id,identity_id,token_hash)
     VALUES ($1,$2,$3,'owned-dependent-invitation')`,
    [ownedDependentMessage.id, commerceEvent.id, target.id]
  );
  await pool.query(
    `INSERT INTO event_comments (event_id,rsvp_id,message)
     VALUES ($1,$2,'Owned event comment')`,
    [commerceEvent.id, ownedDependentRsvp.id]
  );
  await pool.query(
    `INSERT INTO event_photos
       (event_id,cloudinary_id,image_url,contributor_name)
     VALUES ($1,'unmanaged-owned-dependent-photo',
             'https://images.example.test/owned-dependent.jpg','Owned Dependent')`,
    [commerceEvent.id]
  );
  await pool.query(
    `INSERT INTO sms_notification_recipients
       (batch_id,rsvp_id,recipient,recipient_name,segment_count,status)
     VALUES ($1,$2,'+14155550888','Owned Dependent',1,'sent')`,
    [smsBatch.id, ownedDependentRsvp.id]
  );
  await pool.query(
    `INSERT INTO host_follows (follower_organizer_id,host_organizer_id,follower_user_id)
     VALUES ($1,$2,$3)`, [organizerId, target.id, organizerId]
  );
  await pool.query(
    `INSERT INTO user_identity_conflicts
       (identity_type,normalized_value,candidate_user_id,conflicting_user_id,
        verification_source,source_record_id,reason)
     VALUES ('email','delete-blocked@example.test',$1,$2,'integration_test',991,'already_claimed')`,
    [target.user_id, admin.user_id]
  );
  await pool.query(
    `INSERT INTO admin_account_support_notes (target_user_id,author_user_id,note)
     VALUES ($1,$2,'Keep this account for a real support investigation')`,
    [target.user_id, admin.user_id]
  );
  const externalEvent = await createEvent({
    slug: 'external-contributed-photo-blocker',
    title: 'External Contributed Photo Blocker'
  });
  const externalRsvp = await createRsvp(externalEvent.id, {
    first_name: 'Blocked', last_name: 'Legacy RSVP',
    email: 'delete-blocked@example.test', account_id: null, user_id: null
  });
  const externalSession = (await pool.query(
    `INSERT INTO guest_sessions
       (identity_id,user_id,token_hash,display_first_name,display_name,verified_at,
        verified_event_id,expires_at)
     VALUES ($1,NULL,'blocked-external-session','Blocked','Blocked Test Account',NOW(),$2,
             NOW() + INTERVAL '1 day') RETURNING id`,
    [target.id, externalEvent.id]
  )).rows[0];
  const externalMessage = (await pool.query(
    `INSERT INTO message_log
       (event_id,recipient,recipient_user_id,message_type,channel,status)
     VALUES ($1,'delete-blocked@example.test',NULL,'previous_guest_invite','email','pending')
     RETURNING id`,
    [externalEvent.id]
  )).rows[0];
  const externalInvitation = (await pool.query(
    `INSERT INTO guest_invitation_tokens
       (message_log_id,target_event_id,identity_id,user_id,token_hash)
     VALUES ($1,$2,$3,NULL,'blocked-external-invitation') RETURNING id`,
    [externalMessage.id, externalEvent.id, target.id]
  )).rows[0];
  await pool.query(
    `INSERT INTO event_photos
       (event_id,cloudinary_id,image_url,contributor_name,uploader_user_id)
     VALUES ($1,'blocked-external-photo','https://images.example.test/blocked.jpg',
             'Blocked Test Account',$2)`,
    [externalEvent.id, target.user_id]
  );

  const operator = await createAdminOperator('delete-history-operator@example.test', 'super_admin');
  const adminSession = await signInAdminOperator(operator.email);
  const impact = await fetch(`${baseUrl}/api/admin/accounts/${target.user_id}`, {
    headers: { cookie: adminSession }
  });
  assert.equal(impact.status, 200);
  const impactState = (await impact.json()).deletion;
  assert.equal(impactState.allowed, true);
  assert.deepEqual(impactState.blockers, []);
  assert.equal(impactState.confirmationText, `DELETE USER ${target.user_id}`);
  assert.equal(impactState.requiresFreshVerification, true);
  const warnings = impactState.warnings.map(item => item.code);
  for (const expected of [
    'owned_events',
    'owned_event_rsvps',
    'owned_event_guest_sessions',
    'owned_event_invitations',
    'owned_event_comments',
    'owned_event_messages',
    'owned_event_photos',
    'owned_event_recipients',
    'followers',
    'uploaded_photos',
    'sms_credit_balance',
    'financial_history_retained',
    'support_history_retained',
    'commerce_links'
  ]) assert.ok(warnings.includes(expected), `missing deletion warning: ${expected}`);
  assert.equal(impactState.summary.ownedEventRsvps, 1);
  assert.equal(impactState.summary.ownedEventGuestSessions, 1);
  assert.equal(impactState.summary.ownedEventInvitations, 1);
  assert.equal(impactState.summary.ownedEventComments, 1);
  assert.equal(impactState.summary.ownedEventMessages, 1);
  assert.equal(impactState.summary.ownedEventPhotos, 1);
  assert.equal(impactState.summary.ownedEventRecipients, 1);

  const deletionCookie = await adminDeletionProof(adminSession, target.user_id);
  const deleted = await fetch(`${baseUrl}/api/admin/accounts/${target.user_id}/delete-account`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: deletionCookie },
    body: JSON.stringify({
      reason: 'Owner requested deletion despite retained transaction history',
      confirmation: `DELETE USER ${target.user_id}`
    })
  });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).ok, true);

  assert.deepEqual((await pool.query(
    'SELECT account_status,name FROM users WHERE id=$1', [target.user_id]
  )).rows[0], { account_status: 'deleted', name: null });
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM events WHERE organizer_id=$1', [target.id]
  )).rows[0].count, 0);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM rsvps WHERE id=$1', [externalRsvp.id])).rows[0].count, 1,
    'an unrelated RSVP snapshot with the same email is never a destructive match');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM guest_sessions WHERE id=$1', [externalSession.id])).rows[0].count, 0);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM guest_invitation_tokens WHERE id=$1', [externalInvitation.id])).rows[0].count, 0);
  const retainedMessage = (await pool.query(
    'SELECT recipient,recipient_user_id FROM message_log WHERE id=$1', [externalMessage.id]
  )).rows[0];
  assert.equal(retainedMessage.recipient, 'delete-blocked@example.test',
    'an unrelated delivery snapshot with the same email remains untouched');
  assert.equal(retainedMessage.recipient_user_id, null);
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM follower_optouts WHERE organizer_id=$1 AND LOWER(email)=$2',
    [organizerId, 'delete-blocked@example.test']
  )).rows[0].count, 1, 'another host’s opt-out history is not matched by contact email');
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM sms_credit_purchases WHERE id=$1 AND organizer_id=$2',
    [purchase.id, target.id]
  )).rows[0].count, 1, 'financial history remains attached to the anonymized organizer shell');
  const organizerTombstone = (await pool.query(
    `SELECT email,name,org_name,public_slug,plan,sms_credits,is_admin
       FROM organizers WHERE id=$1`, [target.id]
  )).rows[0];
  assert.deepEqual(organizerTombstone, {
    email: `deleted+${target.user_id}@example.invalid`,
    name: null,
    org_name: null,
    public_slug: null,
    plan: 'free',
    sms_credits: 0,
    is_admin: false
  });
  assert.deepEqual((await pool.query(
    `SELECT kind,credits_delta,balance_after,external_key
       FROM sms_credit_transactions
      WHERE external_key=$1`,
    [`account-deletion:${target.user_id}:sms-credit-forfeiture`]
  )).rows, [{
    kind: 'adjustment',
    credits_delta: -9,
    balance_after: 0,
    external_key: `account-deletion:${target.user_id}:sms-credit-forfeiture`
  }]);
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM admin_account_support_notes WHERE target_user_id=$1',
    [target.user_id]
  )).rows[0].count, 1);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM admin_account_audit_log
      WHERE target_user_id=$1 AND action_type='account_deleted'`, [target.user_id]
  )).rows[0].count, 1);
});

test('direct account deletion purges property, revokes access, and leaves an audited tombstone', async () => {
  resetRateLimits();
  const admin = (await pool.query(
    `INSERT INTO organizers (email,name,is_admin,last_login_at)
     VALUES ('delete-success-admin@example.test','Delete Success Admin',TRUE,NOW()) RETURNING id`
  )).rows[0];
  admin.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [admin.id]
  )).rows[0].user_id;
  const targetEmail = 'disposable-test-account@example.test';
  const target = (await pool.query(
    `INSERT INTO organizers
       (email,name,org_name,public_slug,bio,plan,sms_credits,last_login_at)
     VALUES ($1,'Disposable Test Account','Disposable Test Host','disposable-test-host',
             'Temporary profile data','free',0,NOW()) RETURNING id`, [targetEmail]
  )).rows[0];
  target.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [target.id]
  )).rows[0].user_id;
  await pool.query(
    `INSERT INTO user_identities
       (user_id,identity_type,value,normalized_value,verified_at,
        verification_scope,verification_source,is_primary)
     VALUES ($1,'email',$2,$2,NOW(),'account','integration_test',TRUE),
            ($1,'phone','+14155550171','+14155550171',NOW(),
             'account','integration_test',TRUE)`,
    [target.user_id, targetEmail]
  );

  const ownedEvent = (await pool.query(
    `INSERT INTO events
       (organizer_id,slug,title,event_date,start_time,venue_name,visibility,cover_image_url,
        admission_type,status)
     VALUES ($1,'disposable-owned-event','Disposable Owned Event','2031-03-04','19:00',
             'Test Hall','public',
             'https://res.cloudinary.com/integration-cloud/image/upload/v1/sg-events-dev/event-photos/shared-public-id.jpg',
             'free_rsvp','published') RETURNING id`,
    [target.id]
  )).rows[0];
  const ownedRsvp = await createRsvp(ownedEvent.id, {
    first_name: 'Disposable', last_name: 'Account', email: targetEmail,
    account_id: target.id, user_id: target.user_id
  });
  const survivingSharedReference = await createEvent({
    slug: 'surviving-shared-media-reference', title: 'Surviving Shared Media Reference',
    cover_image_url: 'https://res.cloudinary.com/integration-cloud/image/upload/v1/sg-events-dev/event-photos/shared-public-id.jpg'
  });
  await pool.query(
    `INSERT INTO host_follows (follower_organizer_id,host_organizer_id,follower_user_id)
     VALUES ($1,$2,$3)`, [target.id, organizerId, target.user_id]
  );
  await pool.query(
    `INSERT INTO event_photos
       (event_id,cloudinary_id,image_url,contributor_name,uploader_user_id)
     VALUES ($1,'sg-events-dev/event-photos/shared-public-id',
             'https://res.cloudinary.com/integration-cloud/image/upload/v1/sg-events-dev/event-photos/shared-public-id.jpg',
             'Disposable Test Account',$2),
            ($1,'sg-events-dev/event-photos/disposable-unique-photo',
             'https://res.cloudinary.com/integration-cloud/image/upload/v1/sg-events-dev/event-photos/disposable-unique-photo.jpg',
             'Disposable Test Account',$2)`,
    [ownedEvent.id, target.user_id]
  );

  const pendingLogin = await fetch(`${baseUrl}/api/auth/magic-link`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: targetEmail, next: '/dashboard' })
  });
  assert.equal(pendingLogin.status, 200);
  const pendingToken = tokenFromLink(lastDevEmail(targetEmail, 'magic_link').link);
  await pool.query(
    `UPDATE magic_link_tokens SET target_organizer_id=$2
      WHERE id=(SELECT id FROM magic_link_tokens WHERE LOWER(email)=$1 ORDER BY id DESC LIMIT 1)`,
    [targetEmail, target.id]
  );
  const oldSession = `sge_session=${signSession(target.id, Date.now() - 5000)}`;
  const oldPhotoGrant = `sge_photo=${signPhotoAccess(target.id)}`;
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, {
    headers: { cookie: oldSession }
  })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/me`, {
    headers: { cookie: oldPhotoGrant }
  })).status, 200);

  const reason = 'Owner requested permanent removal of this completed account';
  const operator = await createAdminOperator('delete-success-operator@example.test', 'super_admin');
  const adminSession = await signInAdminOperator(operator.email);
  await pool.query(
    `INSERT INTO admin_account_identity_change_requests
       (target_user_id,identity_type,value,normalized_value,request_token_hash,
        requested_by_admin_operator_id,reason,sent_at,expires_at)
     VALUES ($1,'email','delete-pending@example.test','delete-pending@example.test',
             $2,$3,'Recipient requested an email update before deletion',NOW(),
             NOW() + INTERVAL '30 minutes')`,
    [target.user_id, 'd'.repeat(64), operator.id]
  );
  const beforeDeletion = await fetch(`${baseUrl}/api/admin/accounts/${target.user_id}`, {
    headers: { cookie: adminSession }
  });
  assert.equal(beforeDeletion.status, 200);
  const beforeDeletionState = (await beforeDeletion.json()).deletion;
  assert.equal(beforeDeletionState.allowed, true);
  assert.deepEqual(beforeDeletionState.blockers, []);
  assert.equal(beforeDeletionState.confirmationText, `DELETE USER ${target.user_id}`);

  const deletionCookie = await adminDeletionProof(adminSession, target.user_id);
  const otherTarget = (await pool.query(
    `INSERT INTO organizers (email,name,last_login_at)
     VALUES ('other-proof-target@example.test','Other Proof Target',NOW()) RETURNING id,user_id`
  )).rows[0];
  otherTarget.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [otherTarget.id]
  )).rows[0].user_id;
  const wrongTarget = await fetch(`${baseUrl}/api/admin/accounts/${otherTarget.user_id}/delete-account`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: deletionCookie },
    body: JSON.stringify({
      reason: 'This proof belongs to a different account',
      confirmation: `DELETE USER ${otherTarget.user_id}`
    })
  });
  assert.equal(wrongTarget.status, 403);
  assert.equal((await wrongTarget.json()).error, 'admin_step_up_required');

  const deleted = await fetch(`${baseUrl}/api/admin/accounts/${target.user_id}/delete-account`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', cookie: deletionCookie,
      'user-agent': 'Silver Glider Account Deletion Integration'
    },
    body: JSON.stringify({
      reason,
      confirmation: `DELETE USER ${target.user_id}`
    })
  });
  assert.equal(deleted.status, 200);
  const deletedPayload = await deleted.json();
  assert.equal(deletedPayload.ok, true);
  assert.equal(deletedPayload.deletedUserId, Number(target.user_id));
  assert.equal(deletedPayload.mediaCleanupQueued, 1);
  const proof = (await pool.query(
    `SELECT action,target_user_id,consumed_at
       FROM admin_action_proofs
      WHERE operator_id=$1 ORDER BY id DESC LIMIT 1`,
    [operator.id]
  )).rows[0];
  assert.equal(proof.action, 'account_delete');
  assert.equal(proof.target_user_id, target.user_id);
  assert.ok(proof.consumed_at, 'the proof commits as consumed with the deletion');
  const reusedProof = await fetch(`${baseUrl}/api/admin/accounts/${otherTarget.user_id}/delete-account`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: deletionCookie },
    body: JSON.stringify({
      reason: 'A consumed proof must not delete another account',
      confirmation: `DELETE USER ${otherTarget.user_id}`
    })
  });
  assert.equal(reusedProof.status, 403);
  assert.equal((await reusedProof.json()).error, 'admin_step_up_required');

  const tombstone = (await pool.query(
    `SELECT id,name,account_status,deleted_at,deleted_by_user_id,
            deleted_by_admin_operator_id,deletion_reason
       FROM users WHERE id=$1`, [target.user_id]
  )).rows[0];
  assert.equal(tombstone.id, target.user_id);
  assert.equal(tombstone.name, null);
  assert.equal(tombstone.account_status, 'deleted');
  assert.ok(tombstone.deleted_at);
  assert.equal(tombstone.deleted_by_user_id, null);
  assert.equal(tombstone.deleted_by_admin_operator_id, operator.id);
  assert.equal(tombstone.deletion_reason, reason);

  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM organizers WHERE id=$1', [target.id]
  )).rows[0].count, 1, 'an anonymized organizer shell retains financial referential integrity');
  assert.deepEqual((await pool.query(
    'SELECT email,name,org_name,public_slug FROM organizers WHERE id=$1', [target.id]
  )).rows[0], {
    email: `deleted+${target.user_id}@example.invalid`,
    name: null,
    org_name: null,
    public_slug: null
  });
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM user_identities WHERE user_id=$1', [target.user_id]
  )).rows[0].count, 0);
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM magic_link_tokens WHERE LOWER(email)=$1', [targetEmail]
  )).rows[0].count, 0);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM admin_account_identity_change_requests
      WHERE target_user_id=$1`, [target.user_id]
  )).rows[0].count, 0,
  'tombstone deletion removes proposed identity PII instead of relying on FK cascade');
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM events WHERE organizer_id=$1', [target.id]
  )).rows[0].count, 0);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM rsvps
      WHERE id=$1 OR account_id=$2 OR user_id=$3`,
    [ownedRsvp.id, target.id, target.user_id]
  )).rows[0].count, 0);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM host_follows
      WHERE follower_organizer_id=$1 OR host_organizer_id=$1 OR follower_user_id=$2`,
    [target.id, target.user_id]
  )).rows[0].count, 0);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM event_photos
      WHERE event_id=$1 OR uploader_user_id=$2`, [ownedEvent.id, target.user_id]
  )).rows[0].count, 0);
  const mediaJobs = (await pool.query(
    `SELECT public_id,status,source_kind,source_user_id
       FROM managed_media_deletion_jobs
      WHERE source_user_id=$1 ORDER BY public_id`,
    [target.user_id]
  )).rows;
  assert.deepEqual(mediaJobs, [{
    public_id: 'sg-events-dev/event-photos/disposable-unique-photo',
    status: 'pending',
    source_kind: 'account_deletion',
    source_user_id: target.user_id
  }]);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM managed_media_deletion_jobs
      WHERE source_user_id=$1 AND public_id='sg-events-dev/event-photos/shared-public-id'`,
    [target.user_id]
  )).rows[0].count, 0, 'a public ID still referenced by another account is never queued');
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM events
      WHERE id=$1 AND cover_image_url LIKE '%/shared-public-id.jpg'`,
    [survivingSharedReference.id]
  )).rows[0].count, 1, 'the other account retains its shared media reference');

  assert.equal((await fetch(`${baseUrl}/api/auth/me`, {
    headers: { cookie: oldSession }
  })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/me`, {
    headers: { cookie: oldPhotoGrant }
  })).status, 401);
  const oldLink = await fetch(`${baseUrl}/auth/verify?token=${pendingToken}`, { redirect: 'manual' });
  assert.equal(oldLink.status, 302);
  assert.match(oldLink.headers.get('location') || '', /(?:error=expired|expired=1)/);

  const hiddenFromList = await fetch(
    `${baseUrl}/api/admin/accounts?q=${encodeURIComponent(targetEmail)}`,
    { headers: { cookie: adminSession } }
  );
  assert.equal(hiddenFromList.status, 200);
  assert.deepEqual((await hiddenFromList.json()).accounts, []);
  assert.equal((await fetch(`${baseUrl}/api/admin/accounts/${target.user_id}`, {
    headers: { cookie: adminSession }
  })).status, 404);

  const actionHistory = (await pool.query(
    `SELECT action_type FROM admin_account_audit_log
      WHERE target_user_id=$1 ORDER BY id`, [target.user_id]
  )).rows.map(row => row.action_type);
  assert.deepEqual(actionHistory, ['account_deleted']);
  const audits = (await pool.query(
    `SELECT actor_user_id,actor_admin_operator_id,target_user_id,action_type,reason,
            before_state,after_state,metadata,user_agent
       FROM admin_account_audit_log
      WHERE target_user_id=$1 AND action_type='account_deleted'`,
    [target.user_id]
  )).rows;
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_user_id, null);
  assert.equal(audits[0].actor_admin_operator_id, operator.id);
  assert.equal(audits[0].reason, reason);
  assert.equal(audits[0].after_state.status, 'deleted');
  assert.equal(audits[0].user_agent, 'Silver Glider Account Deletion Integration');
  const recordedAudit = JSON.stringify(audits[0]);
  assert.ok(!recordedAudit.includes(targetEmail));
  assert.ok(!recordedAudit.includes('+14155550171'));
  assert.ok(!recordedAudit.includes(pendingToken));
  await assert.rejects(
    pool.query(
      `UPDATE admin_account_audit_log SET reason='tampered'
        WHERE target_user_id=$1 AND action_type='account_deleted'`,
      [target.user_id]
    ),
    /append-only|immutable|cannot be updated/i
  );
  assert.equal((await pool.query(
    `SELECT reason FROM admin_account_audit_log
      WHERE target_user_id=$1 AND action_type='account_deleted'`,
    [target.user_id]
  )).rows[0].reason, reason);
});

test('admin account invitations create no identity until the recipient claims the one-use link', async () => {
  const admin = (await pool.query(
    `INSERT INTO organizers (email,name,is_admin,last_login_at)
     VALUES ('invitation-admin@example.test','Invitation Admin',TRUE,NOW()) RETURNING id,user_id`
  )).rows[0];
  admin.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [admin.id]
  )).rows[0].user_id;
  const adminCookie = `sge_session=${signSession(admin.id)}`;
  const invitedEmail = 'future-host-support@example.test';

  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM user_identities
      WHERE identity_type='email' AND normalized_value=$1`, [invitedEmail]
  )).rows[0].count, 0);

  const invited = await fetch(`${baseUrl}/api/admin/accounts/invitations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', cookie: adminCookie,
      'user-agent': 'Silver Glider Invitation Test'
    },
    body: JSON.stringify({
      name: 'Future Host Support',
      email: invitedEmail,
      prepareHostPage: true
    })
  });
  assert.equal(invited.status, 201);
  const invitedBody = await invited.json();
  const invitationPayload = invitedBody.invitation;
  assert.equal(invitationPayload.email, invitedEmail);
  assert.equal(invitationPayload.status, 'sent');
  assert.ok(invitationPayload.sentAt);
  assert.equal(invitationPayload.prepareHostPage, true);
  assert.ok(!('claimUrl' in invitationPayload),
    'the admin response must never expose the recipient bearer link');
  assert.ok(!('token' in invitationPayload),
    'the admin response must never expose the recipient bearer token');
  assert.ok(!JSON.stringify(invitedBody).includes('/auth/verify?token='));

  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM user_identities
      WHERE identity_type='email' AND normalized_value=$1`, [invitedEmail]
  )).rows[0].count, 0, 'sending an invitation does not pre-verify or provision an account');
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM organizers WHERE LOWER(email)=$1`, [invitedEmail]
  )).rows[0].count, 0);

  const email = lastDevEmail(invitedEmail, 'account_claim');
  assert.match(email.link, /\/auth\/verify\?token=/);
  const claim = await followSignInLink(email.link);
  assert.equal(claim.status, 303);
  assert.equal(claim.headers.get('location'), '/dashboard');
  assert.ok(responseCookie(claim, 'sge_session'));

  const claimed = (await pool.query(
    `SELECT o.id,o.user_id,o.name,o.org_name,o.public_slug,
            identity.verified_at,identity.verification_scope,identity.is_primary,
            invitation.claimed_at,invitation.claimed_user_id
       FROM organizers o
       JOIN user_identities identity
         ON identity.user_id=o.user_id AND identity.identity_type='email'
        AND identity.normalized_value=$1 AND identity.revoked_at IS NULL
       JOIN admin_account_invitations invitation
         ON invitation.id=$2
      WHERE LOWER(o.email)=$1`,
    [invitedEmail, invitationPayload.id]
  )).rows[0];
  assert.ok(claimed);
  assert.equal(claimed.id, claimed.user_id);
  assert.equal(claimed.name, 'Future Host Support');
  assert.equal(claimed.org_name, 'Future Host Support');
  assert.match(claimed.public_slug, /^future-host-support-/);
  assert.ok(claimed.verified_at);
  assert.equal(claimed.verification_scope, 'account');
  assert.equal(claimed.is_primary, true);
  assert.ok(claimed.claimed_at);
  assert.equal(claimed.claimed_user_id, claimed.user_id);

  const token = tokenFromLink(email.link);
  const secondUse = await fetch(`${baseUrl}/auth/verify`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token })
  });
  assert.equal(secondUse.status, 400);
  assert.doesNotMatch(secondUse.headers.get('set-cookie') || '', /sge_session=/);

  const audit = (await pool.query(
    `SELECT action_type,actor_user_id,target_user_id,reason,metadata
       FROM admin_account_audit_log
      WHERE metadata->>'invitationId'=$1 OR target_user_id=$2
      ORDER BY id`,
    [String(invitationPayload.id), claimed.user_id]
  )).rows;
  assert.deepEqual(audit.map(row => row.action_type), [
    'account_invitation_created', 'account_invitation_sent', 'account_claimed'
  ]);
  assert.equal(audit[0].target_user_id, null);
  assert.equal(audit[1].target_user_id, null);
  assert.equal(audit[2].target_user_id, claimed.user_id);
  assert.deepEqual(audit.map(row => row.actor_user_id), [
    admin.user_id, admin.user_id, claimed.user_id
  ]);
  assert.equal(Number(audit[2].metadata.invitedByUserId), Number(admin.user_id));

  const duplicate = await fetch(`${baseUrl}/api/admin/accounts/invitations`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ name: 'Future Host Support', email: invitedEmail })
  });
  assert.equal(duplicate.status, 409);
  const duplicateBody = await duplicate.json();
  assert.equal(duplicateBody.error, 'account_already_exists');
});

test('an RSVP-only shell claims an invitation into the same canonical user without duplication', async () => {
  const admin = (await pool.query(
    `INSERT INTO organizers (email,name,is_admin,last_login_at)
     VALUES ('shell-invitation-admin@example.test','Shell Invitation Admin',TRUE,NOW()) RETURNING id`
  )).rows[0];
  const adminUserId = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [admin.id]
  )).rows[0].user_id;
  assert.ok(adminUserId);

  const invitedEmail = 'rsvp-shell-invite@example.test';
  const shell = (await pool.query(
    `INSERT INTO organizers (email,name)
     VALUES ($1,'RSVP Shell Guest') RETURNING id`, [invitedEmail]
  )).rows[0];
  const shellUserId = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [shell.id]
  )).rows[0].user_id;
  const attended = await createEvent({
    slug: 'rsvp-shell-before-account-claim',
    title: 'RSVP Shell Before Account Claim'
  });
  await createRsvp(attended.id, {
    first_name: 'RSVP', last_name: 'Shell Guest', email: invitedEmail,
    account_id: shell.id, user_id: shellUserId
  });

  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM user_identities
      WHERE user_id=$1 AND identity_type='email' AND verified_at IS NOT NULL
        AND revoked_at IS NULL`, [shellUserId]
  )).rows[0].count, 0);

  const adminCookie = `sge_session=${signSession(admin.id)}`;
  const shellDetailBeforeClaim = await fetch(
    `${baseUrl}/api/admin/accounts/${shellUserId}`,
    { headers: { cookie: adminCookie } }
  );
  assert.equal(shellDetailBeforeClaim.status, 200);
  const shellDetailPayload = await shellDetailBeforeClaim.json();
  assert.equal(shellDetailPayload.account.email, null,
    'a legacy RSVP email is not presented as a verified sign-in method');
  assert.equal(shellDetailPayload.account.contactEmail, invitedEmail);
  assert.equal(shellDetailPayload.contactSummary.email.label,
    'Contact email (not verified for sign-in)');
  assert.deepEqual(shellDetailPayload.identities, []);

  const invited = await fetch(`${baseUrl}/api/admin/accounts/invitations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({
      name: 'RSVP Shell Guest', email: invitedEmail, prepareHostPage: false
    })
  });
  assert.equal(invited.status, 201);
  const invitation = (await invited.json()).invitation;
  assert.equal(invitation.email, invitedEmail);
  assert.ok(!('claimUrl' in invitation));
  assert.ok(!('token' in invitation));
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM organizers WHERE LOWER(email)=$1', [invitedEmail]
  )).rows[0].count, 1, 'sending the invitation does not duplicate the RSVP-only shell');

  const email = lastDevEmail(invitedEmail, 'account_claim');
  const claim = await followSignInLink(email.link);
  assert.equal(claim.status, 303);
  assert.ok(responseCookie(claim, 'sge_session'));

  const afterClaim = (await pool.query(
    `SELECT o.id,o.user_id,o.last_login_at,identity.verified_at,
            identity.verification_scope,invitation.claimed_user_id
       FROM organizers o
       JOIN user_identities identity
         ON identity.user_id=o.user_id AND identity.identity_type='email'
        AND identity.normalized_value=$1 AND identity.revoked_at IS NULL
       JOIN admin_account_invitations invitation ON invitation.id=$2
      WHERE o.id=$3`,
    [invitedEmail, invitation.id, shell.id]
  )).rows[0];
  assert.ok(afterClaim);
  assert.equal(afterClaim.id, shell.id);
  assert.equal(afterClaim.user_id, shellUserId);
  assert.equal(afterClaim.claimed_user_id, shellUserId);
  assert.ok(afterClaim.verified_at);
  assert.ok(afterClaim.last_login_at);
  assert.equal(afterClaim.verification_scope, 'account');
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM organizers WHERE LOWER(email)=$1', [invitedEmail]
  )).rows[0].count, 1, 'claiming upgrades the shell rather than creating a second account');
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM rsvps
      WHERE event_id=$1 AND user_id=$2`, [attended.id, shellUserId]
  )).rows[0].count, 1, 'the existing RSVP remains owned by the same canonical user');
});

test('concurrent account invitations serialize by normalized email and mint one live link', async () => {
  resetRateLimits();
  const admin = (await pool.query(
    `INSERT INTO organizers (email,name,is_admin,last_login_at)
     VALUES ('concurrent-invite-admin@example.test','Concurrent Invite Admin',TRUE,NOW())
     RETURNING id`
  )).rows[0];
  const cookie = `sge_session=${signSession(admin.id)}`;
  const email = 'same-invite@example.test';
  const request = () => fetch(`${baseUrl}/api/admin/accounts/invitations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Same Recipient', email })
  });

  const responses = await Promise.all([request(), request()]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  const live = (await pool.query(
    `SELECT invitation.id,invitation.sent_at,token.used_at
       FROM admin_account_invitations invitation
       JOIN magic_link_tokens token ON token.id=invitation.magic_link_token_id
      WHERE invitation.email=$1 AND invitation.claimed_at IS NULL
        AND invitation.revoked_at IS NULL AND invitation.delivery_failed_at IS NULL
        AND invitation.expires_at>NOW()`,
    [email]
  )).rows;
  assert.equal(live.length, 1);
  assert.ok(live[0].sent_at);
  assert.equal(live[0].used_at, null);
  const audit = (await pool.query(
    `SELECT action_type FROM admin_account_audit_log
      WHERE metadata->>'invitationId'=$1 ORDER BY id`,
    [String(live[0].id)]
  )).rows.map(row => row.action_type);
  assert.deepEqual(audit, ['account_invitation_created', 'account_invitation_sent']);
});

test('failed account-invitation delivery consumes its token and permits an immediate retry', async t => {
  resetRateLimits();
  t.after(() => adminAccountsRoutes.setAccountClaimSenderForTests());
  const admin = (await pool.query(
    `INSERT INTO organizers (email,name,is_admin,last_login_at)
     VALUES ('failed-invite-admin@example.test','Failed Invite Admin',TRUE,NOW())
     RETURNING id`
  )).rows[0];
  const cookie = `sge_session=${signSession(admin.id)}`;
  const email = 'retry-invite@example.test';
  const request = () => fetch(`${baseUrl}/api/admin/accounts/invitations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Retry Recipient', email })
  });

  adminAccountsRoutes.setAccountClaimSenderForTests(async () => {
    throw new Error('Synthetic provider failure');
  });
  const failed = await request();
  assert.equal(failed.status, 500);
  const failedState = (await pool.query(
    `SELECT invitation.id,invitation.sent_at,invitation.delivery_failed_at,token.used_at
       FROM admin_account_invitations invitation
       JOIN magic_link_tokens token ON token.id=invitation.magic_link_token_id
      WHERE invitation.email=$1 ORDER BY invitation.id LIMIT 1`,
    [email]
  )).rows[0];
  assert.equal(failedState.sent_at, null);
  assert.ok(failedState.delivery_failed_at);
  assert.ok(failedState.used_at);
  assert.deepEqual((await pool.query(
    `SELECT action_type FROM admin_account_audit_log
      WHERE metadata->>'invitationId'=$1 ORDER BY id`,
    [String(failedState.id)]
  )).rows.map(row => row.action_type), [
    'account_invitation_created', 'account_invitation_delivery_failed'
  ]);

  adminAccountsRoutes.setAccountClaimSenderForTests();
  const retried = await request();
  assert.equal(retried.status, 201);
  const retriedBody = await retried.json();
  assert.equal(retriedBody.invitation.status, 'sent');
  assert.notEqual(retriedBody.invitation.id, Number(failedState.id));
  assert.ok(retriedBody.invitation.sentAt);
});

test('a stale never-sent invitation is revoked before its replacement is created', async () => {
  resetRateLimits();
  const admin = (await pool.query(
    `INSERT INTO organizers (email,name,is_admin,last_login_at)
     VALUES ('stale-invite-admin@example.test','Stale Invite Admin',TRUE,NOW())
     RETURNING id`
  )).rows[0];
  admin.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [admin.id]
  )).rows[0].user_id;
  const email = 'stale-invite@example.test';
  const token = (await pool.query(
    `INSERT INTO magic_link_tokens
       (token,email,expires_at,intent,return_path,created_at)
     VALUES ('stale-account-invite-token',$1,NOW() + INTERVAL '7 days',
             'claim_account','/dashboard',NOW() - INTERVAL '6 minutes')
     RETURNING id`,
    [email]
  )).rows[0];
  const stale = (await pool.query(
    `INSERT INTO admin_account_invitations
       (email,name,magic_link_token_id,created_by_user_id,expires_at,created_at)
     VALUES ($1,'Stale Recipient',$2,$3,NOW() + INTERVAL '7 days',
             NOW() - INTERVAL '6 minutes')
     RETURNING id`,
    [email, token.id, admin.user_id]
  )).rows[0];

  const response = await fetch(`${baseUrl}/api/admin/accounts/invitations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `sge_session=${signSession(admin.id)}`
    },
    body: JSON.stringify({ name: 'Stale Recipient', email })
  });
  assert.equal(response.status, 201);
  const replacement = (await response.json()).invitation;
  assert.notEqual(replacement.id, Number(stale.id));
  assert.equal(replacement.status, 'sent');

  const old = (await pool.query(
    `SELECT invitation.revoked_at,token.used_at
       FROM admin_account_invitations invitation
       JOIN magic_link_tokens token ON token.id=invitation.magic_link_token_id
      WHERE invitation.id=$1`,
    [stale.id]
  )).rows[0];
  assert.ok(old.revoked_at);
  assert.ok(old.used_at);
  assert.deepEqual((await pool.query(
    `SELECT action_type FROM admin_account_audit_log
      WHERE metadata->>'invitationId'=$1 ORDER BY id`,
    [String(stale.id)]
  )).rows.map(row => row.action_type), ['account_invitation_stale_revoked']);
});

test('recipient-verified admin email replacement preserves recovery aliases and never signs the recipient in', async () => {
  resetRateLimits();
  const operator = await createAdminOperator('identity-support@example.test', 'support');
  const adminCookie = await signInAdminOperator(operator.email);
  const target = (await pool.query(
    `INSERT INTO organizers (email,name,last_login_at)
     VALUES ('identity-primary-a@example.test','Identity Target',NOW())
     RETURNING id`
  )).rows[0];
  target.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [target.id]
  )).rows[0].user_id;
  const primary = await addVerifiedEmailIdentity(
    target.user_id,
    'identity-primary-a@example.test',
    { primary: true, source: 'identity_fixture_primary' }
  );
  const recovery = await addVerifiedEmailIdentity(
    target.user_id,
    'identity-recovery-b@example.test',
    { source: 'identity_fixture_recovery' }
  );
  const oldMagic = (await pool.query(
    `INSERT INTO magic_link_tokens (token,email,expires_at,intent,return_path)
     VALUES ('identity-old-primary-link','identity-primary-a@example.test',
             NOW() + INTERVAL '30 minutes','sign_in','/dashboard')
     RETURNING id`
  )).rows[0];
  const recoveryMagic = (await pool.query(
    `INSERT INTO magic_link_tokens (token,email,expires_at,intent,return_path)
     VALUES ('identity-recovery-link','identity-recovery-b@example.test',
             NOW() + INTERVAL '30 minutes','sign_in','/dashboard')
     RETURNING id`
  )).rows[0];

  const requested = await fetch(
    `${baseUrl}/api/admin/accounts/${target.user_id}/identity-changes`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        type: 'email',
        value: 'identity-new-c@example.test',
        reason: 'Account owner requested a new primary email'
      })
    }
  );
  assert.equal(requested.status, 201);
  const requestedBody = await requested.json();
  assert.equal(requestedBody.identityChangeRequest.status, 'pending');
  assert.equal(requestedBody.identityChangeRequest.value, 'identity-new-c@example.test');
  const recipientToken = tokenFromLink(
    lastDevEmail('identity-new-c@example.test', 'admin_identity_change').link
  );
  assert.ok(recipientToken);

  const unchangedBeforeProof = (await pool.query(
    `SELECT email FROM organizers WHERE user_id=$1`, [target.user_id]
  )).rows[0];
  assert.equal(unchangedBeforeProof.email, 'identity-primary-a@example.test');
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM user_identities
      WHERE user_id=$1 AND normalized_value='identity-new-c@example.test'
        AND revoked_at IS NULL`, [target.user_id]
  )).rows[0].count, 0, 'admin delivery alone never grants ownership');

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const preview = await fetch(
      `${baseUrl}/api/account/identity-change?token=${encodeURIComponent(recipientToken)}`
    );
    assert.equal(preview.status, 200);
    const previewBody = await preview.json();
    assert.deepEqual(
      { type: previewBody.request.type, status: previewBody.request.status, requiresCode: previewBody.request.requiresCode },
      { type: 'email', status: 'pending', requiresCode: false }
    );
    assert.equal(JSON.stringify(previewBody).includes(recipientToken), false,
      'preview never reflects the bearer token');
  }

  const otherCustomerCookie = cookieHeader(
    `sge_session=${signSession(organizerId)}`,
    `sge_identity_step_up=${signIdentityStepUp(organizerId)}`
  );
  const verified = await fetch(`${baseUrl}/api/account/identity-change/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: otherCustomerCookie },
    body: JSON.stringify({ token: recipientToken })
  });
  assert.equal(verified.status, 200);
  assert.deepEqual(await verified.json(), { ok: true, type: 'email' });
  const verificationCookies = verified.headers.get('set-cookie') || '';
  assert.doesNotMatch(verificationCookies, /sge_session=/);
  assert.doesNotMatch(verificationCookies, /sge_identity_step_up=/);
  const stillOtherCustomer = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { cookie: otherCustomerCookie }
  });
  assert.equal(stillOtherCustomer.status, 200);
  assert.equal(Number((await stillOtherCustomer.json()).organizer.id), Number(organizerId));

  const identities = (await pool.query(
    `SELECT id,normalized_value,is_primary,revoked_at
       FROM user_identities WHERE user_id=$1 AND identity_type='email'
      ORDER BY normalized_value`,
    [target.user_id]
  )).rows;
  const oldPrimary = identities.find(row => row.normalized_value === 'identity-primary-a@example.test');
  const preservedRecovery = identities.find(row => row.normalized_value === 'identity-recovery-b@example.test');
  const newPrimary = identities.find(row => row.normalized_value === 'identity-new-c@example.test');
  assert.equal(Number(oldPrimary.id), Number(primary.id));
  assert.ok(oldPrimary.revoked_at);
  assert.equal(oldPrimary.is_primary, false);
  assert.equal(Number(preservedRecovery.id), Number(recovery.id));
  assert.equal(preservedRecovery.revoked_at, null);
  assert.equal(preservedRecovery.is_primary, false);
  assert.equal(newPrimary.revoked_at, null);
  assert.equal(newPrimary.is_primary, true);
  assert.equal((await pool.query(
    'SELECT email FROM organizers WHERE user_id=$1', [target.user_id]
  )).rows[0].email, 'identity-new-c@example.test');
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM user_identity_verifications
      WHERE user_identity_id=$1 AND revoked_at IS NULL`, [primary.id]
  )).rows[0].count, 0);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM user_identity_verifications
      WHERE user_identity_id=$1 AND revoked_at IS NULL`, [recovery.id]
  )).rows[0].count, 1);
  assert.ok((await pool.query(
    'SELECT used_at FROM magic_link_tokens WHERE id=$1', [oldMagic.id]
  )).rows[0].used_at);
  assert.equal((await pool.query(
    'SELECT used_at FROM magic_link_tokens WHERE id=$1', [recoveryMagic.id]
  )).rows[0].used_at, null, 'recovery-address sign-in proof remains usable');

  const completionAudit = (await pool.query(
    `SELECT actor_user_id,actor_admin_operator_id,metadata
       FROM admin_account_audit_log
      WHERE target_user_id=$1 AND action_type='identity_change_recipient_verified'`,
    [target.user_id]
  )).rows[0];
  assert.equal(completionAudit.actor_user_id, null);
  assert.equal(Number(completionAudit.actor_admin_operator_id), Number(operator.id));
  assert.equal(completionAudit.metadata.performedBy, 'recipient');

  const replay = await fetch(`${baseUrl}/api/account/identity-change/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: recipientToken })
  });
  assert.equal(replay.status, 400);
});

test('identity collision rolls back the replacement and remains dismissible without transferring ownership', async () => {
  resetRateLimits();
  const operator = await createAdminOperator('identity-conflict-admin@example.test', 'super_admin');
  const adminCookie = await signInAdminOperator(operator.email);
  const target = (await pool.query(
    `INSERT INTO organizers (email,name,last_login_at)
     VALUES ('collision-old@example.test','Collision Target',NOW())
     RETURNING id`
  )).rows[0];
  target.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [target.id]
  )).rows[0].user_id;
  await addVerifiedEmailIdentity(target.user_id, 'collision-old@example.test', {
    primary: true,
    source: 'collision_fixture'
  });

  const requested = await fetch(
    `${baseUrl}/api/admin/accounts/${target.user_id}/identity-changes`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        type: 'email',
        value: 'collision-new@example.test',
        reason: 'Owner requested this replacement email address'
      })
    }
  );
  assert.equal(requested.status, 201);
  const requestId = (await requested.json()).identityChangeRequest.id;
  const token = tokenFromLink(
    lastDevEmail('collision-new@example.test', 'admin_identity_change').link
  );

  const competing = (await pool.query(
    `INSERT INTO organizers (email,name,last_login_at)
     VALUES ('collision-new@example.test','Competing Owner',NOW())
     RETURNING id`
  )).rows[0];
  competing.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [competing.id]
  )).rows[0].user_id;
  await addVerifiedEmailIdentity(competing.user_id, 'collision-new@example.test', {
    primary: true,
    source: 'collision_competing_fixture'
  });

  const verification = await fetch(`${baseUrl}/api/account/identity-change/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token })
  });
  assert.equal(verification.status, 409);
  assert.equal((await verification.json()).error, 'verification_conflict');
  assert.equal((await pool.query(
    'SELECT email FROM organizers WHERE user_id=$1', [target.user_id]
  )).rows[0].email, 'collision-old@example.test');
  const oldPrimary = (await pool.query(
    `SELECT is_primary,revoked_at FROM user_identities
      WHERE user_id=$1 AND normalized_value='collision-old@example.test'`,
    [target.user_id]
  )).rows[0];
  assert.equal(oldPrimary.is_primary, true);
  assert.equal(oldPrimary.revoked_at, null);
  assert.equal((await pool.query(
    `SELECT user_id FROM user_identities
      WHERE identity_type='email' AND normalized_value='collision-new@example.test'
        AND revoked_at IS NULL`
  )).rows[0].user_id, competing.user_id);
  assert.equal((await pool.query(
    'SELECT status FROM admin_account_identity_change_requests WHERE id=$1', [requestId]
  )).rows[0].status, 'conflict');
  const conflict = (await pool.query(
    `SELECT candidate_user_id,conflicting_user_id,reason
       FROM user_identity_conflicts
      WHERE verification_source='admin_identity_change.email_link'
        AND source_record_id=$1`, [requestId]
  )).rows[0];
  assert.deepEqual({
    candidate: Number(conflict.candidate_user_id),
    owner: Number(conflict.conflicting_user_id),
    reason: conflict.reason
  }, {
    candidate: Number(target.user_id),
    owner: Number(competing.user_id),
    reason: 'already_claimed'
  });

  const cancelled = await fetch(
    `${baseUrl}/api/admin/accounts/${target.user_id}/identity-changes/${requestId}/cancel`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ reason: 'Conflict reviewed and dismissed by support' })
    }
  );
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).identityChangeRequest.status, 'cancelled');
});

test('legacy admin account APIs remain available but never expose or mutate dedicated identity requests', async () => {
  resetRateLimits();
  const operator = await createAdminOperator('identity-dedicated@example.test', 'support');
  const dedicatedCookie = await signInAdminOperator(operator.email);
  const target = (await pool.query(
    `INSERT INTO organizers (email,name,last_login_at)
     VALUES ('legacy-gated-target@example.test','Legacy Gated Target',NOW())
     RETURNING id`
  )).rows[0];
  target.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [target.id]
  )).rows[0].user_id;
  const pending = await fetch(
    `${baseUrl}/api/admin/accounts/${target.user_id}/identity-changes`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: dedicatedCookie },
      body: JSON.stringify({
        type: 'email',
        value: 'legacy-gated-new@example.test',
        reason: 'Recipient asked support to prepare this email'
      })
    }
  );
  assert.equal(pending.status, 201);

  const legacy = (await pool.query(
    `INSERT INTO organizers (email,name,is_admin,last_login_at)
     VALUES ('legacy-identity-admin@example.test','Legacy Identity Admin',TRUE,NOW())
     RETURNING id`
  )).rows[0];
  const legacyCookie = `sge_session=${signSession(legacy.id)}`;
  const ordinaryList = await fetch(`${baseUrl}/api/admin/accounts`, {
    headers: { cookie: legacyCookie }
  });
  assert.equal(ordinaryList.status, 200,
    'identity middleware must not intercept the existing account-support API');
  const ordinaryDetail = await fetch(`${baseUrl}/api/admin/accounts/${target.user_id}`, {
    headers: { cookie: legacyCookie }
  });
  assert.equal(ordinaryDetail.status, 200);
  assert.deepEqual((await ordinaryDetail.json()).identityChangeRequests, [],
    'false manage-identities capability also hides recipient PII and reasons');

  const dedicatedList = await fetch(
    `${baseUrl}/api/admin/accounts/${target.user_id}/identity-changes`,
    { headers: { cookie: legacyCookie } }
  );
  assert.equal(dedicatedList.status, 403);
  assert.equal((await dedicatedList.json()).error, 'dedicated_admin_required');
  const dedicatedMutation = await fetch(
    `${baseUrl}/api/admin/accounts/${target.user_id}/identity-changes`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: legacyCookie },
      body: JSON.stringify({
        type: 'phone', value: '+14155550121', reason: 'Legacy sessions cannot prepare changes'
      })
    }
  );
  assert.equal(dedicatedMutation.status, 403);
  assert.equal((await dedicatedMutation.json()).error, 'dedicated_admin_required');
});

test('admin-prepared phone replacement rotates recipient proof on resend and accepts only the latest Twilio check', async t => {
  resetRateLimits();
  const operator = await createAdminOperator('phone-change-support@example.test', 'support');
  const adminCookie = await signInAdminOperator(operator.email);
  const target = (await pool.query(
    `INSERT INTO organizers (email,name,last_login_at)
     VALUES ('phone-change-target@example.test','Phone Change Target',NOW())
     RETURNING id`
  )).rows[0];
  target.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [target.id]
  )).rows[0].user_id;
  const oldPhone = '+14155550131';
  const newPhone = '+14155550132';
  const oldCredential = (await pool.query(
    `INSERT INTO account_phone_credentials (organizer_id,phone_e164,verified_at)
     VALUES ($1,$2,NOW()) RETURNING id`,
    [target.id, oldPhone]
  )).rows[0];
  const oldIdentity = (await pool.query(
    `INSERT INTO user_identities
       (user_id,identity_type,value,normalized_value,verified_at,
        verification_scope,verification_source,source_record_id,is_primary)
     VALUES ($1,'phone',$2,$2,NOW(),'account','phone_change_fixture',$3,TRUE)
     RETURNING id`,
    [target.user_id, oldPhone, oldCredential.id]
  )).rows[0];
  await pool.query(
    `INSERT INTO user_identity_verifications
       (user_identity_id,verification_scope,verified_at,verification_source,source_record_id)
     VALUES ($1,'account',NOW(),'phone_change_fixture',$2)`,
    [oldIdentity.id, oldCredential.id]
  );

  const originalStart = phoneVerification.startVerification;
  const originalCheck = phoneVerification.checkVerification;
  const originalSendSms = sms.sendSms;
  const firstSid = `VE${'1'.repeat(32)}`;
  const secondSid = `VE${'2'.repeat(32)}`;
  const startedSids = [];
  const checkedSids = [];
  const recipientMessages = [];
  let signalStaleCheck;
  let releaseStaleCheck;
  const staleCheckStarted = new Promise(resolve => { signalStaleCheck = resolve; });
  const staleCheckGate = new Promise(resolve => { releaseStaleCheck = resolve; });
  phoneVerification.startVerification = async phone => {
    assert.equal(phone, newPhone);
    const verificationSid = startedSids.length ? secondSid : firstSid;
    startedSids.push(verificationSid);
    return { verificationSid, phone, status: 'pending' };
  };
  phoneVerification.checkVerification = async ({ verificationSid, code }) => {
    checkedSids.push(verificationSid);
    if (code === '000000') {
      throw new phoneVerification.PhoneVerificationError('That verification code is invalid', {
        code: 'invalid_phone_verification_code', status: 400
      });
    }
    if (code === '111111') {
      signalStaleCheck();
      await staleCheckGate;
      throw new phoneVerification.PhoneVerificationError('That verification code is invalid', {
        code: 'invalid_phone_verification_code', status: 400
      });
    }
    if (code === '999999') {
      throw new phoneVerification.PhoneVerificationError('Phone verification is temporarily unavailable', {
        code: 'phone_verification_unavailable', status: 502
      });
    }
    assert.equal(code, '246810');
    return { approved: true, verificationSid, phone: newPhone, status: 'approved' };
  };
  sms.sendSms = async payload => {
    recipientMessages.push(payload);
    return { sid: `SM${String(recipientMessages.length).repeat(32)}`, status: 'accepted', recipient: payload.to };
  };
  t.after(() => {
    phoneVerification.startVerification = originalStart;
    phoneVerification.checkVerification = originalCheck;
    sms.sendSms = originalSendSms;
  });

  const requested = await fetch(
    `${baseUrl}/api/admin/accounts/${target.user_id}/identity-changes`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        type: 'phone', value: newPhone,
        reason: 'Account owner requested a replacement mobile number'
      })
    }
  );
  assert.equal(requested.status, 201);
  const requestId = (await requested.json()).identityChangeRequest.id;
  assert.deepEqual(startedSids, [firstSid]);
  assert.equal(recipientMessages.length, 1);
  assert.equal(recipientMessages[0].to, newPhone);
  const firstLink = recipientMessages[0].body.match(/https?:\/\/\S+/)?.[0];
  const firstToken = tokenFromLink(firstLink);
  assert.ok(firstToken, 'recipient—not the administrator—receives the high-entropy page token');
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM user_identities
      WHERE user_id=$1 AND identity_type='phone' AND normalized_value=$2
        AND revoked_at IS NULL`, [target.user_id, newPhone]
  )).rows[0].count, 0);

  const wrongCode = await fetch(`${baseUrl}/api/account/identity-change/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: firstToken, code: '000000' })
  });
  assert.equal(wrongCode.status, 400);
  assert.equal((await wrongCode.json()).error, 'verification_invalid');
  assert.equal((await pool.query(
    `SELECT verification_attempts,status FROM admin_account_identity_change_requests WHERE id=$1`,
    [requestId]
  )).rows[0].verification_attempts, 1);

  const inFlightOldCheck = fetch(`${baseUrl}/api/account/identity-change/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: firstToken, code: '111111' })
  });
  await staleCheckStarted;
  const resent = await fetch(
    `${baseUrl}/api/admin/accounts/${target.user_id}/identity-changes/${requestId}/resend`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ reason: 'Recipient requested a fresh phone verification code' })
    }
  );
  assert.equal(resent.status, 200);
  releaseStaleCheck();
  const staleCheck = await inFlightOldCheck;
  assert.equal(staleCheck.status, 400);
  assert.deepEqual(startedSids, [firstSid, secondSid]);
  assert.equal(recipientMessages.length, 2);
  const secondLink = recipientMessages[1].body.match(/https?:\/\/\S+/)?.[0];
  const secondToken = tokenFromLink(secondLink);
  assert.ok(secondToken);
  assert.notEqual(secondToken, firstToken);
  const rotated = (await pool.query(
    `SELECT provider_sid,verification_attempts,status FROM admin_account_identity_change_requests
      WHERE id=$1`, [requestId]
  )).rows[0];
  assert.equal(rotated.provider_sid, secondSid);
  assert.equal(rotated.verification_attempts, 0);
  assert.equal(rotated.status, 'pending');

  const checksBeforeOldToken = checkedSids.length;
  const oldToken = await fetch(`${baseUrl}/api/account/identity-change/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: firstToken, code: '246810' })
  });
  assert.equal(oldToken.status, 400);
  assert.equal(checkedSids.length, checksBeforeOldToken,
    'a rotated token is rejected before contacting Twilio');

  const providerOutage = await fetch(`${baseUrl}/api/account/identity-change/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: secondToken, code: '999999' })
  });
  assert.equal(providerOutage.status, 502);
  assert.equal((await providerOutage.json()).error, 'phone_verification_unavailable');
  assert.equal((await pool.query(
    'SELECT verification_attempts FROM admin_account_identity_change_requests WHERE id=$1',
    [requestId]
  )).rows[0].verification_attempts, 0,
  'provider outages must not consume the recipient\'s proof attempts');

  const verified = await fetch(`${baseUrl}/api/account/identity-change/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: secondToken, code: '246810' })
  });
  assert.equal(verified.status, 200);
  assert.deepEqual(await verified.json(), { ok: true, type: 'phone' });
  assert.deepEqual(checkedSids, [firstSid, firstSid, secondSid, secondSid]);
  assert.doesNotMatch(verified.headers.get('set-cookie') || '', /sge_(?:session|identity_step_up)=/);

  const phoneIdentities = (await pool.query(
    `SELECT normalized_value,is_primary,revoked_at FROM user_identities
      WHERE user_id=$1 AND identity_type='phone' ORDER BY id`, [target.user_id]
  )).rows;
  assert.equal(phoneIdentities.length, 2);
  assert.equal(phoneIdentities[0].normalized_value, oldPhone);
  assert.ok(phoneIdentities[0].revoked_at);
  assert.equal(phoneIdentities[1].normalized_value, newPhone);
  assert.equal(phoneIdentities[1].revoked_at, null);
  assert.equal(phoneIdentities[1].is_primary, true);
  const credentials = (await pool.query(
    `SELECT phone_e164,revoked_at FROM account_phone_credentials
      WHERE organizer_id=$1 ORDER BY id`, [target.id]
  )).rows;
  assert.equal(credentials[0].phone_e164, oldPhone);
  assert.ok(credentials[0].revoked_at);
  assert.equal(credentials[1].phone_e164, newPhone);
  assert.equal(credentials[1].revoked_at, null);
  assert.equal((await pool.query(
    'SELECT status FROM admin_account_identity_change_requests WHERE id=$1', [requestId]
  )).rows[0].status, 'verified');
});

test('sign-out-all serializes behind recipient delivery and cancels the proof before it can be used', async t => {
  resetRateLimits();
  const operator = await createAdminOperator('identity-race-support@example.test', 'support');
  const adminCookie = await signInAdminOperator(operator.email);
  const target = (await pool.query(
    `INSERT INTO organizers (email,name,last_login_at)
     VALUES ('identity-race-old@example.test','Identity Race Target',NOW())
     RETURNING id`
  )).rows[0];
  target.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [target.id]
  )).rows[0].user_id;
  const created = await fetch(
    `${baseUrl}/api/admin/accounts/${target.user_id}/identity-changes`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        type: 'email', value: 'identity-race-new@example.test',
        reason: 'Owner asked support to prepare a new email'
      })
    }
  );
  assert.equal(created.status, 201);
  const requestId = (await created.json()).identityChangeRequest.id;

  const originalSender = mailer.sendAdminIdentityChangeVerification;
  let releaseDelivery;
  let deliveryStarted;
  const deliveryGate = new Promise(resolve => { releaseDelivery = resolve; });
  const startedGate = new Promise(resolve => { deliveryStarted = resolve; });
  let resendLink = null;
  mailer.sendAdminIdentityChangeVerification = async payload => {
    resendLink = payload.link;
    deliveryStarted();
    await deliveryGate;
    return { id: 'race-delivery' };
  };
  t.after(() => { mailer.sendAdminIdentityChangeVerification = originalSender; });

  const resendPromise = fetch(
    `${baseUrl}/api/admin/accounts/${target.user_id}/identity-changes/${requestId}/resend`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ reason: 'Recipient requested another verification email' })
    }
  );
  await startedGate;
  let signOutSettled = false;
  const signOutPromise = fetch(`${baseUrl}/api/admin/accounts/${target.user_id}/sign-out-all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ reason: 'Owner reported that all existing access should be revoked' })
  }).then(response => {
    signOutSettled = true;
    return response;
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(signOutSettled, false,
    'access invalidation waits for the serialized outbound delivery section');
  releaseDelivery();

  const [resent, signedOut] = await Promise.all([resendPromise, signOutPromise]);
  assert.equal(resent.status, 200);
  assert.equal(signedOut.status, 200);
  assert.equal((await pool.query(
    'SELECT status FROM admin_account_identity_change_requests WHERE id=$1', [requestId]
  )).rows[0].status, 'cancelled');
  const token = tokenFromLink(resendLink);
  const blocked = await fetch(`${baseUrl}/api/account/identity-change/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token })
  });
  assert.equal(blocked.status, 400);
  assert.equal((await pool.query(
    `SELECT (after_state->>'identityChangesCancelled')::int AS cancelled
       FROM admin_account_audit_log
      WHERE target_user_id=$1 AND action_type='sessions_revoked'`,
    [target.user_id]
  )).rows[0].cancelled, 1);
});

test('Done For You provisioning is dedicated-admin only, aligned, unverified, idempotent, and session-free', async () => {
  resetRateLimits();
  const support = await createAdminOperator('dfy-support@example.test', 'support');
  const supportCookie = await signInAdminOperator(support.email);
  const me = await fetch(`${baseUrl}/api/admin/auth/me`, { headers: { cookie: supportCookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).capabilities.manageDoneForYou, true);

  const contact = {
    hostName: 'Moonlight Social',
    contactName: 'Maya Client',
    email: 'maya.dfy@example.test',
    phone: '+14155550191'
  };
  assert.equal((await doneForYouLookup('', contact)).status, 401);
  await pool.query('UPDATE organizers SET is_admin=TRUE WHERE id=$1', [organizerId]);
  const legacy = await doneForYouLookup(`sge_session=${signSession(organizerId)}`, contact);
  assert.equal(legacy.status, 403);
  assert.equal((await legacy.json()).error, 'dedicated_admin_required');

  const invalid = await doneForYouLookup(supportCookie, { email: 'not-an-email', phone: 'nope' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'invalid_done_for_you_contact');
  const previewResponse = await doneForYouLookup(supportCookie, contact);
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.expectedUserId, null);
  assert.equal(preview.matched, false);

  const skippedPreview = await fetch(`${baseUrl}/api/admin/done-for-you`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: supportCookie },
    body: JSON.stringify(contact)
  });
  assert.equal(skippedPreview.status, 409);
  assert.equal((await skippedPreview.json()).error, 'done_for_you_lookup_required');

  const created = await provisionDoneForYou(supportCookie, { ...contact, expectedUserId: null });
  assert.equal(created.status, 201);
  assert.doesNotMatch(created.headers.get('set-cookie') || '', /sge_session=/);
  const first = (await created.json()).client;
  assert.equal(first.userId, first.organizerId);
  assert.equal(first.userCreated, true);
  assert.equal(first.claimed, false);
  const stored = (await pool.query(
    `SELECT canonical_user.name,canonical_user.account_status,
            organizer.id,organizer.user_id,organizer.org_name,organizer.public_slug,
            organizer.last_login_at
       FROM users canonical_user
       JOIN organizers organizer ON organizer.user_id=canonical_user.id
      WHERE canonical_user.id=$1`,
    [first.userId]
  )).rows[0];
  assert.equal(stored.id, first.userId);
  assert.equal(stored.user_id, first.userId);
  assert.equal(stored.name, contact.contactName);
  assert.equal(stored.org_name, contact.hostName);
  assert.equal(stored.account_status, 'active');
  assert.equal(stored.last_login_at, null);
  const identities = (await pool.query(
    `SELECT identity_type,normalized_value,verification_scope,verified_at,is_primary
       FROM user_identities WHERE user_id=$1 ORDER BY identity_type`,
    [first.userId]
  )).rows;
  assert.deepEqual(identities.map(row => ({
    type: row.identity_type,
    value: row.normalized_value,
    scope: row.verification_scope,
    verified: Boolean(row.verified_at),
    primary: row.is_primary
  })), [
    { type: 'email', value: contact.email, scope: 'unverified', verified: false, primary: false },
    { type: 'phone', value: contact.phone, scope: 'unverified', verified: false, primary: false }
  ]);
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM account_phone_credentials WHERE organizer_id=$1',
    [first.userId]
  )).rows[0].count, 0);

  const repeatPreview = await doneForYouLookup(supportCookie, contact);
  const repeatPreviewBody = await repeatPreview.json();
  assert.equal(repeatPreviewBody.expectedUserId, first.userId);
  const repeated = await provisionDoneForYou(supportCookie, {
    ...contact,
    expectedUserId: first.userId
  });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).client.noOp, true);
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM admin_done_for_you_clients WHERE target_user_id=$1',
    [first.userId]
  )).rows[0].count, 1);
  const audit = (await pool.query(
    `SELECT before_state,after_state,metadata FROM admin_account_audit_log
      WHERE target_user_id=$1 AND action_type LIKE 'done_for_you_client_%'`,
    [first.userId]
  )).rows;
  assert.equal(audit.length, 1);
  assert.doesNotMatch(JSON.stringify(audit), /Maya Client|Moonlight Social|maya\.dfy|50191/);

  const list = await fetch(`${baseUrl}/api/admin/done-for-you`, { headers: { cookie: supportCookie } });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).clients[0].userId, first.userId);
  const detail = await fetch(`${baseUrl}/api/admin/done-for-you/${first.id}`, {
    headers: { cookie: supportCookie }
  });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).owner.userId, first.userId);
});

test('Done For You concurrent provisioning creates one owner and forces a fresh preview for the loser', async () => {
  resetRateLimits();
  const operator = await createAdminOperator('dfy-race@example.test', 'support');
  const session = await signInAdminOperator(operator.email);
  const contact = {
    hostName: 'Race Safe Host',
    contactName: 'Race Safe Client',
    email: 'dfy-race-client@example.test',
    phone: '+14155550192',
    expectedUserId: null
  };
  const responses = await Promise.all([
    provisionDoneForYou(session, contact),
    provisionDoneForYou(session, contact)
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  const conflictBody = await responses.find(response => response.status === 409).json();
  assert.equal(conflictBody.error, 'done_for_you_lookup_changed');
  assert.equal(typeof conflictBody.actualUserId, 'number');
  const ownerId = conflictBody.actualUserId;
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM user_identities
      WHERE identity_type='email' AND normalized_value=$1 AND revoked_at IS NULL`,
    [contact.email]
  )).rows[0].count, 1);
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM organizers WHERE user_id=$1', [ownerId]
  )).rows[0].count, 1);
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM admin_done_for_you_clients WHERE target_user_id=$1', [ownerId]
  )).rows[0].count, 1);
});

test('Done For You exact ownership handles unverified contacts, split owners, and legacy projection drift safely', async () => {
  resetRateLimits();
  const operator = await createAdminOperator('dfy-identity@example.test', 'support');
  const session = await signInAdminOperator(operator.email);
  async function createCompat(email, name) {
    const inserted = (await pool.query(
      'INSERT INTO organizers (email,name) VALUES ($1,$2) RETURNING id',
      [email, name]
    )).rows[0];
    return (await pool.query('SELECT id,user_id FROM organizers WHERE id=$1', [inserted.id])).rows[0];
  }
  async function addUnverified(userId, type, value) {
    await pool.query(
      `INSERT INTO user_identities
         (user_id,identity_type,value,normalized_value,verification_scope,
          verification_source,is_primary)
       VALUES ($1,$2,$3,$3,'unverified','integration_test',FALSE)`,
      [userId, type, value]
    );
  }

  const ownerA = await createCompat('owner-a-compat@example.test', 'Owner A');
  await addUnverified(ownerA.user_id, 'email', 'owner-a@example.test');
  await addUnverified(ownerA.user_id, 'phone', '+14155550201');
  const sameOwner = await doneForYouLookup(session, {
    email: 'owner-a@example.test', phone: '+14155550201'
  });
  assert.equal(sameOwner.status, 200);
  assert.equal((await sameOwner.json()).expectedUserId, ownerA.user_id);

  const phoneAlone = await doneForYouLookup(session, {
    email: 'new-email@example.test', phone: '+14155550201'
  });
  assert.equal(phoneAlone.status, 409);
  assert.deepEqual((await phoneAlone.json()).ownerUserIds, [ownerA.user_id]);

  const ownerB = await createCompat('owner-b-compat@example.test', 'Owner B');
  await pool.query(
    `INSERT INTO user_identities
       (user_id,identity_type,value,normalized_value,verified_at,
        verification_scope,verification_source,is_primary)
     VALUES ($1,'phone',$2,$2,NOW(),'account','integration_test',TRUE)`,
    [ownerB.user_id, '+14155550202']
  );
  const split = await doneForYouLookup(session, {
    email: 'owner-a@example.test', phone: '+14155550202'
  });
  assert.equal(split.status, 409);
  const splitBody = await split.json();
  assert.equal(splitBody.error, 'split_identity_owners');
  assert.equal(splitBody.emailOwnerUserId, ownerA.user_id);
  assert.equal(splitBody.phoneOwnerUserId, ownerB.user_id);
  assert.doesNotMatch(JSON.stringify(splitBody), /owner-a@example|55550202/);

  const legacyConflict = await createCompat('owner-a@example.test', 'Legacy Conflict');
  const disagreement = await doneForYouLookup(session, { email: 'owner-a@example.test' });
  assert.equal(disagreement.status, 409);
  const disagreementBody = await disagreement.json();
  assert.equal(disagreementBody.error, 'identity_projection_conflict');
  assert.deepEqual(new Set(disagreementBody.ownerUserIds), new Set([ownerA.user_id, legacyConflict.user_id]));

  const legacyEmail = await createCompat('legacy-only@example.test', 'Legacy Email');
  const userCountBeforeEmail = Number((await pool.query('SELECT COUNT(*)::int AS count FROM users')).rows[0].count);
  const legacyEmailPreview = await doneForYouLookup(session, { email: 'legacy-only@example.test' });
  assert.equal(legacyEmailPreview.status, 200);
  const legacyEmailBody = await legacyEmailPreview.json();
  assert.equal(legacyEmailBody.expectedUserId, legacyEmail.user_id);
  assert.ok(legacyEmailBody.matchedBy.includes('legacy_email'));
  const legacyEmailProvision = await provisionDoneForYou(session, {
    hostName: 'Legacy Email Host', contactName: 'Legacy Email',
    email: 'legacy-only@example.test', expectedUserId: legacyEmail.user_id
  });
  assert.equal(legacyEmailProvision.status, 201);
  assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS count FROM users')).rows[0].count), userCountBeforeEmail);
  assert.equal((await pool.query(
    `SELECT verification_scope FROM user_identities
      WHERE user_id=$1 AND identity_type='email' AND normalized_value=$2`,
    [legacyEmail.user_id, 'legacy-only@example.test']
  )).rows[0].verification_scope, 'unverified');

  const legacyPhone = await createCompat('legacy-phone@example.test', 'Legacy Phone');
  await pool.query(
    `INSERT INTO account_phone_credentials (organizer_id,phone_e164,verified_at)
     VALUES ($1,$2,NOW())`,
    [legacyPhone.id, '+14155550203']
  );
  const userCountBeforePhone = Number((await pool.query('SELECT COUNT(*)::int AS count FROM users')).rows[0].count);
  const legacyPhonePreview = await doneForYouLookup(session, {
    email: 'legacy-phone-new@example.test', phone: '+14155550203'
  });
  assert.equal(legacyPhonePreview.status, 200);
  const legacyPhoneBody = await legacyPhonePreview.json();
  assert.equal(legacyPhoneBody.expectedUserId, legacyPhone.user_id);
  assert.ok(legacyPhoneBody.matchedBy.includes('legacy_verified_phone'));
  const legacyPhoneProvision = await provisionDoneForYou(session, {
    hostName: 'Legacy Phone Host', contactName: 'Legacy Phone',
    email: 'legacy-phone-new@example.test', phone: '+14155550203',
    expectedUserId: legacyPhone.user_id
  });
  assert.equal(legacyPhoneProvision.status, 201);
  assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS count FROM users')).rows[0].count), userCountBeforePhone);
  assert.equal((await pool.query(
    `SELECT verification_scope FROM user_identities
      WHERE user_id=$1 AND identity_type='phone' AND normalized_value=$2`,
    [legacyPhone.user_id, '+14155550203']
  )).rows[0].verification_scope, 'account');
});

test('target-bound Done For You claims are scanner-safe, revoke old links, and claim the exact prepared user', async t => {
  resetRateLimits();
  const operator = await createAdminOperator('dfy-claim@example.test', 'support');
  const session = await signInAdminOperator(operator.email);
  const prepared = await createDoneForYouClient(session, {
    hostName: 'Claimed Host', contactName: 'Casey Claim',
    email: 'casey-claim@example.test', phone: '+14155550211'
  });
  const links = [];
  adminDoneForYouRoutes.setClaimSenderForTests(async message => { links.push(message.link); });
  t.after(() => adminDoneForYouRoutes.setClaimSenderForTests());

  const sendClaim = () => fetch(`${baseUrl}/api/admin/done-for-you/${prepared.client.id}/claim-invitation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: session },
    body: '{}'
  });
  const first = await sendClaim();
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.doesNotMatch(JSON.stringify(firstBody), /token|auth\/verify/i);
  const firstToken = tokenFromLink(links[0]);
  const second = await sendClaim();
  assert.equal(second.status, 201);
  const secondBody = await second.json();
  assert.doesNotMatch(JSON.stringify(secondBody), /token|auth\/verify/i);
  const secondToken = tokenFromLink(links[1]);
  assert.notEqual(firstToken, secondToken);

  const oldPost = await fetch(`${baseUrl}/auth/verify`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: firstToken })
  });
  assert.equal(oldPost.status, 400);
  const scanOne = await fetch(`${baseUrl}/auth/verify?token=${secondToken}`, { redirect: 'manual' });
  const scanTwo = await fetch(`${baseUrl}/auth/verify?token=${secondToken}`, { redirect: 'manual' });
  assert.equal(scanOne.status, 200);
  assert.equal(scanTwo.status, 200);
  assert.equal(scanOne.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await pool.query(
    'SELECT used_at FROM magic_link_tokens WHERE token=$1',
    [require('../../src/lib/guest-session').tokenHash(secondToken)]
  )).rows[0].used_at, null);

  const claimed = await fetch(`${baseUrl}/auth/verify`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: secondToken })
  });
  assert.equal(claimed.status, 303);
  const customerCookie = responseCookie(claimed, 'sge_session');
  assert.ok(customerCookie);
  const customerMe = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: customerCookie } });
  assert.equal(customerMe.status, 200);
  assert.equal((await customerMe.json()).organizer.id, prepared.client.userId);
  const ownerRows = await pool.query(
    `SELECT invitation.target_user_id,invitation.claimed_user_id,invitation.claimed_at,
            identity.identity_type,identity.verification_scope,identity.verified_at,
            identity.is_primary
       FROM admin_account_invitations invitation
       JOIN user_identities identity ON identity.user_id=invitation.target_user_id
      WHERE invitation.id=$1 ORDER BY identity.identity_type`,
    [secondBody.invitation.id]
  );
  assert.equal(ownerRows.rows[0].target_user_id, prepared.client.userId);
  assert.equal(ownerRows.rows[0].claimed_user_id, prepared.client.userId);
  assert.ok(ownerRows.rows[0].claimed_at);
  const claimedEmail = ownerRows.rows.find(row => row.identity_type === 'email');
  const untouchedPhone = ownerRows.rows.find(row => row.identity_type === 'phone');
  assert.equal(claimedEmail.verification_scope, 'account');
  assert.ok(claimedEmail.verified_at);
  assert.equal(claimedEmail.is_primary, true);
  assert.equal(untouchedPhone.verification_scope, 'unverified');
  assert.equal(untouchedPhone.verified_at, null);
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM users WHERE id=$1', [prepared.client.userId]
  )).rows[0].count, 1);
  const replay = await fetch(`${baseUrl}/auth/verify`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: secondToken })
  });
  assert.equal(replay.status, 400);

  await assert.rejects(
    pool.query(
      `UPDATE admin_account_invitations
          SET target_user_id=$2,claimed_user_id=$2
        WHERE id=$1`,
      [secondBody.invitation.id, organizerId]
    ),
    /target is immutable/
  );
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM message_log
      WHERE recipient_user_id=$1 AND message_type='magic_link' AND status='sent'`,
    [prepared.client.userId]
  )).rows[0].count, 2);
  const claimAudit = (await pool.query(
    `SELECT before_state,after_state,metadata
       FROM admin_account_audit_log
      WHERE target_user_id=$1
        AND action_type LIKE 'done_for_you_claim_invitation_%'`,
    [prepared.client.userId]
  )).rows;
  assert.ok(claimAudit.length >= 2);
  assert.doesNotMatch(JSON.stringify(claimAudit), /casey-claim@example\.test/);
});

test('a target-bound claim becomes terminal if the owner claims through another identity first', async t => {
  resetRateLimits();
  const operator = await createAdminOperator('dfy-stale-claim@example.test', 'support');
  const session = await signInAdminOperator(operator.email);
  const prepared = await createDoneForYouClient(session, {
    hostName: 'Stale Claim Host', contactName: 'Riley Owner',
    email: 'stale-claim@example.test'
  });
  let link = '';
  adminDoneForYouRoutes.setClaimSenderForTests(async message => { link = message.link; });
  t.after(() => adminDoneForYouRoutes.setClaimSenderForTests());
  const sent = await fetch(`${baseUrl}/api/admin/done-for-you/${prepared.client.id}/claim-invitation`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: session }, body: '{}'
  });
  assert.equal(sent.status, 201);
  const invitationId = (await sent.json()).invitation.id;
  await addVerifiedEmailIdentity(prepared.client.userId, 'other-owner-proof@example.test');
  const token = tokenFromLink(link);
  const stale = await fetch(`${baseUrl}/auth/verify`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token })
  });
  assert.equal(stale.status, 409);
  const invitation = (await pool.query(
    'SELECT claimed_at,revoked_at FROM admin_account_invitations WHERE id=$1', [invitationId]
  )).rows[0];
  assert.equal(invitation.claimed_at, null);
  assert.ok(invitation.revoked_at);
  assert.ok((await pool.query(
    'SELECT used_at FROM magic_link_tokens WHERE token=$1',
    [require('../../src/lib/guest-session').tokenHash(token)]
  )).rows[0].used_at);
  const replay = await fetch(`${baseUrl}/auth/verify`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token })
  });
  assert.equal(replay.status, 400);
  assert.equal((await pool.query(
    `SELECT verification_scope FROM user_identities
      WHERE user_id=$1 AND normalized_value='stale-claim@example.test'`,
    [prepared.client.userId]
  )).rows[0].verification_scope, 'unverified');
});

test('Done For You claim links are revoked by sign-out-all, suspension, reactivation, and deletion cleanup', async t => {
  resetRateLimits();
  const operator = await createAdminOperator('dfy-cleanup@example.test', 'super_admin');
  const session = await signInAdminOperator(operator.email);
  const delivered = [];
  adminDoneForYouRoutes.setClaimSenderForTests(async message => { delivered.push(message.link); });
  t.after(() => adminDoneForYouRoutes.setClaimSenderForTests());
  async function preparedClaim(email, suffix) {
    const prepared = await createDoneForYouClient(session, {
      hostName: `Cleanup Host ${suffix}`,
      contactName: `Cleanup Client ${suffix}`,
      email
    });
    const response = await fetch(
      `${baseUrl}/api/admin/done-for-you/${prepared.client.id}/claim-invitation`,
      { method: 'POST', headers: { 'content-type': 'application/json', cookie: session }, body: '{}' }
    );
    assert.equal(response.status, 201);
    return { ...prepared, invitation: (await response.json()).invitation, link: delivered.at(-1) };
  }
  async function postClaim(link) {
    return fetch(`${baseUrl}/auth/verify`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokenFromLink(link) })
    });
  }

  const signout = await preparedClaim('dfy-signout@example.test', 'Signout');
  const signedOut = await fetch(`${baseUrl}/api/admin/accounts/${signout.client.userId}/sign-out-all`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: session },
    body: JSON.stringify({ reason: 'Owner requested every pending access path be revoked' })
  });
  assert.equal(signedOut.status, 200);
  assert.equal((await postClaim(signout.link)).status, 400);
  assert.ok((await pool.query(
    'SELECT revoked_at FROM admin_account_invitations WHERE id=$1', [signout.invitation.id]
  )).rows[0].revoked_at);

  const suspended = await preparedClaim('dfy-suspend@example.test', 'Suspend');
  const suspend = await fetch(`${baseUrl}/api/admin/accounts/${suspended.client.userId}/suspend`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: session },
    body: JSON.stringify({ reason: 'Support is temporarily securing this client account' })
  });
  assert.equal(suspend.status, 200);
  assert.equal((await postClaim(suspended.link)).status, 400);
  const reactivate = await fetch(`${baseUrl}/api/admin/accounts/${suspended.client.userId}/reactivate`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: session },
    body: JSON.stringify({ reason: 'Support completed the client security review' })
  });
  assert.equal(reactivate.status, 200);
  assert.equal((await postClaim(suspended.link)).status, 400,
    'reactivation never resurrects a revoked claim link');

  const deleted = await preparedClaim('dfy-delete@example.test', 'Delete');
  const deletionCookie = await adminDeletionProof(session, deleted.client.userId);
  const removed = await fetch(`${baseUrl}/api/admin/accounts/${deleted.client.userId}/delete-account`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: deletionCookie },
    body: JSON.stringify({
      reason: 'Client requested permanent deletion of the prepared account',
      confirmation: `DELETE USER ${deleted.client.userId}`
    })
  });
  assert.equal(removed.status, 200);
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM admin_done_for_you_clients WHERE target_user_id=$1',
    [deleted.client.userId]
  )).rows[0].count, 0);
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM admin_account_invitations WHERE target_user_id=$1',
    [deleted.client.userId]
  )).rows[0].count, 0);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM magic_link_tokens
      WHERE token=$1`,
    [require('../../src/lib/guest-session').tokenHash(tokenFromLink(deleted.link))]
  )).rows[0].count, 0);
  const deliveryLog = (await pool.query(
    `SELECT recipient,recipient_user_id FROM message_log
      WHERE message_type='magic_link' AND recipient LIKE $1 ORDER BY id DESC LIMIT 1`,
    [`deleted+${deleted.client.userId}+message-%`]
  )).rows[0];
  assert.ok(deliveryLog);
  assert.equal(deliveryLog.recipient_user_id, null);
  const deletedClaim = await postClaim(deleted.link);
  assert.equal(deletedClaim.status, 303);
  assert.match(deletedClaim.headers.get('location') || '', /^\/login\?error=expired/);

  let uploadCalls = 0;
  uploadRoutes.setAdminHostUploadsForTests({
    configured: true,
    logo: async () => { uploadCalls += 1; return { secure_url: 'https://example.test/should-not-upload.png' }; }
  });
  t.after(() => uploadRoutes.setAdminHostUploadsForTests());
  const deletedLogo = new FormData();
  deletedLogo.set('image', new Blob([Buffer.from('not-reached')], { type: 'image/png' }), 'logo.png');
  const blockedUpload = await fetch(
    `${baseUrl}/api/admin/uploads/hosts/${deleted.client.organizerId}/logo`,
    { method: 'POST', headers: { cookie: session }, body: deletedLogo }
  );
  assert.equal(blockedUpload.status, 404);
  assert.equal(uploadCalls, 0);
  const blockedProfile = await fetch(
    `${baseUrl}/api/admin/hosts/${deleted.client.organizerId}/profile`,
    {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: session },
      body: JSON.stringify({ orgName: 'Must Not Return' })
    }
  );
  assert.equal(blockedProfile.status, 404);
});

test('Done For You preserves established profile values, fills blanks, and rejects a stale preview after signup', async () => {
  resetRateLimits();
  const operator = await createAdminOperator('dfy-fill-support@example.test', 'support');
  const session = await signInAdminOperator(operator.email);

  const established = (await pool.query(
    `INSERT INTO organizers (email,name,org_name,public_slug)
     VALUES ('dfy-established@example.test','Established Person','Established Host','established-host')
     RETURNING id,user_id`
  )).rows[0];
  established.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [established.id]
  )).rows[0].user_id;
  const establishedPreview = await doneForYouLookup(session, {
    email: 'dfy-established@example.test'
  });
  assert.equal(establishedPreview.status, 200);
  const establishedProvision = await provisionDoneForYou(session, {
    hostName: 'Submitted Replacement Host',
    contactName: 'Submitted Replacement Person',
    email: 'dfy-established@example.test',
    expectedUserId: established.user_id
  });
  assert.equal(establishedProvision.status, 201);
  const preserved = (await pool.query(
    `SELECT canonical_user.name,organizer.name AS organizer_name,
            organizer.org_name,organizer.public_slug
       FROM users canonical_user
       JOIN organizers organizer ON organizer.user_id=canonical_user.id
      WHERE canonical_user.id=$1`,
    [established.user_id]
  )).rows[0];
  assert.equal(preserved.name, 'Established Person');
  assert.equal(preserved.organizer_name, 'Established Person');
  assert.equal(preserved.org_name, 'Established Host');
  assert.equal(preserved.public_slug, 'established-host');

  const blank = (await pool.query(
    `INSERT INTO organizers (email,name)
     VALUES ('dfy-fill-blank@example.test','Temporary Name')
     RETURNING id,user_id`
  )).rows[0];
  blank.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [blank.id]
  )).rows[0].user_id;
  await pool.query('UPDATE users SET name=NULL WHERE id=$1', [blank.user_id]);
  await pool.query(
    `UPDATE organizers
        SET name=NULL,org_name=NULL,public_slug=NULL
      WHERE id=$1`,
    [blank.id]
  );
  const blankPreview = await doneForYouLookup(session, { email: 'dfy-fill-blank@example.test' });
  assert.equal(blankPreview.status, 200);
  const filledResponse = await provisionDoneForYou(session, {
    hostName: 'Filled Host',
    contactName: 'Filled Person',
    email: 'dfy-fill-blank@example.test',
    expectedUserId: blank.user_id
  });
  assert.equal(filledResponse.status, 201);
  const filled = (await pool.query(
    `SELECT canonical_user.name,organizer.name AS organizer_name,
            organizer.org_name,organizer.public_slug,marker.updated_at
       FROM users canonical_user
       JOIN organizers organizer ON organizer.user_id=canonical_user.id
       JOIN admin_done_for_you_clients marker ON marker.target_user_id=canonical_user.id
      WHERE canonical_user.id=$1`,
    [blank.user_id]
  )).rows[0];
  assert.equal(filled.name, 'Filled Person');
  assert.equal(filled.organizer_name, 'Filled Person');
  assert.equal(filled.org_name, 'Filled Host');
  assert.match(filled.public_slug, /^filled-host/);

  await new Promise(resolve => setTimeout(resolve, 10));
  await pool.query('UPDATE users SET name=NULL WHERE id=$1', [blank.user_id]);
  const repaired = await provisionDoneForYou(session, {
    hostName: 'Must Not Replace Filled Host',
    contactName: 'Repaired Person',
    email: 'dfy-fill-blank@example.test',
    expectedUserId: blank.user_id
  });
  assert.equal(repaired.status, 201);
  assert.equal((await repaired.json()).client.noOp, false);
  const touched = (await pool.query(
    `SELECT canonical_user.name,organizer.org_name,marker.updated_at
       FROM users canonical_user
       JOIN organizers organizer ON organizer.user_id=canonical_user.id
       JOIN admin_done_for_you_clients marker ON marker.target_user_id=canonical_user.id
      WHERE canonical_user.id=$1`,
    [blank.user_id]
  )).rows[0];
  assert.equal(touched.name, 'Repaired Person');
  assert.equal(touched.org_name, 'Filled Host');
  assert.ok(new Date(touched.updated_at) > new Date(filled.updated_at));

  const staleInput = {
    hostName: 'Signup Won Host',
    contactName: 'Signup Won Owner',
    email: 'dfy-signup-won@example.test'
  };
  const stalePreview = await doneForYouLookup(session, staleInput);
  assert.equal(stalePreview.status, 200);
  assert.equal((await stalePreview.json()).expectedUserId, null);
  const signupWinner = (await pool.query(
    `INSERT INTO organizers (email,name,last_login_at)
     VALUES ($1,$2,NOW()) RETURNING id,user_id`,
    [staleInput.email, staleInput.contactName]
  )).rows[0];
  signupWinner.user_id = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [signupWinner.id]
  )).rows[0].user_id;
  const usersBefore = (await pool.query('SELECT COUNT(*)::int AS count FROM users')).rows[0].count;
  const staleProvision = await provisionDoneForYou(session, {
    ...staleInput,
    expectedUserId: null
  });
  assert.equal(staleProvision.status, 409);
  const staleBody = await staleProvision.json();
  assert.equal(staleBody.error, 'done_for_you_lookup_changed');
  assert.equal(staleBody.actualUserId, signupWinner.user_id);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM users')).rows[0].count, usersBefore);
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM admin_done_for_you_clients WHERE target_user_id=$1',
    [signupWinner.user_id]
  )).rows[0].count, 0);
});

test('Done For You Host Page support edits and media are dedicated, audited, and target-isolated', async t => {
  resetRateLimits();
  const operator = await createAdminOperator('dfy-host-support@example.test', 'support');
  const session = await signInAdminOperator(operator.email);
  const first = await createDoneForYouClient(session, {
    hostName: 'First Managed Host', contactName: 'First Client',
    email: 'first-managed-host@example.test'
  });
  const second = await createDoneForYouClient(session, {
    hostName: 'Second Managed Host', contactName: 'Second Client',
    email: 'second-managed-host@example.test'
  });

  await pool.query('UPDATE organizers SET is_admin=TRUE WHERE id=$1', [organizerId]);
  const legacyCookie = `sge_session=${signSession(organizerId)}`;
  const legacyDenied = await fetch(
    `${baseUrl}/api/admin/hosts/${first.client.organizerId}/profile`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: legacyCookie },
      body: JSON.stringify({ org_name: 'Legacy Must Not Edit' })
    }
  );
  assert.equal(legacyDenied.status, 403);
  assert.equal((await legacyDenied.json()).error, 'dedicated_admin_required');
  const crossOriginDenied = await fetch(
    `${baseUrl}/api/admin/hosts/${first.client.organizerId}/profile`,
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/json', cookie: session,
        origin: 'https://attacker.example'
      },
      body: JSON.stringify({ org_name: 'Cross Origin Must Not Edit' })
    }
  );
  assert.equal(crossOriginDenied.status, 403);

  const profile = await fetch(
    `${baseUrl}/api/admin/hosts/${first.client.organizerId}/profile`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: session },
      body: JSON.stringify({
        org_name: 'First Managed Host Updated',
        bio: 'A support-prepared public description.',
        website_url: 'https://first-managed.example',
        instagram_handle: '@firstmanaged',
        contact_email: 'public-contact@example.test'
      })
    }
  );
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).host.org_name, 'First Managed Host Updated');
  const unchangedSecond = (await pool.query(
    'SELECT org_name,logo_url,header_image_url FROM organizers WHERE id=$1',
    [second.client.organizerId]
  )).rows[0];
  assert.equal(unchangedSecond.org_name, 'Second Managed Host');
  assert.equal(unchangedSecond.logo_url, null);
  assert.equal(unchangedSecond.header_image_url, null);

  const logoUrl = 'https://res.cloudinary.com/integration-cloud/image/upload/v123/sg-events-dev/hosts/first-logo.png';
  const headerUrl = 'https://res.cloudinary.com/integration-cloud/image/upload/v124/sg-events-dev/hosts/headers/first-header.jpg';
  uploadRoutes.setAdminHostUploadsForTests({
    configured: true,
    logo: async () => ({ secure_url: logoUrl }),
    header: async () => ({ secure_url: headerUrl })
  });
  t.after(() => uploadRoutes.setAdminHostUploadsForTests());
  async function upload(kind) {
    const form = new FormData();
    form.set('image', new Blob([Buffer.from(kind)], { type: 'image/png' }), `${kind}.png`);
    return fetch(
      `${baseUrl}/api/admin/uploads/hosts/${first.client.organizerId}/${kind}`,
      { method: 'POST', headers: { cookie: session }, body: form }
    );
  }
  const logo = await upload('logo');
  assert.equal(logo.status, 200);
  assert.equal((await logo.json()).url, logoUrl);
  const header = await upload('header');
  assert.equal(header.status, 200);
  assert.equal((await header.json()).url, headerUrl);

  const firstStored = (await pool.query(
    'SELECT logo_url,header_image_url FROM organizers WHERE id=$1',
    [first.client.organizerId]
  )).rows[0];
  assert.equal(firstStored.logo_url, logoUrl);
  assert.equal(firstStored.header_image_url, headerUrl);
  const supportAuditRows = (await pool.query(
    `SELECT action_type,target_user_id,actor_admin_operator_id,
            before_state,after_state,metadata
       FROM admin_account_audit_log
      WHERE target_user_id=$1
        AND action_type IN ('host_profile_updated','host_logo_updated','host_header_updated')
      ORDER BY id`,
    [first.client.userId]
  )).rows;
  assert.doesNotMatch(
    JSON.stringify(supportAuditRows),
    /First Managed Host Updated|support-prepared|first-managed\.example|public-contact@example|res\.cloudinary\.com/
  );
  assert.deepEqual(supportAuditRows.map(row => ({
    action: row.action_type,
    target: Number(row.target_user_id),
    operator: Number(row.actor_admin_operator_id),
    mediaKind: row.metadata?.mediaKind || null,
    managedAfter: row.after_state?.managedPublicId || null
  })), [
    { action: 'host_profile_updated', target: first.client.userId, operator: Number(operator.id), mediaKind: null, managedAfter: null },
    { action: 'host_logo_updated', target: first.client.userId, operator: Number(operator.id), mediaKind: 'logo', managedAfter: 'sg-events-dev/hosts/first-logo' },
    { action: 'host_header_updated', target: first.client.userId, operator: Number(operator.id), mediaKind: 'header', managedAfter: 'sg-events-dev/hosts/headers/first-header' }
  ]);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM admin_account_audit_log
      WHERE target_user_id=$1
        AND action_type IN ('host_profile_updated','host_logo_updated','host_header_updated')`,
    [second.client.userId]
  )).rows[0].count, 0);
});

test('Done For You claims serialize behind suspension and deletion without issuing a customer session', async t => {
  resetRateLimits();
  const operator = await createAdminOperator('dfy-race-super@example.test', 'super_admin');
  const session = await signInAdminOperator(operator.email);
  const delivered = [];
  adminDoneForYouRoutes.setClaimSenderForTests(async message => { delivered.push(message.link); });
  t.after(() => adminDoneForYouRoutes.setClaimSenderForTests());

  async function preparedClaim(email, label) {
    const prepared = await createDoneForYouClient(session, {
      hostName: `${label} Host`, contactName: `${label} Client`, email
    });
    const sent = await fetch(
      `${baseUrl}/api/admin/done-for-you/${prepared.client.id}/claim-invitation`,
      { method: 'POST', headers: { 'content-type': 'application/json', cookie: session }, body: '{}' }
    );
    assert.equal(sent.status, 201);
    return { ...prepared, link: delivered.at(-1) };
  }
  async function claim(link) {
    return fetch(`${baseUrl}/auth/verify`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokenFromLink(link) })
    });
  }
  async function withBlockedUser(userId, work) {
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
    try {
      return await work(async () => {
        await blocker.query('COMMIT');
      });
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
    }
  }

  const suspended = await preparedClaim('dfy-claim-suspend-race@example.test', 'Suspend Race');
  await withBlockedUser(suspended.client.userId, async release => {
    const suspension = fetch(`${baseUrl}/api/admin/accounts/${suspended.client.userId}/suspend`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: session },
      body: JSON.stringify({ reason: 'Serialize account suspension before recipient claim completion' })
    });
    await waitUntilOutboundLockHeld(suspended.client.userId);
    let claimSettled = false;
    const attemptedClaim = claim(suspended.link).then(response => {
      claimSettled = true;
      return response;
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(claimSettled, false);
    await release();
    const [suspendResponse, claimResponse] = await Promise.all([suspension, attemptedClaim]);
    assert.equal(suspendResponse.status, 200);
    assert.equal(claimResponse.status, 400);
    assert.doesNotMatch(claimResponse.headers.get('set-cookie') || '', /sge_session=/);
  });

  const deleted = await preparedClaim('dfy-claim-delete-race@example.test', 'Delete Race');
  const deletionCookie = await adminDeletionProof(session, deleted.client.userId);
  await withBlockedUser(deleted.client.userId, async release => {
    const deletion = fetch(`${baseUrl}/api/admin/accounts/${deleted.client.userId}/delete-account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: deletionCookie },
      body: JSON.stringify({
        reason: 'Serialize permanent deletion before recipient claim completion',
        confirmation: `DELETE USER ${deleted.client.userId}`
      })
    });
    await waitUntilOutboundLockHeld(deleted.client.userId);
    let claimSettled = false;
    const attemptedClaim = claim(deleted.link).then(response => {
      claimSettled = true;
      return response;
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(claimSettled, false);
    await release();
    const [deleteResponse, claimResponse] = await Promise.all([deletion, attemptedClaim]);
    assert.equal(deleteResponse.status, 200);
    assert.equal(claimResponse.status, 303);
    assert.match(claimResponse.headers.get('location') || '', /^\/login\?error=expired/);
    assert.doesNotMatch(claimResponse.headers.get('set-cookie') || '', /sge_session=/);
  });
});

test('a target-bound Done For You claim is terminal after its exact email is reassigned', async t => {
  resetRateLimits();
  const operator = await createAdminOperator('dfy-mismatch-support@example.test', 'support');
  const session = await signInAdminOperator(operator.email);
  const prepared = await createDoneForYouClient(session, {
    hostName: 'Mismatch Host', contactName: 'Mismatch Client',
    email: 'dfy-target-mismatch@example.test'
  });
  let claimLink = '';
  adminDoneForYouRoutes.setClaimSenderForTests(async message => { claimLink = message.link; });
  t.after(() => adminDoneForYouRoutes.setClaimSenderForTests());
  const sent = await fetch(
    `${baseUrl}/api/admin/done-for-you/${prepared.client.id}/claim-invitation`,
    { method: 'POST', headers: { 'content-type': 'application/json', cookie: session }, body: '{}' }
  );
  assert.equal(sent.status, 201);
  const invitationId = (await sent.json()).invitation.id;
  const other = (await pool.query(
    `INSERT INTO organizers (email,name)
     VALUES ('different-target@example.test','Different Target') RETURNING id`
  )).rows[0];
  const otherUserId = (await pool.query(
    'SELECT user_id FROM organizers WHERE id=$1', [other.id]
  )).rows[0].user_id;
  await pool.query(
    `UPDATE user_identities SET user_id=$2,updated_at=NOW()
      WHERE user_id=$1 AND identity_type='email'
        AND normalized_value='dfy-target-mismatch@example.test'`,
    [prepared.client.userId, otherUserId]
  );
  const token = tokenFromLink(claimLink);
  const mismatch = await fetch(`${baseUrl}/auth/verify`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token })
  });
  assert.equal(mismatch.status, 409);
  assert.doesNotMatch(mismatch.headers.get('set-cookie') || '', /sge_session=/);
  const terminal = (await pool.query(
    `SELECT invitation.revoked_at,challenge.used_at
       FROM admin_account_invitations invitation
       JOIN magic_link_tokens challenge ON challenge.id=invitation.magic_link_token_id
      WHERE invitation.id=$1`,
    [invitationId]
  )).rows[0];
  assert.ok(terminal.revoked_at);
  assert.ok(terminal.used_at);
  const replay = await fetch(`${baseUrl}/auth/verify`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token })
  });
  assert.equal(replay.status, 400);
});

test('Done For You editor workspaces are operator-bound, expiring, audited, and never customer sessions', async () => {
  resetRateLimits();
  const operator = await createAdminOperator('editor-support@example.test', 'super_admin');
  const otherOperator = await createAdminOperator('other-editor-support@example.test', 'support');
  const adminSession = await signInAdminOperator(operator.email);
  const parsedAdminSession = parseAdminSession(adminSession.slice('sge_admin_session='.length));
  assert.ok(parsedAdminSession);
  const otherAdminSession = await signInAdminOperator(otherOperator.email);
  const signedOutEditor = await fetch(`${baseUrl}/admin-editor/events/new`, {
    redirect: 'manual'
  });
  assert.equal(signedOutEditor.status, 302);
  assert.equal(signedOutEditor.headers.get('location'),
    '/admin/login?next=%2Fadmin-editor%2Fevents%2Fnew');
  const editorLoginReturn = await fetch(
    `${baseUrl}/admin/login?next=%2Fadmin-editor%2Fevents%2Fnew`,
    { redirect: 'manual', headers: { cookie: adminSession } }
  );
  assert.equal(editorLoginReturn.headers.get('location'), '/admin-editor/events/new');
  const missingWorkspacePage = await fetch(`${baseUrl}/admin-editor/events/new`, {
    redirect: 'manual',
    headers: { cookie: adminSession, accept: 'text/html' }
  });
  assert.equal(missingWorkspacePage.status, 302);
  assert.equal(missingWorkspacePage.headers.get('location'),
    '/admin/done-for-you?editor=expired');
  const missingWorkspaceApi = await fetch(`${baseUrl}/admin-editor/api/workspace`, {
    redirect: 'manual', headers: { cookie: adminSession, accept: 'text/html' }
  });
  assert.equal(missingWorkspaceApi.status, 401,
    'editor APIs keep structured JSON errors even when the caller accepts HTML');
  assert.equal((await missingWorkspaceApi.json()).error, 'admin_editor_workspace_required');
  for (const hostileNext of [
    'https://evil.example/admin-editor/events/new',
    '//evil.example/admin-editor/events/new',
    '/\\evil.example/admin-editor/events/new',
    '/%5Cevil.example/admin-editor/events/new'
  ]) {
    const rejectedNext = await fetch(
      `${baseUrl}/admin/login?next=${encodeURIComponent(hostileNext)}`,
      { redirect: 'manual', headers: { cookie: adminSession } }
    );
    assert.equal(rejectedNext.headers.get('location'), '/admin',
      `admin login rejects external return URL ${hostileNext}`);
  }
  const prepared = await createDoneForYouClient(adminSession, {
    hostName: 'Scoped Editor Host',
    contactName: 'Scoped Editor Client',
    email: 'scoped-editor-client@example.test'
  });
  const markerId = prepared.client.id;
  const organizerId = prepared.client.organizerId;

  const start = (cookie, body = {}) => fetch(
    `${baseUrl}/api/admin/done-for-you/${markerId}/editor-workspaces`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body)
    }
  );

  const customerOnly = await start(`sge_session=${signSession(organizerId)}`);
  assert.equal(customerOnly.status, 403,
    'a customer account cannot enter the independent admin editor realm');

  const opened = await start(adminSession);
  assert.equal(opened.status, 201);
  const openedBody = await opened.json();
  assert.equal(openedBody.redirect, '/admin-editor/events/new');
  assert.equal(openedBody.workspace.doneForYouClientId, Number(markerId));
  assert.equal(openedBody.workspace.organizerId, Number(organizerId));
  assert.equal(openedBody.workspace.eventId, null);
  const openedSetCookie = opened.headers.get('set-cookie') || '';
  assert.match(openedSetCookie, /sge_admin_editor=/);
  assert.match(openedSetCookie, /Path=\/admin-editor/);
  assert.match(openedSetCookie, /HttpOnly/i);
  assert.match(openedSetCookie, /SameSite=Strict/i);
  assert.doesNotMatch(openedSetCookie, /sge_session=/,
    'opening an editor workspace never issues a customer session');
  const editorCookie = responseCookie(opened, 'sge_admin_editor');
  assert.ok(editorCookie);
  const rawEditorToken = editorCookie.slice('sge_admin_editor='.length);
  const stored = (await pool.query(
    `SELECT token_hash,status,actor_admin_operator_id
       FROM admin_event_editor_workspaces WHERE id=$1`,
    [openedBody.workspace.id]
  )).rows[0];
  assert.notEqual(stored.token_hash, rawEditorToken);
  assert.equal(stored.token_hash.length, 64);
  assert.equal(stored.status, 'active');
  assert.equal(Number(stored.actor_admin_operator_id), Number(operator.id));

  const noAdminSession = await fetch(`${baseUrl}/admin-editor/api/workspace/exit`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: editorCookie }, body: '{}'
  });
  assert.equal(noAdminSession.status, 401);
  const wrongOperator = await fetch(`${baseUrl}/admin-editor/api/workspace/exit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(otherAdminSession, editorCookie)
    },
    body: '{}'
  });
  assert.equal(wrongOperator.status, 403);
  assert.equal((await wrongOperator.json()).error, 'admin_editor_operator_mismatch');
  assert.equal((await pool.query(
    'SELECT status FROM admin_event_editor_workspaces WHERE id=$1',
    [openedBody.workspace.id]
  )).rows[0].status, 'active', 'a mismatched operator cannot revoke another operator’s grant');

  const exited = await fetch(`${baseUrl}/admin-editor/api/workspace/exit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(adminSession, editorCookie)
    },
    body: '{}'
  });
  assert.equal(exited.status, 200);
  assert.deepEqual(await exited.json(), {
    ok: true,
    redirect: `/admin/done-for-you/${markerId}`
  });
  assert.match(exited.headers.get('set-cookie') || '', /sge_admin_editor=;/);
  assert.equal((await pool.query(
    'SELECT status FROM admin_event_editor_workspaces WHERE id=$1',
    [openedBody.workspace.id]
  )).rows[0].status, 'exited');
  const audit = (await pool.query(
    `SELECT action_type FROM admin_account_audit_log
      WHERE actor_admin_operator_id=$1 AND target_user_id=$2
        AND action_type LIKE 'done_for_you_event_workspace_%'
      ORDER BY id`,
    [operator.id, prepared.client.userId]
  )).rows.map(row => row.action_type);
  assert.deepEqual(audit, [
    'done_for_you_event_workspace_opened',
    'done_for_you_event_workspace_exited'
  ]);
  assert.equal((await fetch(`${baseUrl}/admin-editor/api/workspace/exit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(adminSession, editorCookie)
    },
    body: '{}'
  })).status, 401, 'an exited grant cannot be replayed');

  const draft = (await pool.query(
    `INSERT INTO events
       (organizer_id,slug,title,event_date,start_time,venue_name,visibility,status)
     VALUES ($1,'admin-editor-draft','Admin Editor Draft','2031-01-02','19:00',
             'Scoped Hall','private','draft')
     RETURNING id`,
    [organizerId]
  )).rows[0];
  const bound = await start(adminSession, { eventId: draft.id });
  assert.equal(bound.status, 201);
  const boundBody = await bound.json();
  assert.equal(boundBody.redirect, `/admin-editor/events/new?id=${draft.id}&advanced=1`);
  assert.equal(boundBody.workspace.eventId, Number(draft.id));
  assert.doesNotMatch(bound.headers.get('set-cookie') || '', /sge_session=/);
  const replacedBound = await start(adminSession, { eventId: draft.id });
  assert.equal(replacedBound.status, 201,
    'the same operator can rotate its token when reopening the same draft');
  const replacedBoundBody = await replacedBound.json();
  const boundCookie = responseCookie(replacedBound, 'sge_admin_editor');
  assert.equal((await pool.query(
    'SELECT status FROM admin_event_editor_workspaces WHERE id=$1',
    [boundBody.workspace.id]
  )).rows[0].status, 'revoked');
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM admin_account_audit_log
      WHERE actor_admin_operator_id=$1
        AND action_type='done_for_you_event_workspace_revoked'
        AND metadata->>'cause'='replacement'
        AND (after_state->>'workspaceId')::bigint=$2`,
    [operator.id, boundBody.workspace.id]
  )).rows[0].count, 1, 'same-operator replacement is audited once');

  const otherHost = (await pool.query(
    `INSERT INTO organizers (email,name,org_name,public_slug)
     VALUES ('different-editor-host@example.test','Other Host','Other Host','other-editor-host')
     RETURNING id`
  )).rows[0];
  const otherDraft = (await pool.query(
    `INSERT INTO events
       (organizer_id,slug,title,event_date,start_time,venue_name,visibility,status)
     VALUES ($1,'other-editor-draft','Other Draft','2031-02-03','20:00',
             'Other Hall','private','draft')
     RETURNING id`,
    [otherHost.id]
  )).rows[0];
  const wrongDraft = await start(adminSession, { eventId: otherDraft.id });
  assert.equal(wrongDraft.status, 409);
  assert.equal((await wrongDraft.json()).error, 'admin_editor_draft_not_available');

  await pool.query(
    `UPDATE admin_event_editor_workspaces
        SET created_at=NOW() - INTERVAL '3 hours',
            expires_at=NOW() - INTERVAL '1 hour'
      WHERE id=$1`,
    [replacedBoundBody.workspace.id]
  );
  const expired = await fetch(`${baseUrl}/admin-editor/api/workspace/exit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(adminSession, boundCookie)
    },
    body: '{}'
  });
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).error, 'admin_editor_workspace_expired');
  assert.equal((await pool.query(
    'SELECT status FROM admin_event_editor_workspaces WHERE id=$1',
    [replacedBoundBody.workspace.id]
  )).rows[0].status, 'expired');
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM admin_account_audit_log
      WHERE actor_admin_operator_id=$1
        AND action_type='done_for_you_event_workspace_expired'
        AND metadata->>'cause'='ttl'
        AND (after_state->>'workspaceId')::bigint=$2`,
    [operator.id, replacedBoundBody.workspace.id]
  )).rows[0].count, 1, 'automatic expiration is audited once');
  const expiredWorkspacePage = await fetch(`${baseUrl}/admin-editor/events/new`, {
    redirect: 'manual',
    headers: {
      cookie: cookieHeader(adminSession, boundCookie),
      accept: 'text/html'
    }
  });
  assert.equal(expiredWorkspacePage.status, 302);
  assert.equal(expiredWorkspacePage.headers.get('location'),
    '/admin/done-for-you?editor=expired');

  const targetState = await start(adminSession);
  assert.equal(targetState.status, 201);
  const targetStateBody = await targetState.json();
  const targetStateCookie = responseCookie(targetState, 'sge_admin_editor');
  await pool.query(
    `UPDATE users
        SET account_status='suspended',suspended_at=NOW(),
            suspension_reason='Integration target-state check'
      WHERE id=$1`,
    [prepared.client.userId]
  );
  const suspended = await fetch(`${baseUrl}/admin-editor/api/workspace/exit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(adminSession, targetStateCookie)
    },
    body: '{}'
  });
  assert.equal(suspended.status, 403);
  assert.equal((await suspended.json()).error, 'admin_editor_scope_unavailable');
  assert.equal((await pool.query(
    'SELECT status FROM admin_event_editor_workspaces WHERE id=$1',
    [targetStateBody.workspace.id]
  )).rows[0].status, 'revoked');
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM admin_account_audit_log
      WHERE actor_admin_operator_id=$1
        AND action_type='done_for_you_event_workspace_revoked'
        AND metadata->>'cause'='scope_unavailable'
        AND (after_state->>'workspaceId')::bigint=$2`,
    [operator.id, targetStateBody.workspace.id]
  )).rows[0].count, 1, 'target-state revocation is audited once');

  await pool.query(
    `UPDATE users
        SET account_status='active',suspended_at=NULL,suspension_reason=NULL
      WHERE id=$1`,
    [prepared.client.userId]
  );

  const ownershipDrift = await start(adminSession);
  assert.equal(ownershipDrift.status, 201);
  const ownershipDriftBody = await ownershipDrift.json();
  const ownershipDriftCookie = responseCookie(ownershipDrift, 'sge_admin_editor');
  const driftUser = (await pool.query(
    `INSERT INTO users (name) VALUES ('Drift Owner') RETURNING id`
  )).rows[0];
  const driftOwner = (await pool.query(
    `INSERT INTO organizers (id,user_id,email,name,org_name,public_slug)
     VALUES ($1,$1,'drift-owner@example.test','Drift Owner','Drift Owner','drift-owner')
     RETURNING id,user_id`,
    [driftUser.id]
  )).rows[0];
  await pool.query(
    'UPDATE admin_done_for_you_clients SET target_user_id=$2 WHERE id=$1',
    [markerId, driftOwner.user_id]
  );
  const drifted = await fetch(`${baseUrl}/admin-editor/api/workspace/exit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(adminSession, ownershipDriftCookie)
    },
    body: '{}'
  });
  assert.equal(drifted.status, 403);
  assert.equal((await drifted.json()).error, 'admin_editor_scope_unavailable');
  assert.equal((await pool.query(
    'SELECT status,target_user_id,organizer_id FROM admin_event_editor_workspaces WHERE id=$1',
    [ownershipDriftBody.workspace.id]
  )).rows[0].status, 'revoked');
  assert.equal(Number((await pool.query(
    'SELECT target_user_id FROM admin_event_editor_workspaces WHERE id=$1',
    [ownershipDriftBody.workspace.id]
  )).rows[0].target_user_id), Number(prepared.client.userId),
  'the immutable workspace snapshot never follows marker ownership drift');
  await pool.query(
    'UPDATE admin_done_for_you_clients SET target_user_id=$2 WHERE id=$1',
    [markerId, prepared.client.userId]
  );

  const forLogout = await start(adminSession);
  assert.equal(forLogout.status, 201);
  const forLogoutBody = await forLogout.json();
  const forLogoutCookie = responseCookie(forLogout, 'sge_admin_editor');
  const pendingLogin = await fetch(`${baseUrl}/api/admin/auth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: operator.email })
  });
  assert.equal(pendingLogin.status, 200);
  await adminAuthRoutes.settleBackgroundWork();
  const pendingLoginChallengeId = (await pool.query(
    `SELECT id FROM admin_auth_challenges
      WHERE operator_id=$1 AND purpose='login' AND used_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [operator.id]
  )).rows[0].id;
  const logoutProofCookie = await adminOperatorProof(
    adminSession,
    `operator:${otherOperator.id}`
  );
  const pendingActionProofId = (await pool.query(
    `SELECT id FROM admin_action_proofs
      WHERE operator_id=$1 AND consumed_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [operator.id]
  )).rows[0].id;
  const cutoffBeforeLogout = (await pool.query(
    'SELECT sessions_valid_after FROM admin_operators WHERE id=$1',
    [operator.id]
  )).rows[0].sessions_valid_after;
  const logout = await fetch(`${baseUrl}/api/admin/auth/logout`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(logoutProofCookie, forLogoutCookie)
    },
    body: '{}'
  });
  assert.equal(logout.status, 200);
  const logoutCookies = logout.headers.get('set-cookie') || '';
  assert.match(logoutCookies, /sge_admin_session=;/);
  assert.match(logoutCookies, /sge_admin_editor=;/);
  assert.match(logoutCookies, /Path=\/admin-editor/);
  assert.equal((await pool.query(
    'SELECT status FROM admin_event_editor_workspaces WHERE id=$1',
    [forLogoutBody.workspace.id]
  )).rows[0].status, 'revoked', 'admin logout revokes its active DB workspace');
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM admin_account_audit_log
      WHERE actor_admin_operator_id=$1
        AND action_type='done_for_you_event_workspace_revoked'
        AND metadata->>'cause'='admin_logout'`,
    [operator.id]
  )).rows[0].count, 1);
  const invalidatedOperator = (await pool.query(
    'SELECT sessions_valid_after FROM admin_operators WHERE id=$1',
    [operator.id]
  )).rows[0];
  assert.ok(invalidatedOperator.sessions_valid_after > cutoffBeforeLogout,
    'normal logout advances the dedicated administrator credential epoch');
  assert.ok((await pool.query(
    'SELECT used_at FROM admin_auth_challenges WHERE id=$1',
    [pendingLoginChallengeId]
  )).rows[0].used_at, 'normal logout consumes pending administrator challenges');
  assert.ok((await pool.query(
    'SELECT consumed_at FROM admin_action_proofs WHERE id=$1',
    [pendingActionProofId]
  )).rows[0].consumed_at, 'normal logout consumes pending administrator action proofs');
  assert.equal((await fetch(`${baseUrl}/api/admin/auth/me`, {
    headers: { cookie: adminSession }
  })).status, 401, 'a logged-out dedicated administrator session cannot be replayed');
  await assert.rejects(
    openAdminEditorWorkspace(pool, {
      doneForYouClientId: markerId,
      actorAdminOperatorId: operator.id,
      sessionIssuedAt: parsedAdminSession.issuedAt
    }),
    error => error instanceof AdminEditorWorkspaceError &&
      error.code === 'admin_editor_admin_session_revoked',
    'a request authenticated before logout cannot generate a workspace after the credential epoch advances'
  );

  const freshAdminSession = await signInAdminOperator(operator.email);
  const deletedTargetWorkspace = await start(freshAdminSession);
  assert.equal(deletedTargetWorkspace.status, 201);
  const deletedTargetBody = await deletedTargetWorkspace.json();
  const deletedTargetCookie = responseCookie(deletedTargetWorkspace, 'sge_admin_editor');
  await pool.query(
    `UPDATE users
        SET name=NULL,account_status='deleted',deleted_at=NOW(),
            deletion_reason='Integration unavailable-target check',
            suspended_at=NULL,suspended_by_user_id=NULL,
            suspended_by_admin_operator_id=NULL,suspension_reason=NULL
      WHERE id=$1`,
    [prepared.client.userId]
  );
  const deletedTarget = await fetch(`${baseUrl}/admin-editor/api/workspace/exit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(freshAdminSession, deletedTargetCookie)
    },
    body: '{}'
  });
  assert.equal(deletedTarget.status, 403);
  assert.equal((await deletedTarget.json()).error, 'admin_editor_scope_unavailable');
  assert.equal((await pool.query(
    'SELECT status FROM admin_event_editor_workspaces WHERE id=$1',
    [deletedTargetBody.workspace.id]
  )).rows[0].status, 'revoked');
  await pool.query(
    `UPDATE users
        SET name='Scoped Editor Client',account_status='active',deleted_at=NULL,
            deleted_by_user_id=NULL,deleted_by_admin_operator_id=NULL,deletion_reason=NULL
      WHERE id=$1`,
    [prepared.client.userId]
  );

  const deletable = await createDoneForYouClient(freshAdminSession, {
    hostName: 'Disposable Workspace Host',
    contactName: 'Disposable Workspace Client',
    email: 'disposable-workspace@example.test'
  });
  const deletableOpened = await fetch(
    `${baseUrl}/api/admin/done-for-you/${deletable.client.id}/editor-workspaces`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: freshAdminSession },
      body: '{}'
    }
  );
  assert.equal(deletableOpened.status, 201);
  const deletableBody = await deletableOpened.json();
  const deletableCookie = responseCookie(deletableOpened, 'sge_admin_editor');
  await pool.query('DELETE FROM organizers WHERE id=$1', [deletable.client.organizerId]);
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM admin_event_editor_workspaces WHERE id=$1',
    [deletableBody.workspace.id]
  )).rows[0].count, 0, 'Host deletion cascades through the scoped workspace instead of being blocked');
  const staleAfterHostDelete = await fetch(`${baseUrl}/admin-editor/api/workspace/exit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(freshAdminSession, deletableCookie)
    },
    body: '{}'
  });
  assert.equal(staleAfterHostDelete.status, 401);
  assert.equal((await staleAfterHostDelete.json()).error, 'admin_editor_workspace_required');

  const disabledOperatorWorkspace = await start(otherAdminSession);
  assert.equal(disabledOperatorWorkspace.status, 201);
  const disabledOperatorBody = await disabledOperatorWorkspace.json();
  const disabledOperatorCookie = responseCookie(disabledOperatorWorkspace, 'sge_admin_editor');
  const disableProof = await adminOperatorProof(
    freshAdminSession,
    `operator:${otherOperator.id}`
  );
  const disableOperator = await fetch(`${baseUrl}/api/admin/operators/${otherOperator.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: disableProof },
    body: JSON.stringify({
      status: 'disabled',
      reason: 'End the scoped editor access for lifecycle testing'
    })
  });
  assert.equal(disableOperator.status, 200);
  assert.equal((await disableOperator.json()).operator.status, 'disabled');
  assert.equal((await pool.query(
    'SELECT status FROM admin_event_editor_workspaces WHERE id=$1',
    [disabledOperatorBody.workspace.id]
  )).rows[0].status, 'revoked', 'disabling an operator closes the workspace atomically');
  const disabledAudit = (await pool.query(
    `SELECT actor_admin_operator_id,metadata
       FROM admin_account_audit_log
      WHERE action_type='done_for_you_event_workspace_revoked'
        AND (after_state->>'workspaceId')::bigint=$1`,
    [disabledOperatorBody.workspace.id]
  )).rows[0];
  assert.equal(Number(disabledAudit.actor_admin_operator_id), Number(operator.id),
    'the Super Admin who disabled access is the lifecycle audit actor');
  assert.equal(disabledAudit.metadata.cause, 'operator_disabled');
  assert.equal(Number(disabledAudit.metadata.workspaceOperatorId), Number(otherOperator.id));
  const disabledOperatorRequest = await fetch(`${baseUrl}/admin-editor/api/workspace/exit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(otherAdminSession, disabledOperatorCookie)
    },
    body: '{}'
  });
  assert.equal(disabledOperatorRequest.status, 401,
    'a disabled operator cannot use an otherwise unexpired editor grant');
  resetRateLimits();
  const enableProof = await adminOperatorProof(
    freshAdminSession,
    `operator:${otherOperator.id}`
  );
  const enableOperator = await fetch(`${baseUrl}/api/admin/operators/${otherOperator.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: enableProof },
    body: JSON.stringify({
      status: 'active',
      reason: 'Restore access after lifecycle testing'
    })
  });
  assert.equal(enableOperator.status, 200);
  const reenabledOtherSession = await signInAdminOperator(otherOperator.email);
  assert.equal((await fetch(`${baseUrl}/admin-editor/api/workspace/exit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(reenabledOtherSession, disabledOperatorCookie)
    },
    body: '{}'
  })).status, 401, 're-enabling an operator never resurrects its revoked workspace cookie');
  const directCutoffWorkspace = await start(reenabledOtherSession);
  assert.equal(directCutoffWorkspace.status, 201);
  const directCutoffBody = await directCutoffWorkspace.json();
  await pool.query(
    `UPDATE admin_operators
        SET sessions_valid_after=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1`,
    [otherOperator.id]
  );
  assert.equal((await pool.query(
    'SELECT status FROM admin_event_editor_workspaces WHERE id=$1',
    [directCutoffBody.workspace.id]
  )).rows[0].status, 'revoked',
  'direct credential revocation remains a fail-closed safety boundary for editor workspaces');

  const lifecycleAudits = (await pool.query(
    `SELECT before_state,after_state,metadata
       FROM admin_account_audit_log
      WHERE action_type LIKE 'done_for_you_event_workspace_%'`
  )).rows;
  for (const entry of lifecycleAudits) {
    const serialized = JSON.stringify(entry);
    assert.doesNotMatch(serialized, /@|email|phone/i,
      'workspace lifecycle audit metadata contains identifiers, not contact PII');
  }
});

test('Done For You admin editor creates one scoped draft, returns a safe DTO, and publishes atomically', async () => {
  resetRateLimits();
  const operator = await createAdminOperator('stage2-editor-support@example.test', 'support');
  const adminSession = await signInAdminOperator(operator.email);
  const prepared = await createDoneForYouClient(adminSession, {
    hostName: 'Stage Two Host',
    contactName: 'Stage Two Client',
    email: 'stage-two-client@example.test'
  });
  const opened = await openDoneForYouEditor(adminSession, prepared.client.id);
  const editorSession = cookieHeader(adminSession, opened.editorCookie);

  const context = await fetch(`${baseUrl}/admin-editor/api/workspace`, {
    headers: { cookie: editorSession }
  });
  assert.equal(context.status, 200);
  const contextBody = await context.json();
  assert.equal(contextBody.workspace.eventId, null);
  assert.equal(contextBody.host.id, prepared.client.organizerId);
  assert.equal(contextBody.host.name, 'Stage Two Host');
  assert.doesNotMatch(JSON.stringify(contextBody), /stage-two-client@example\.test/i,
    'the editor context does not expose account contact identities');

  const customerCookie = `sge_session=${signSession(prepared.client.organizerId)}`;
  const customerAttempt = await fetch(`${baseUrl}/admin-editor/api/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(customerCookie, opened.editorCookie)
    },
    body: JSON.stringify({})
  });
  assert.equal(customerAttempt.status, 403,
    'a customer session cannot substitute for the dedicated administrator session');

  const presenterRejected = await fetch(`${baseUrl}/admin-editor/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: editorSession },
    body: JSON.stringify({
      title: 'Should not be created', event_date: '2033-04-12', start_time: '19:30',
      venue_name: 'Stage Hall', presenter_name: 'Overwrite Host'
    })
  });
  assert.equal(presenterRejected.status, 400);
  assert.equal((await presenterRejected.json()).error, 'admin_editor_presenter_immutable');
  assert.equal((await pool.query(
    'SELECT org_name FROM organizers WHERE id=$1',
    [prepared.client.organizerId]
  )).rows[0].org_name, 'Stage Two Host');

  const created = await fetch(`${baseUrl}/admin-editor/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: editorSession },
    body: JSON.stringify({
      title: 'Admin Prepared Night',
      description: 'A client-ready event draft.',
      event_date: '2033-04-12',
      start_time: '19:30',
      venue_name: 'Stage Hall',
      venue_address: '12 Stage Way',
      visibility: 'private',
      admission_type: 'free_rsvp',
      status: 'published'
    })
  });
  assert.equal(created.status, 201);
  assert.doesNotMatch(created.headers.get('set-cookie') || '', /sge_session=/,
    'admin event creation never creates a customer session');
  const createdBody = await created.json();
  const eventId = Number(createdBody.event.id);
  assert.equal(createdBody.event.status, 'draft', 'the admin quick-create always forces a draft');
  assert.equal(Number(createdBody.event.organizer_id), prepared.client.organizerId);
  const storedWorkspace = (await pool.query(
    'SELECT event_id,status FROM admin_event_editor_workspaces WHERE id=$1',
    [opened.body.workspace.id]
  )).rows[0];
  assert.equal(Number(storedWorkspace.event_id), eventId);
  assert.equal(storedWorkspace.status, 'active');

  await pool.query(
    `UPDATE events
        SET photo_upload_token='admin-editor-secret-upload',
            photo_short_token='admin-editor-secret-short'
      WHERE id=$1`,
    [eventId]
  );
  const read = await fetch(`${baseUrl}/admin-editor/api/events/${eventId}`, {
    headers: { cookie: editorSession }
  });
  assert.equal(read.status, 200);
  const readBody = await read.json();
  assert.equal(readBody.event.title, 'Admin Prepared Night');
  assert.equal(Object.hasOwn(readBody.event, 'photo_upload_token'), false);
  assert.equal(Object.hasOwn(readBody.event, 'photo_short_token'), false);
  assert.equal(Object.hasOwn(readBody.event, 'email'), false);

  const wrongEvent = await createEvent({
    slug: 'admin-editor-out-of-scope',
    title: 'Out Of Scope',
    status: 'draft'
  });
  const wrongRead = await fetch(`${baseUrl}/admin-editor/api/events/${wrongEvent.id}`, {
    headers: { cookie: editorSession }
  });
  assert.equal(wrongRead.status, 404);

  await createRsvp(eventId, { email: 'admin-editor-guest@example.test' });
  const updated = await fetch(`${baseUrl}/admin-editor/api/events/${eventId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: editorSession },
    body: JSON.stringify({
      title: 'Admin Prepared Night Updated',
      description: 'The private draft is ready.',
      notify_attendees: true,
      status: 'published',
      presenter_name: 'Ignored Presenter'
    })
  });
  assert.equal(updated.status, 200);
  const updatedBody = await updated.json();
  assert.equal(updatedBody.event.status, 'draft');
  assert.equal(updatedBody.notification, null);
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM event_notification_batches WHERE event_id=$1',
    [eventId]
  )).rows[0].count, 0, 'administrator edits never queue attendee notifications');
  const updateAudit = (await pool.query(
    `SELECT before_state,after_state,metadata
       FROM admin_account_audit_log
      WHERE action_type='done_for_you_event_draft_updated'
        AND target_user_id=$1
      ORDER BY id DESC LIMIT 1`,
    [prepared.client.userId]
  )).rows[0];
  assert.deepEqual(updateAudit.metadata.changedFields, ['description', 'title']);
  assert.doesNotMatch(JSON.stringify(updateAudit), /Admin Prepared|private draft/i,
    'immutable audit records field names, not customer event content');

  const published = await fetch(`${baseUrl}/admin-editor/api/events/${eventId}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: editorSession },
    body: '{}'
  });
  assert.equal(published.status, 200);
  const publishedBody = await published.json();
  assert.equal(publishedBody.event.status, 'published');
  assert.equal(publishedBody.alreadyPublished, false);
  assert.equal(publishedBody.redirect, `/admin/done-for-you/${prepared.client.id}`);
  const publishCookies = published.headers.get('set-cookie') || '';
  assert.match(publishCookies, /sge_admin_editor=;/);
  assert.doesNotMatch(publishCookies, /sge_session=/);
  const completed = (await pool.query(
    'SELECT status,closed_at FROM admin_event_editor_workspaces WHERE id=$1',
    [opened.body.workspace.id]
  )).rows[0];
  assert.equal(completed.status, 'completed');
  assert.ok(completed.closed_at);
  const actions = (await pool.query(
    `SELECT action_type FROM admin_account_audit_log
      WHERE target_user_id=$1
        AND action_type IN (
          'done_for_you_event_draft_created',
          'done_for_you_event_draft_updated',
          'done_for_you_event_published',
          'done_for_you_event_workspace_completed'
        )
      ORDER BY id`,
    [prepared.client.userId]
  )).rows.map(row => row.action_type);
  assert.deepEqual(actions, [
    'done_for_you_event_draft_created',
    'done_for_you_event_draft_updated',
    'done_for_you_event_published',
    'done_for_you_event_workspace_completed'
  ]);
  assert.equal((await fetch(`${baseUrl}/admin-editor/api/events/${eventId}`, {
    headers: { cookie: editorSession }
  })).status, 401, 'the completed workspace cannot be replayed');
});

test('Done For You quick-create binds exactly one concurrent draft and event uploads stay scoped', async t => {
  resetRateLimits();
  const operator = await createAdminOperator('stage2-concurrency@example.test', 'super_admin');
  const adminSession = await signInAdminOperator(operator.email);
  const prepared = await createDoneForYouClient(adminSession, {
    hostName: 'Concurrent Editor Host',
    contactName: 'Concurrent Editor Client',
    email: 'concurrent-editor@example.test'
  });
  const opened = await openDoneForYouEditor(adminSession, prepared.client.id);
  const editorSession = cookieHeader(adminSession, opened.editorCookie);

  const unboundUpload = new FormData();
  unboundUpload.set('image', new Blob([Buffer.from('before-bind')], { type: 'image/png' }), 'cover.png');
  assert.equal((await fetch(`${baseUrl}/admin-editor/api/uploads/cover`, {
    method: 'POST', headers: { cookie: editorSession }, body: unboundUpload
  })).status, 409);

  const createBody = {
    title: 'Exactly One Draft',
    event_date: '2034-05-13',
    start_time: '20:00',
    venue_name: 'Concurrency Hall',
    visibility: 'public',
    admission_type: 'free_rsvp'
  };
  const makeRequest = () => fetch(`${baseUrl}/admin-editor/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: editorSession },
    body: JSON.stringify(createBody)
  });
  const concurrent = await Promise.all([makeRequest(), makeRequest()]);
  assert.deepEqual(concurrent.map(response => response.status).sort(), [201, 409]);
  const successful = concurrent.find(response => response.status === 201);
  const eventId = Number((await successful.json()).event.id);
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM events
      WHERE organizer_id=$1 AND title='Exactly One Draft'`,
    [prepared.client.organizerId]
  )).rows[0].count, 1);
  assert.equal(Number((await pool.query(
    'SELECT event_id FROM admin_event_editor_workspaces WHERE id=$1',
    [opened.body.workspace.id]
  )).rows[0].event_id), eventId);

  const coverUrl = 'https://res.cloudinary.com/integration-cloud/image/upload/v1/sg-events-dev/covers/admin-editor.png';
  adminEditorRoutes.setEventUploadsForTests({
    configured: true,
    cover: async () => ({ secure_url: coverUrl, colors: [['#20c7c7', 1]] })
  });
  t.after(() => adminEditorRoutes.setEventUploadsForTests({ configured: false }));
  const coverUpload = new FormData();
  coverUpload.set('image', new Blob([Buffer.from('after-bind')], { type: 'image/png' }), 'cover.png');
  const uploaded = await fetch(`${baseUrl}/admin-editor/api/uploads/cover`, {
    method: 'POST', headers: { cookie: editorSession }, body: coverUpload
  });
  assert.equal(uploaded.status, 200);
  assert.equal((await uploaded.json()).url, coverUrl);
  assert.equal((await pool.query(
    'SELECT cover_image_url FROM events WHERE id=$1',
    [eventId]
  )).rows[0].cover_image_url, null,
  'uploading returns a managed candidate URL but cannot mutate another field or event');
});

test('Done For You publish validation rolls back the event, audit, workspace, and cookie together', async () => {
  resetRateLimits();
  const operator = await createAdminOperator('stage2-rollback@example.test', 'support');
  const adminSession = await signInAdminOperator(operator.email);
  const prepared = await createDoneForYouClient(adminSession, {
    hostName: 'Rollback Editor Host',
    contactName: 'Rollback Editor Client',
    email: 'rollback-editor@example.test'
  });
  const draft = (await pool.query(
    `INSERT INTO events
       (organizer_id,slug,title,event_date,start_time,venue_name,visibility,status)
     VALUES ($1,'stage2-invalid-draft','','2035-06-14','18:00','Rollback Hall','private','draft')
     RETURNING id`,
    [prepared.client.organizerId]
  )).rows[0];
  const opened = await openDoneForYouEditor(adminSession, prepared.client.id, draft.id);
  const editorSession = cookieHeader(adminSession, opened.editorCookie);
  const failed = await fetch(`${baseUrl}/admin-editor/api/events/${draft.id}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: editorSession },
    body: '{}'
  });
  assert.equal(failed.status, 400);
  assert.equal((await failed.json()).error, 'event_incomplete');
  assert.doesNotMatch(failed.headers.get('set-cookie') || '', /sge_admin_editor=;/,
    'a failed publish keeps the editor grant available for correction');
  assert.equal((await pool.query(
    'SELECT status FROM events WHERE id=$1', [draft.id]
  )).rows[0].status, 'draft');
  assert.equal((await pool.query(
    'SELECT status FROM admin_event_editor_workspaces WHERE id=$1',
    [opened.body.workspace.id]
  )).rows[0].status, 'active');
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM admin_account_audit_log
      WHERE target_user_id=$1 AND action_type='done_for_you_event_published'`,
    [prepared.client.userId]
  )).rows[0].count, 0);

  await pool.query(
    `UPDATE users SET account_status='suspended',suspended_at=NOW(),
                      suspension_reason='Stage 2 scope test'
      WHERE id=$1`,
    [prepared.client.userId]
  );
  const suspendedEdit = await fetch(`${baseUrl}/admin-editor/api/events/${draft.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: editorSession },
    body: JSON.stringify({ title: 'Must not be written' })
  });
  assert.equal(suspendedEdit.status, 403);
  assert.equal((await pool.query(
    'SELECT title FROM events WHERE id=$1', [draft.id]
  )).rows[0].title, '');
});

test('Done For You event mutation serializes behind permanent account deletion', async () => {
  resetRateLimits();
  const operator = await createAdminOperator('stage2-delete-race@example.test', 'super_admin');
  const adminSession = await signInAdminOperator(operator.email);
  const prepared = await createDoneForYouClient(adminSession, {
    hostName: 'Delete Race Editor Host',
    contactName: 'Delete Race Editor Client',
    email: 'delete-race-editor@example.test'
  });
  const draft = (await pool.query(
    `INSERT INTO events
       (organizer_id,slug,title,event_date,start_time,venue_name,visibility,status)
     VALUES ($1,'stage2-delete-race','Delete Race Draft','2036-07-15','19:00',
             'Delete Race Hall','private','draft')
     RETURNING id`,
    [prepared.client.organizerId]
  )).rows[0];
  const opened = await openDoneForYouEditor(adminSession, prepared.client.id, draft.id);
  const editorSession = cookieHeader(adminSession, opened.editorCookie);
  const deletionCookie = await adminDeletionProof(adminSession, prepared.client.userId);

  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [prepared.client.userId]);
  try {
    const deletion = fetch(`${baseUrl}/api/admin/accounts/${prepared.client.userId}/delete-account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: deletionCookie },
      body: JSON.stringify({
        reason: 'Verify scoped editor deletion serialization',
        confirmation: `DELETE USER ${prepared.client.userId}`
      })
    });
    await waitUntilOutboundLockHeld(prepared.client.userId);
    let updateSettled = false;
    const update = fetch(`${baseUrl}/admin-editor/api/events/${draft.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: editorSession },
      body: JSON.stringify({ title: 'Must Never Survive Deletion' })
    }).then(response => {
      updateSettled = true;
      return response;
    });
    let exitSettled = false;
    const exit = fetch(`${baseUrl}/admin-editor/api/workspace/exit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: editorSession },
      body: '{}'
    }).then(response => {
      exitSettled = true;
      return response;
    });
    let logoutSettled = false;
    const logout = fetch(`${baseUrl}/api/admin/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminSession },
      body: '{}'
    }).then(response => {
      logoutSettled = true;
      return response;
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(updateSettled, false,
      'the editor mutation waits behind the same outbound-account deletion boundary');
    assert.equal(exitSettled, false,
      'workspace exit does not hold the operator row while waiting behind account deletion');
    assert.equal(logoutSettled, false,
      'operator logout discovers workspace targets before taking its operator row');
    await blocker.query('COMMIT');
    const [deleted, attemptedUpdate, attemptedExit, attemptedLogout] = await Promise.all([
      deletion, update, exit, logout
    ]);
    assert.equal(deleted.status, 200);
    assert.ok([401, 403, 409].includes(attemptedUpdate.status),
      `the editor mutation safely loses the delete/logout race without a server error (${attemptedUpdate.status})`);
    assert.ok([401, 403, 409].includes(attemptedExit.status),
      `workspace exit safely loses the delete race without a server error (${attemptedExit.status})`);
    assert.equal(attemptedLogout.status, 200,
      'operator logout safely completes after the target account deletion');
    assert.equal((await pool.query(
      'SELECT account_status FROM users WHERE id=$1', [prepared.client.userId]
    )).rows[0].account_status, 'deleted');
    assert.equal((await pool.query(
      'SELECT COUNT(*)::int AS count FROM events WHERE id=$1', [draft.id]
    )).rows[0].count, 0);
    assert.equal((await pool.query(
      `SELECT COUNT(*)::int AS count FROM admin_account_audit_log
        WHERE target_user_id=$1
          AND action_type='done_for_you_event_draft_updated'
          AND metadata->'changedFields' ? 'title'`,
      [prepared.client.userId]
    )).rows[0].count, 0,
    'the losing editor request neither writes nor audits a post-delete change');
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
  }
});
