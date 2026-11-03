'use strict';

// Registered by public-flows.test.js so these cases share its guarded sge_test
// connection, reset hooks and serial background-work drain. Do not make this a
// standalone .test.js: parallel files would truncate each other's SQL fixtures.
module.exports = function registerContributorCases(h) {
  const { test, assert, pool, mailer } = h;
  const APPROVAL_VERSION = 'contributor-spotlight-v1';
  const FOLLOW_VERSION = 'contributor-follow-v1';
  const invitePath = eventId => `/api/events/${eventId}/contributors`;
  const intakePath = token => `/api/contributors/intake/${token}`;
  const profilePath = slug => `/api/people/${slug}`;
  const count = async (table, where = 'TRUE', params = []) => Number((await pool.query(
    `SELECT COUNT(*)::int AS count FROM ${table} WHERE ${where}`, params
  )).rows[0].count);

  async function request(path, { cookie = '', method = 'GET', body, headers = {} } = {}) {
    return fetch(`${h.baseUrl}${path}`, {
      method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  }

  function cookieFrom(response, name = 'sge_session') {
    const match = (response.headers.get('set-cookie') || '').match(new RegExp(`(?:^|[,;]\\s*)${name}=([^;,]+)`));
    return match ? `${name}=${match[1]}` : '';
  }

  function slugFrom(url) {
    return new URL(url, h.baseUrl).pathname.split('/').filter(Boolean).at(-1);
  }

  function contributorApiPath(contributor, suffix = '') {
    const url = new URL(contributor.profileUrl, h.baseUrl);
    return `${profilePath(contributor.slug)}${suffix}${url.search}`;
  }

  async function fixture(overrides = {}) {
    const current = await h.postEventFixture(overrides);
    await pool.query("UPDATE organizers SET org_name='Heat Wave Booking',name='Private Account Name' WHERE id=$1", [h.organizerId]);
    mailer.devOutbox.length = 0;
    return current;
  }

  async function invite(current, { email = 'contributor@example.test', name = 'Night Artist', role = 'DJ', ...extra } = {}) {
    const response = await request(invitePath(current.event.id), {
      cookie: current.cookie, method: 'POST', body: { name, email, role, ...extra }
    });
    assert.equal(response.status, 201, await response.clone().text());
    const body = await response.json();
    assert.ok(body.contributor?.id);
    const invitation = h.lastDevEmail(email.trim().toLowerCase(), 'contributor_invitation');
    assert.ok(invitation.link, 'only the invited mailbox receives the intake bearer link');
    return { ...body.contributor, invitation, token: slugFrom(invitation.link), ownerBody: body };
  }

  async function approve(contributor, changes = {}) {
    const response = await request(intakePath(contributor.token), {
      method: 'POST', body: {
        approval: true, approvalVersion: APPROVAL_VERSION,
        name: 'Night Artist', email: contributor.email, role: 'DJ', instagram_handle: 'night.artist',
        website_url: 'https://example.test/artist', ...changes
      }
    });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.approved, true);
    assert.ok(body.profileUrl);
    return { ...contributor, ...body, slug: slugFrom(body.profileUrl) };
  }

  async function claim(contributor) {
    const claimEmail = h.lastDevEmail(contributor.email, 'contributor_claim');
    const signedIn = await h.followSignInLink(claimEmail.link);
    assert.ok([302, 303].includes(signedIn.status));
    const cookie = cookieFrom(signedIn);
    assert.ok(cookie, 'claim uses an existing verified-email authentication session');
    const response = await request(`/api/contributors/claim/${contributor.id}`, { cookie, method: 'POST', body: {} });
    assert.equal(response.status, 200, await response.clone().text());
    return { body: await response.json(), cookie };
  }

  async function follow(contributor, cookie, body = { emailConsent: true, consentVersion: FOLLOW_VERSION }) {
    return request(contributorApiPath(contributor, '/follow'), { cookie, method: 'POST', body });
  }

  async function legacySpotlightRender(current, draft) {
    const { loadPostEventContext, emailRenderSnapshot } = require('../../src/lib/post-event');
    const { loadApprovedContributorSpotlights } = require('../../src/lib/contributors');
    const context = await loadPostEventContext(pool, { eventId: current.event.id, organizerId: h.organizerId });
    const contributors = await loadApprovedContributorSpotlights(pool, { eventId: current.event.id, organizerId: h.organizerId });
    const snapshot = emailRenderSnapshot(context.event, context.host, { thankYouVersion: 3, contributors });
    const rendered = require('../../src/lib/mailer').buildPostEventThankYouEmail({
      event: snapshot.event, host: snapshot.host, ...draft, templateVersion: 3,
      contributors: snapshot.contributors, consentScope: 'event_rsvp'
    });
    return { ...rendered, snapshot };
  }

  async function seedLegacySpotlightBatch(current, rsvp, draft) {
    const rendered = await legacySpotlightRender(current, draft);
    const { renderSnapshotDigest } = require('../../src/lib/post-event');
    const batch = (await pool.query(`INSERT INTO post_event_thank_you_batches(event_id,organizer_id,subject,message,
      include_follow,status,recipient_count,approved_by_user_id,approved_at,render_snapshot,render_snapshot_hash)
      VALUES($1,$2,$3,$4,TRUE,'pending',1,$2,NOW(),$5::jsonb,$6) RETURNING id`,
    [current.event.id, h.organizerId, draft.subject, draft.message, JSON.stringify(rendered.snapshot), renderSnapshotDigest(rendered.snapshot)])).rows[0];
    await pool.query(`INSERT INTO message_log(rsvp_id,event_id,post_event_thank_you_batch_id,recipient,message_type,
      channel,status,post_event_already_following,post_event_consent_scope)
      VALUES($1,$2,$3,$4,'post_event_thank_you','email','pending',FALSE,'event_rsvp')`,
    [rsvp.id, current.event.id, batch.id, rsvp.email]);
    return { ...rendered, batch };
  }

  test('contributor invitations are owner-only, ended-event-only and use saved public host branding', async () => {
    const current = await fixture();
    const outsider = await h.signInAccount('outside-contributor-host@example.test');
    assert.equal((await request(invitePath(current.event.id))).status, 401);
    assert.equal((await request(invitePath(current.event.id), { cookie: outsider.sessionCookie })).status, 404);
    assert.equal((await request(invitePath(current.event.id), {
      cookie: outsider.sessionCookie, method: 'POST', body: { name: 'No', email: 'no@example.test', role: 'DJ', organizerId: h.organizerId }
    })).status, 404);
    const contributor = await invite(current);
    assert.equal((await request(`${invitePath(current.event.id)}/${contributor.id}`, {
      cookie: outsider.sessionCookie, method: 'PATCH', body: { selected: false, organizerId: h.organizerId }
    })).status, 404);
    assert.equal(contributor.email, 'contributor@example.test');
    assert.equal(contributor.ownerBody.intakeUrl, undefined, 'host cannot use the contributor approval bearer link');
    assert.equal(contributor.ownerBody.claimUrl, undefined);
    assert.equal(contributor.ownerBody.contributor.token, undefined);
    const mail = mailer.devOutbox.find(message => message.to === contributor.email && message.html?.includes('Heat Wave Booking'));
    assert.ok(mail, 'the actual rendered invitation uses the public Host Page name');
    assert.doesNotMatch(mail.html, /Private Account Name|Adrian Martinez|9876 Private Address/);
    const future = await h.createEvent({ slug: 'future-contributors', event_date: '2099-08-10' });
    assert.equal((await request(invitePath(future.id), {
      cookie: current.cookie, method: 'POST', body: { name: 'Future', role: 'DJ', email: 'future@example.test' }
    })).status, 409);
    assert.equal(await count('event_contributors'), 1);
  });

  test('contributor invitation cap and normalized-mailbox duplicate protection hold under concurrent creation', async () => {
    const current = await fixture();
    await invite(current, { email: 'one-contributor@example.test', name: 'One' });
    const duplicate = await request(invitePath(current.event.id), {
      cookie: current.cookie, method: 'POST', body: { name: 'Other name', role: 'Photo', email: ' ONE-CONTRIBUTOR@example.test ' }
    });
    assert.equal(duplicate.status, 201, 'repeated invitation returns the existing record rather than creating or sending again');
    assert.equal(await count('event_contributors'), 1);
    assert.equal(mailer.devOutbox.filter(message => message.to === 'one-contributor@example.test' && message.kind === 'contributor_invitation').length, 1);
    const attempts = await Promise.all(['two', 'three', 'four', 'five'].map(name => request(invitePath(current.event.id), {
      cookie: current.cookie, method: 'POST', body: { name, role: 'Contributor', email: `${name}-contributor@example.test` }
    })));
    assert.equal(attempts.filter(response => response.status === 201).length, 2);
    assert.ok(attempts.every(response => [201, 400, 409].includes(response.status)));
    assert.equal(await count('event_contributors', "status<>'revoked'"), 3);
    assert.equal(await count('contributor_follow_intents'), 0);
  });

  test('opening an invitation is read-only, token-scoped and does not reveal an unapproved public page', async () => {
    const current = await fixture();
    const contributor = await invite(current);
    const row = (await pool.query('SELECT token_hash,invitation_payload,status,approved_at,profile_id FROM event_contributors WHERE id=$1', [contributor.id])).rows[0];
    assert.notEqual(row.token_hash, contributor.token);
    assert.equal(row.invitation_payload.includes(contributor.token), false, 'delivery payload is encrypted at rest');
    const slug = (await pool.query('SELECT slug FROM contributor_profiles WHERE id=$1', [row.profile_id])).rows[0].slug;
    const before = mailer.devOutbox.length;
    for (let times = 0; times < 2; times += 1) {
      const read = await request(intakePath(contributor.token));
      assert.equal(read.status, 200);
      assert.match(read.headers.get('cache-control') || '', /no-store/);
    }
    assert.equal((await request(profilePath(slug))).status, 404);
    assert.equal((await pool.query('SELECT status,approved_at FROM event_contributors WHERE id=$1', [contributor.id])).rows[0].status, 'invited');
    assert.equal(mailer.devOutbox.length, before, 'mail scanners do not claim, approve or send anything');
    assert.equal(await count('host_follows'), 0);
  });

  test('spotlight approval is positive and versioned, scoped to the invited email and not vulnerable to cross-origin POST', async () => {
    const current = await fixture();
    const contributor = await invite(current);
    const invalid = [
      { approval: false, approvalVersion: APPROVAL_VERSION, name: 'No approval', role: 'DJ' },
      { approval: true, approvalVersion: 'old-disclosure', name: 'Old approval', role: 'DJ' }
    ];
    for (const body of invalid) assert.ok([400, 409].includes((await request(intakePath(contributor.token), { method: 'POST', body })).status));
    assert.equal((await request(intakePath(contributor.token), {
      method: 'POST', body: { approval: true, approvalVersion: APPROVAL_VERSION, name: 'Artist', role: 'DJ' },
      headers: { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' }
    })).status, 403);
    const attackerEmail = await request(intakePath(contributor.token), {
      method: 'POST', body: { approval: true, approvalVersion: APPROVAL_VERSION, name: 'Artist', role: 'DJ', email: 'takeover@example.test' }
    });
    assert.ok([400, 409].includes(attackerEmail.status));
    const approved = await approve(contributor, { photo_url: 'https://attacker.example/forged-avatar.jpg' });
    const saved = (await pool.query('SELECT status,approval_version,approved_at,email FROM event_contributors WHERE id=$1', [contributor.id])).rows[0];
    assert.equal(saved.status, 'approved');
    assert.equal(saved.approval_version, APPROVAL_VERSION);
    assert.ok(saved.approved_at);
    assert.equal(saved.email, contributor.email);
    assert.equal((await pool.query('SELECT photo_url FROM event_contributors WHERE id=$1', [contributor.id])).rows[0].photo_url, null,
      'only the scoped validated image-upload endpoint may assign an image, not a supplied URL');
    const publicResponse = await request(contributorApiPath(approved));
    assert.equal(publicResponse.status, 200);
    const publicText = await publicResponse.text();
    assert.doesNotMatch(publicText, /contributor@example\.test|9876 Private Address|post-event-night|token_hash|owner_user_id|follower_user_id/);
    assert.match(publicText, /Night Artist/);
    assert.equal(await count('host_follows'), 0, 'approval itself never enrolls attendees or follows');
    assert.equal((await pool.query('SELECT owner_user_id FROM contributor_profiles WHERE slug=$1', [approved.slug])).rows[0].owner_user_id, null);
  });

  test('expired and revoked invitations fail closed without consuming an unrelated invitation', async () => {
    const current = await fixture();
    const expired = await invite(current, { email: 'expired-contributor@example.test' });
    const revoked = await invite(current, { email: 'revoked-contributor@example.test' });
    await pool.query("UPDATE event_contributors SET token_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [expired.id]);
    const removed = await request(`${invitePath(current.event.id)}/${revoked.id}`, {
      cookie: current.cookie, method: 'PATCH', body: { revoked: true }
    });
    assert.equal(removed.status, 200, await removed.clone().text());
    for (const contributor of [expired, revoked]) {
      assert.ok([404, 410].includes((await request(intakePath(contributor.token))).status));
      const response = await request(intakePath(contributor.token), {
        method: 'POST', body: { approval: true, approvalVersion: APPROVAL_VERSION, name: 'Not allowed', email: contributor.email, role: 'DJ' }
      });
      assert.ok([404, 410].includes(response.status), await response.clone().text());
    }
    assert.equal((await request(intakePath('not-a-real-invitation'))).status, 404);
    assert.equal(await count('event_contributors', "status='approved'"), 0);
    assert.equal(mailer.devOutbox.filter(message => message.kind === 'contributor_claim').length, 0);
  });

  test('scoped contributor photo uploads authorize first, decode image bytes and never change the host avatar', async () => {
    const current = await fixture();
    const contributor = await invite(current);
    const cloudinary = require('../../src/lib/cloudinary');
    const original = { configured: cloudinary.configured, uploadVibePhoto: cloudinary.uploadVibePhoto };
    const managedUrl = 'https://res.cloudinary.com/integration-cloud/image/upload/v1/sg-events-dev/vibes/contributor-test.webp';
    const uploads = [];
    const logoBefore = (await pool.query('SELECT logo_url FROM organizers WHERE id=$1', [h.organizerId])).rows[0].logo_url;
    cloudinary.configured = true;
    cloudinary.uploadVibePhoto = async buffer => { uploads.push(buffer); return { secure_url: managedUrl }; };
    const form = bytes => {
      const body = new FormData();
      body.append('image', new Blob([bytes], { type: 'image/png' }), 'artist.png');
      return body;
    };
    const post = (token, bytes) => fetch(`${h.baseUrl}${intakePath(token)}/photo`, { method: 'POST', body: form(bytes) });
    try {
      assert.equal((await post('invalid-bearer', Buffer.from('not an image'))).status, 404);
      assert.equal((await post(contributor.token, Buffer.from('not an image'))).status, 400);
      assert.equal(uploads.length, 0, 'invalid authorization and spoofed image bytes never reach storage');
      const { PNG } = require('pngjs');
      const image = new PNG({ width: 4, height: 4 });
      image.data.fill(180);
      const saved = await post(contributor.token, PNG.sync.write(image));
      assert.equal(saved.status, 200, await saved.clone().text());
      assert.equal((await saved.json()).photoUrl, managedUrl);
      assert.equal(uploads.length, 1);
      assert.equal(uploads[0].toString('ascii', 8, 12), 'WEBP', 'storage receives normalized bytes, not the submitted file');
      assert.equal((await pool.query('SELECT photo_url FROM event_contributors WHERE id=$1', [contributor.id])).rows[0].photo_url, managedUrl);
      await approve(contributor);
      assert.equal((await post(contributor.token, PNG.sync.write(image))).status, 409, 'approved spotlights freeze photo content');
      assert.equal(uploads.length, 1);
      assert.equal((await pool.query('SELECT logo_url FROM organizers WHERE id=$1', [h.organizerId])).rows[0].logo_url, logoBefore);
    } finally {
      cloudinary.configured = original.configured;
      cloudinary.uploadVibePhoto = original.uploadVibePhoto;
    }
  });

  test('legacy v3 render snapshots include only selected approved people and preserve private event boundaries', async () => {
    const current = await fixture();
    const approved = await approve(await invite(current, { email: 'approved-spotlight@example.test', name: 'Approved Artist' }), { name: 'Approved Artist' });
    await invite(current, { email: 'pending-spotlight@example.test', name: 'Unapproved Artist' });
    await h.createRsvp(current.event.id, { email: 'thankyou-spotlight-guest@example.test' });
    const before = mailer.devOutbox.length;
    const draft = { subject: 'Thanks for our night', message: 'Thanks for making this night special.', includeFollow: true };
    const preview = await legacySpotlightRender(current, draft);
    assert.match(preview.html, /The people who made the night|people who made the night/);
    assert.match(preview.html, /Meet Approved Artist/);
    assert.match(preview.html, /Follow my page/);
    assert.doesNotMatch(preview.html, /Unapproved Artist|9876 Private Address|approved-spotlight@example\.test|pending-spotlight@example\.test|\/e\/post-event-night/);
    assert.equal(mailer.devOutbox.length, before, 'previewing never sends invitations or guest emails');
    const deselected = await request(`${invitePath(current.event.id)}/${approved.id}`, {
      cookie: current.cookie, method: 'PATCH', body: { selected: false }
    });
    assert.equal(deselected.status, 200);
    const nextPreview = await legacySpotlightRender(current, draft);
    assert.doesNotMatch(nextPreview.html, /Meet Approved Artist/);
    const { renderSnapshotDigest } = require('../../src/lib/post-event');
    assert.notEqual(renderSnapshotDigest(preview.snapshot), renderSnapshotDigest(nextPreview.snapshot),
      'selection revisions still change the legacy frozen render binding');
  });

  test('an already-approved legacy v3 thank-you retains spotlights and late approval cannot send another guest email', async () => {
    const current = await fixture();
    const approved = await approve(await invite(current, { email: 'frozen-spotlight@example.test' }));
    const late = await invite(current, { email: 'late-spotlight@example.test', name: 'Late Artist' });
    const rsvp = await h.createRsvp(current.event.id, { email: 'frozen-guest@example.test' });
    const draft = { subject: 'Thank you for our night', message: 'Lovely to see everyone.', includeFollow: true };
    const { batch } = await seedLegacySpotlightBatch(current, rsvp, draft);
    const worker = require('../../src/jobs/post-event-thank-yous');
    await worker.processPostEventThankYouBatch(batch.id);
    const sent = h.lastDevEmail('frozen-guest@example.test');
    assert.match(sent.html, /Meet Night Artist/);
    assert.doesNotMatch(sent.html, /Late Artist/);
    const sentCount = mailer.devOutbox.filter(message => message.to === 'frozen-guest@example.test' && message.html).length;
    assert.equal((await request(`${invitePath(current.event.id)}/${approved.id}`, { cookie: current.cookie, method: 'PATCH', body: { selected: false } })).status, 409);
    assert.equal((await request(invitePath(current.event.id), {
      cookie: current.cookie, method: 'POST', body: { name: 'Too late', email: 'after-approved@example.test', role: 'DJ' }
    })).status, 409);
    await approve(late, { name: 'Late Artist' });
    await worker.processPostEventThankYouBatch(batch.id);
    assert.equal(mailer.devOutbox.filter(message => message.to === 'frozen-guest@example.test' && message.html).length, sentCount);
    assert.equal((await h.postEventRequest(current.event.id, current.cookie, '/thank-you', 'PUT', draft)).status, 409,
      'a completed legacy note cannot be converted to the new credit editor or reopened');
  });

  test('a contributor may withdraw after batch approval and the worker suppresses the frozen unsent spotlight', async () => {
    const current = await fixture();
    const contributor = await approve(await invite(current));
    const rsvp = await h.createRsvp(current.event.id, { email: 'withdrawn-spotlight-guest@example.test' });
    const draft = { subject: 'Thanks for the night', message: 'It was lovely to be together.', includeFollow: true };
    await h.previewPostEventDraft(current.event.id, current.cookie, draft);
    const { loadPostEventContext, emailRenderSnapshot, renderSnapshotDigest } = require('../../src/lib/post-event');
    const { loadApprovedContributorSpotlights } = require('../../src/lib/contributors');
    const context = await loadPostEventContext(pool, { eventId: current.event.id, organizerId: h.organizerId });
    const contributors = await loadApprovedContributorSpotlights(pool, { eventId: current.event.id, organizerId: h.organizerId });
    const snapshot = emailRenderSnapshot(context.event, context.host, { thankYouVersion: 3, contributors });
    const batch = (await pool.query(`UPDATE post_event_thank_you_batches SET status='pending',approved_at=NOW(),
      approved_by_user_id=$2,recipient_count=1,render_snapshot=$3::jsonb,render_snapshot_hash=$4 WHERE event_id=$1 RETURNING id`,
    [current.event.id, h.organizerId, JSON.stringify(snapshot), renderSnapshotDigest(snapshot)])).rows[0];
    await pool.query(`INSERT INTO message_log(rsvp_id,event_id,post_event_thank_you_batch_id,recipient,message_type,
      channel,status,post_event_already_following,post_event_consent_scope)
      VALUES($1,$2,$3,$4,'post_event_thank_you','email','pending',FALSE,'event_rsvp')`,
    [rsvp.id, current.event.id, batch.id, rsvp.email]);
    assert.equal((await request(intakePath(contributor.token), { method: 'DELETE' })).status, 200);
    await require('../../src/jobs/post-event-thank-yous').processPostEventThankYouBatch(batch.id);
    const log = (await pool.query('SELECT status,error FROM message_log WHERE post_event_thank_you_batch_id=$1', [batch.id])).rows[0];
    assert.equal(log.status, 'failed');
    assert.equal(log.error, 'recipient_suppressed');
    assert.equal(mailer.devOutbox.filter(message => message.to === rsvp.email).length, 0,
      'the immutable provider payload is not rewritten or delivered with withdrawn approval');
  });

  test('a contributor follow is explicit, versioned and pending until verified claim; no original guest list is copied', async () => {
    const current = await fixture();
    const contributor = await approve(await invite(current));
    await h.createRsvp(current.event.id, { email: 'unselected-original-guest@example.test' });
    assert.equal((await follow(contributor, '')).status, 401);
    const follower = await h.signInAccount('chosen-follower@example.test');
    assert.ok([400, 409].includes((await follow(contributor, follower.sessionCookie, { emailConsent: false, consentVersion: FOLLOW_VERSION })).status));
    assert.ok([400, 409].includes((await follow(contributor, follower.sessionCookie, { emailConsent: true, consentVersion: 'old-follow-copy' })).status));
    const followed = await follow(contributor, follower.sessionCookie);
    assert.equal(followed.status, 200, await followed.clone().text());
    assert.equal(await count('contributor_follow_intents', 'withdrawn_at IS NULL'), 1);
    assert.equal(await count('host_follows'), 0, 'unclaimed contributors cannot send promotions');
    assert.equal((await follow(contributor, follower.sessionCookie)).status, 200);
    assert.equal(await count('contributor_follow_intents'), 1, 'repeated clicks preserve one person per page');
    const signedInView = await (await request(contributorApiPath(contributor), { cookie: follower.sessionCookie })).json();
    assert.equal(signedInView.pending, true);
    const claimed = await claim(contributor);
    assert.ok(claimed.body.profileUrl);
    assert.equal(claimed.body.followersCount, 1);
    assert.equal(await count('host_follows'), 1);
    assert.equal(await count('host_follows', "follower_organizer_id IN (SELECT id FROM organizers WHERE email='unselected-original-guest@example.test')"), 0);
    assert.equal(mailer.devOutbox.filter(message => message.to === 'unselected-original-guest@example.test').length, 0);
  });

  test('withdrawing a pending follow before claim cannot be reversed by claiming the contributor page', async () => {
    const current = await fixture();
    const contributor = await approve(await invite(current));
    const follower = await h.signInAccount('withdrawn-follower@example.test');
    assert.equal((await follow(contributor, follower.sessionCookie)).status, 200);
    const removed = await request(contributorApiPath(contributor, '/follow'), { cookie: follower.sessionCookie, method: 'DELETE' });
    assert.ok([200, 204].includes(removed.status));
    const claimed = await claim(contributor);
    assert.equal(claimed.body.followersCount, 0);
    assert.equal(await count('host_follows', 'unsubscribed_at IS NULL'), 0);
    assert.equal(await count('contributor_follow_intents', 'withdrawn_at IS NOT NULL'), 1);
  });

  test('a valid account session without verified email proof cannot follow or claim a contributor page', async () => {
    const current = await fixture();
    const email = 'unverified-contributor@example.test';
    const unverified = await h.postEventGuest(current.event.id, email, { verified: false });
    const cookie = `sge_session=${require('../../src/lib/session').signSession(unverified.accountId)}`;
    const contributor = await approve(await invite(current, { email }));
    assert.equal((await follow(contributor, cookie)).status, 403);
    assert.equal((await request(`/api/contributors/claim/${contributor.id}`, { cookie })).status, 403);
    assert.equal((await request(`/api/contributors/claim/${contributor.id}`, { cookie, method: 'POST', body: { email, verified: true } })).status, 403);
    assert.equal(await count('contributor_follow_intents'), 0);
    assert.equal((await pool.query('SELECT owner_user_id FROM contributor_profiles WHERE slug=$1', [contributor.slug])).rows[0].owner_user_id, null);
    const verified = await h.signInAccount(email);
    const claimed = await request(`/api/contributors/claim/${contributor.id}`, { cookie: verified.sessionCookie, method: 'POST', body: {} });
    assert.equal(claimed.status, 200, await claimed.clone().text());
    assert.equal((await pool.query('SELECT owner_user_id FROM contributor_profiles WHERE slug=$1', [contributor.slug])).rows[0].owner_user_id, unverified.userId);
  });

  test('revoked follower email proof is rechecked during claim and cannot inflate the activated audience', async () => {
    const current = await fixture();
    const contributor = await approve(await invite(current));
    const follower = await h.signInAccount('revoked-proof-follower@example.test');
    assert.equal((await follow(contributor, follower.sessionCookie)).status, 200);
    const account = (await pool.query("SELECT id,user_id FROM organizers WHERE email='revoked-proof-follower@example.test'")).rows[0];
    await pool.query("UPDATE user_identities SET revoked_at=NOW() WHERE user_id=$1 AND identity_type='email'", [account.user_id]);
    const claimed = await claim(contributor);
    assert.equal(claimed.body.followersCount, 0);
    assert.equal(await count('host_follows'), 0);
    assert.equal(await count('contributor_follow_intents', 'activated_at IS NOT NULL'), 0);
  });

  test('claim requires exact verified session ownership rather than contributor or user ids from the browser', async () => {
    const current = await fixture();
    const contributor = await approve(await invite(current));
    const outsider = await h.signInAccount('not-this-contributor@example.test');
    assert.equal((await request(`/api/contributors/claim/${contributor.id}`, { method: 'POST', body: {} })).status, 401);
    const takeover = await request(`/api/contributors/claim/${contributor.id}`, {
      cookie: outsider.sessionCookie, method: 'POST', body: { email: contributor.email, userId: h.organizerId, organizerId: h.organizerId }
    });
    assert.ok([403, 404].includes(takeover.status));
    assert.equal((await pool.query('SELECT owner_user_id FROM contributor_profiles WHERE slug=$1', [contributor.slug])).rows[0].owner_user_id, null);
    const claimEmail = h.lastDevEmail(contributor.email, 'contributor_claim');
    const scanner = await request(`${new URL(claimEmail.link).pathname}${new URL(claimEmail.link).search}`);
    assert.equal(scanner.status, 200, 'opening a claim email is a read-only auth confirmation page');
    assert.equal((await pool.query('SELECT owner_user_id FROM contributor_profiles WHERE slug=$1', [contributor.slug])).rows[0].owner_user_id, null);
    const claimed = await claim(contributor);
    const again = await request(`/api/contributors/claim/${contributor.id}`, { cookie: claimed.cookie, method: 'POST', body: {} });
    assert.equal(again.status, 200);
    assert.equal(await count('contributor_profiles'), 1);
  });

  test('claim reuses an existing public Host Page without overwriting its branding, avatar, social links or opt-outs', async () => {
    const current = await fixture();
    const existing = await h.signInAccount('existing-contributor@example.test');
    const identity = (await pool.query("SELECT id,user_id FROM organizers WHERE email='existing-contributor@example.test'")).rows[0];
    await pool.query(`UPDATE organizers SET org_name='Existing Artist Brand',public_slug='existing-artist-brand',
      logo_url='https://example.test/existing-logo.jpg',instagram_handle='existing.artist',website_url='https://example.test/existing' WHERE id=$1`, [identity.id]);
    const contributor = await approve(await invite(current, { email: 'existing-contributor@example.test' }), { name: 'Do not overwrite brand', instagram_handle: 'new.instagram' });
    const follower = await h.signInAccount('suppressed-contributor-follower@example.test');
    assert.equal((await follow(contributor, follower.sessionCookie)).status, 200);
    await pool.query("INSERT INTO follower_optouts(organizer_id,email) VALUES ($1,'suppressed-contributor-follower@example.test') ON CONFLICT DO NOTHING", [identity.id]);
    const response = await request(`/api/contributors/claim/${contributor.id}`, { cookie: existing.sessionCookie, method: 'POST', body: {} });
    assert.equal(response.status, 200, await response.clone().text());
    const claimed = await response.json();
    assert.match(claimed.profileUrl, /\/h\/existing-artist-brand$/);
    const brand = (await pool.query('SELECT org_name,public_slug,logo_url,instagram_handle,website_url FROM organizers WHERE id=$1', [identity.id])).rows[0];
    assert.deepEqual(brand, {
      org_name: 'Existing Artist Brand', public_slug: 'existing-artist-brand', logo_url: 'https://example.test/existing-logo.jpg',
      instagram_handle: 'existing.artist', website_url: 'https://example.test/existing'
    });
    assert.equal(await count('follower_optouts', 'organizer_id=$1', [identity.id]), 1);
    assert.equal(await count('host_follows', 'host_organizer_id=$1 AND unsubscribed_at IS NULL', [identity.id]), 0,
      'claim does not re-enable a person who opted out after choosing a pending follow');
    assert.equal(await count('events', 'organizer_id=$1', [identity.id]), 0, 'claiming does not create or announce an event');
  });

  test('claim preserves an existing unsubscribe and independent SMS preferences without requiring an opt-out ledger row', async () => {
    const current = await fixture();
    const artist = await h.signInAccount('unsubscribed-artist@example.test');
    const owner = (await pool.query("SELECT id FROM organizers WHERE email='unsubscribed-artist@example.test'")).rows[0];
    const contributor = await approve(await invite(current, { email: 'unsubscribed-artist@example.test' }));
    const follower = await h.signInAccount('old-unsubscribed-follower@example.test');
    const identity = (await pool.query("SELECT id,user_id FROM organizers WHERE email='old-unsubscribed-follower@example.test'")).rows[0];
    await pool.query(`INSERT INTO host_follows(follower_organizer_id,follower_user_id,host_organizer_id,
      unsubscribed_at,email_opted_in_at,sms_phone,sms_opted_in_at,sms_opted_out_at)
      VALUES($1,$2,$3,'2025-01-01','2024-01-01','+14155550123','2024-01-01','2025-01-01')`,
    [identity.id, identity.user_id, owner.id]);
    const before = (await pool.query('SELECT unsubscribed_at,sms_phone,sms_opted_in_at,sms_opted_out_at FROM host_follows WHERE host_organizer_id=$1', [owner.id])).rows[0];
    assert.equal((await follow(contributor, follower.sessionCookie)).status, 200);
    const response = await request(`/api/contributors/claim/${contributor.id}`, { cookie: artist.sessionCookie, method: 'POST', body: {} });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).followersCount, 0);
    const after = (await pool.query('SELECT unsubscribed_at,sms_phone,sms_opted_in_at,sms_opted_out_at FROM host_follows WHERE host_organizer_id=$1', [owner.id])).rows[0];
    assert.deepEqual(after, before, 'profile ownership cannot silently reverse a withdrawal or touch text preferences');
  });

  test('a claimed contributor can use the existing reviewed follower-announcement audience with exact contributor consent only', async () => {
    const current = await fixture();
    const contributor = await approve(await invite(current));
    const followerEmail = 'future-event-follower@example.test';
    const follower = await h.signInAccount(followerEmail);
    assert.equal((await follow(contributor, follower.sessionCookie)).status, 200);
    await claim(contributor);
    const owner = (await pool.query('SELECT owner_user_id FROM contributor_profiles WHERE slug=$1', [contributor.slug])).rows[0].owner_user_id;
    const followerAccount = (await pool.query('SELECT id,user_id FROM organizers WHERE email=$1', [followerEmail])).rows[0];
    const future = await h.createEvent({ slug: 'claimed-contributor-next-night', event_date: '2099-08-10', visibility: 'public' });
    await pool.query('UPDATE events SET organizer_id=$2 WHERE id=$1', [future.id, owner]);
    future.organizer_id = owner;
    const { eligibleEmailRecipients, makeFollowerAnnouncementPreview } = require('../../src/lib/follow-announcement');
    const { followStatus } = require('../../src/lib/host-follows');
    const eligible = await eligibleEmailRecipients(pool, owner, future.id);
    assert.deepEqual(eligible.map(person => person.email), [followerEmail]);
    const preview = await makeFollowerAnnouncementPreview(pool, future);
    assert.equal(preview.emailCount, 1);
    assert.equal(preview.count, 1);
    assert.equal(preview.textCount, 0, 'email follow never grants SMS permission');
    assert.equal((await followStatus(pool, followerAccount.id, owner)).emailOn, true);

    await h.signInAccount('wrong-consent-source@example.test');
    const wrong = (await pool.query("SELECT id,user_id FROM organizers WHERE email='wrong-consent-source@example.test'")).rows[0];
    await pool.query(`INSERT INTO host_follows(follower_organizer_id,follower_user_id,host_organizer_id,
      email_opted_in_at,email_consent_version,email_consent_source,email_consent_text)
      VALUES($1,$2,$3,NOW(),$4,'unapproved_import','Not a real contributor follow')`, [wrong.id, wrong.user_id, owner, FOLLOW_VERSION]);
    assert.deepEqual((await eligibleEmailRecipients(pool, owner, future.id)).map(person => person.email), [followerEmail],
      'matching version text alone cannot masquerade as the approved contributor follow source');
    assert.equal((await followStatus(pool, wrong.id, owner)).emailOn, false);

    await pool.query('INSERT INTO follower_optouts(organizer_id,email) VALUES($1,$2) ON CONFLICT DO NOTHING', [owner, followerEmail]);
    assert.equal((await eligibleEmailRecipients(pool, owner, future.id)).length, 0);
    assert.equal((await followStatus(pool, followerAccount.id, owner)).emailOn, false);
    assert.equal((await makeFollowerAnnouncementPreview(pool, future)).emailCount, 0);
    assert.equal(await count('message_log', "message_type='announcement'"), 0, 'audience preview never publishes or sends an announcement');
  });

  test('claim shows followers attributed to this introduction, not all introductions of the same person', async () => {
    const current = await fixture();
    const contributor = await approve(await invite(current));
    const otherEvent = await h.createEvent({ slug: 'another-contributor-night', event_date: '2020-10-01' });
    const another = await approve(await invite({ ...current, event: otherEvent }));
    assert.equal(another.slug, contributor.slug, 'one normalized artist mailbox reuses one prepared profile');
    const intro = new URL(contributor.profileUrl, h.baseUrl).searchParams.get('intro');
    const otherIntro = new URL(another.profileUrl, h.baseUrl).searchParams.get('intro');
    assert.match(intro, /^[a-f0-9]{24}$/);
    assert.match(otherIntro, /^[a-f0-9]{24}$/);
    assert.notEqual(intro, otherIntro, 'each approved introduction carries a distinct public, non-auth attribution reference');
    const first = await h.signInAccount('this-night-follower@example.test');
    const second = await h.signInAccount('other-night-follower@example.test');
    const direct = await h.signInAccount('direct-page-follower@example.test');
    assert.equal((await follow(contributor, first.sessionCookie)).status, 200);
    assert.equal((await follow(another, second.sessionCookie)).status, 200);
    assert.equal((await follow({ ...contributor, profileUrl: `/people/${contributor.slug}` }, direct.sessionCookie)).status, 200);
    const origins = (await pool.query(`SELECT o.email,i.source_event_id FROM contributor_follow_intents i
      JOIN organizers o ON o.user_id=i.follower_user_id ORDER BY o.email`)).rows;
    assert.deepEqual(origins, [
      { email: 'direct-page-follower@example.test', source_event_id: null },
      { email: 'other-night-follower@example.test', source_event_id: otherEvent.id },
      { email: 'this-night-follower@example.test', source_event_id: current.event.id }
    ], 'real links determine attribution; a direct visit never invents an event source');
    const claimed = await claim(contributor);
    assert.equal(claimed.body.followersCount, 1, 'per-event onboarding count does not misattribute another night');
    assert.equal(await count('host_follows', 'unsubscribed_at IS NULL'), 3, 'all explicit choices activate without fabricating a source for direct visits');
    const otherContext = await request(`/api/contributors/claim/${another.id}`, { cookie: claimed.cookie });
    assert.equal(otherContext.status, 200);
    assert.equal((await otherContext.json()).followersCount, 1);
  });

  test('public introduction references are scoped attribution only, not approval, account access or a different profile', async () => {
    const current = await fixture();
    const contributor = await approve(await invite(current));
    const other = await approve(await invite(current, { email: 'unrelated-profile@example.test', name: 'Another person' }));
    const ref = new URL(contributor.profileUrl, h.baseUrl).searchParams.get('intro');
    const otherRef = new URL(other.profileUrl, h.baseUrl).searchParams.get('intro');
    assert.equal((await request(`${profilePath(contributor.slug)}?intro=not-a-reference`)).status, 404);
    assert.equal((await request(`${profilePath(contributor.slug)}?intro=${otherRef}`)).status, 404);
    assert.equal((await request(intakePath(ref))).status, 404, 'a public source reference cannot become an intake bearer');
    assert.equal((await request(`/api/contributors/claim/${contributor.id}`, { method: 'POST', body: { intro: ref } })).status, 401);
    const follower = await h.signInAccount('bad-reference-follower@example.test');
    assert.equal((await request(`${profilePath(contributor.slug)}/follow?intro=${otherRef}`, {
      cookie: follower.sessionCookie, method: 'POST', body: { emailConsent: true, consentVersion: FOLLOW_VERSION }
    })).status, 404);
    assert.equal(await count('contributor_follow_intents'), 0);
    assert.equal((await request(intakePath(contributor.token), { method: 'DELETE' })).status, 200);
    assert.equal((await request(`${profilePath(contributor.slug)}?intro=${ref}`)).status, 404);
  });
};
