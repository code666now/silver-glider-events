const test = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/sge_test';
if (!/(?:^|\/)sge_test(?:\?|$)/.test(TEST_DATABASE_URL)) {
  throw new Error('Integration tests require a dedicated sge_test database');
}

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.SESSION_SECRET = 'silver-glider-integration-test-secret';
process.env.APP_URL = 'http://127.0.0.1';
process.env.NODE_ENV = 'development';
process.env.REMINDERS_ENABLED = 'false';
delete process.env.RESEND_API_KEY;

const pool = require('../../src/config/db');
const migrate = require('../../src/db/migrate');
const { app } = require('../../src/index');
const { hashCode } = require('../../src/lib/secret-show');
const { signSession } = require('../../src/lib/session');

let server;
let baseUrl;
let organizerId;

async function resetDatabase() {
  await pool.query('TRUNCATE organizers RESTART IDENTITY CASCADE');
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

test('creates an event only for an authenticated organizer and publishes its page', async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).version, '1.0.18');

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
    presentation_mode: 'standard'
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

  const publicPage = await fetch(`${baseUrl}/e/${payload.event.slug}`);
  assert.equal(publicPage.status, 200);
  assert.match(await publicPage.text(), /Created Through HTTP/);
});

test('serves email-safe adaptive icon PNGs with immutable caching', async () => {
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
  await createEvent();
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
  assert.doesNotMatch(hostHtml, /\{\{[A-Z0-9_]+\}\}/);
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
  assert.match(recapHtml, /From the night/);
  assert.match(recapHtml, /https:\/\/images\.example\/featured\.jpg/);
  assert.doesNotMatch(recapHtml, /private\.jpg|Private Person|Featured Person/);

  const unfeature = await fetch(`${baseUrl}/api/events/${past.id}/photos/${consentedPhoto.id}/feature`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: organizerCookie },
    body: JSON.stringify({ featured: false })
  });
  assert.equal(unfeature.status, 200);
  const recapRemovedHtml = await (await fetch(`${baseUrl}/e/past-photo-night`)).text();
  assert.doesNotMatch(recapRemovedHtml, /From the night|featured\.jpg/);

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
