// Registered only by the isolated sge_test harness. Acceptance tests do not
// dispatch invitations/reminders or run against production accounts.
module.exports = function registerLegalAcceptanceCases({
  test, assert, pool, createEvent, createRsvp, getOrganizerId, getBaseUrl,
  signSession, mailer, lastDevEmail, responseCookie, resetRateLimits,
  attachVerifiedPhoneIdentity
}) {
  const { CURRENT_LEGAL_VERSIONS, REQUIRED_LEGAL_REVIEW_VERSION } = require('../../src/lib/legal-acceptance');
  const { signPhotoAccess } = require('../../src/lib/photo-access');
  const phoneVerification = require('../../src/lib/phone-verification');
  const crypto = require('node:crypto');
  const ownerCookie = (issuedAt) => `sge_session=${signSession(getOrganizerId(), issuedAt)}`;
  const origin = () => getBaseUrl();
  const request = (path, options = {}) => fetch(`${getBaseUrl()}${path}`, { redirect: 'manual', ...options });
  const decode = value => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  async function unaccepted() {
    // Production receipts are append-only. The dedicated test database is
    // reset per case, so truncate only this isolated evidence table.
    await pool.query('TRUNCATE user_legal_acceptances RESTART IDENTITY');
    return ownerCookie();
  }

  async function acceptances(userId = getOrganizerId()) {
    return (await pool.query('SELECT * FROM user_legal_acceptances WHERE user_id=$1 ORDER BY accepted_at', [userId])).rows;
  }

  async function review(cookie, next = '/dashboard') {
    const response = await request(`/account/review?next=${encodeURIComponent(next)}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    const fields = {};
    const acceptanceForm = html.match(/<form\b[^>]*action="\/legal\/accept"[^>]*>[\s\S]*?<\/form>/i)?.[0];
    assert.ok(acceptanceForm);
    for (const tag of acceptanceForm.matchAll(/<input\b[^>]*>/gi)) {
      const attrs = Object.fromEntries([...tag[0].matchAll(/([\w:-]+)="([^"]*)"/g)].map(match => [match[1], decode(match[2])]));
      if (attrs.type === 'hidden' && attrs.name) fields[attrs.name] = attrs.value || '';
    }
    for (const name of ['csrfToken', 'termsVersion', 'privacyVersion', 'wordingVersion', 'next']) {
      assert.ok(Object.hasOwn(fields, name), `review form must include ${name}`);
    }
    return { response, html, fields };
  }

  async function submit(cookie, fields, changes = {}, headers = {}) {
    return request('/legal/accept', {
      method: 'POST',
      headers: { cookie, origin: origin(), 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ ...fields, accepted: 'true', ...changes })
    });
  }

  async function effects() {
    return (await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM message_log) AS messages,
      (SELECT COUNT(*)::int FROM rsvps) AS rsvps,
      (SELECT COUNT(*)::int FROM sms_notification_batches) AS texts,
      (SELECT COUNT(*)::int FROM host_follows) AS host_follows,
      (SELECT COUNT(*)::int FROM email_optins) AS email_optins`)).rows[0];
  }

  async function emailCodeSignIn(next = '/dashboard', email = 'host@example.test') {
    resetRateLimits();
    const started = await request('/api/auth/magic-link', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, next })
    });
    assert.equal(started.status, 200);
    const verified = await request('/api/auth/verify-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: responseCookie(started, 'sge_sign_in') },
      body: JSON.stringify({ code: lastDevEmail(email, 'magic_link').code })
    });
    assert.equal(verified.status, 200);
    return { response: verified, body: await verified.json(), cookie: responseCookie(verified, 'sge_session') };
  }

  test('legal review is explicit, title-free, accessible and read-only before agreement', async () => {
    const cookie = await unaccepted();
    const before = await effects();
    const outboxBefore = mailer.devOutbox.length;
    const { response, html, fields } = await review(cookie, '/events/new?advanced=1');
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(response.headers.get('x-robots-tag'), /noindex/);
    assert.match(html, /Please review/);
    assert.match(html, /Terms of Service/);
    assert.match(html, /Privacy Policy/);
    assert.match(html, /Agree and continue/);
    assert.match(html, /Sign out/);
    assert.doesNotMatch(html, /<h[1-6]\b/i, 'the user explicitly requested no title');
    const checkbox = html.match(/<input\b[^>]*type="checkbox"[^>]*>/i)?.[0];
    assert.ok(checkbox);
    assert.match(checkbox, /name="accepted"/);
    assert.match(checkbox, /\brequired\b/);
    assert.doesNotMatch(checkbox, /\bchecked(?:\s|=|>)/);
    assert.equal(fields.next, '/events/new?advanced=1');
    assert.equal(fields.termsVersion, CURRENT_LEGAL_VERSIONS.terms);
    assert.equal(fields.privacyVersion, CURRENT_LEGAL_VERSIONS.privacy);
    assert.equal(fields.wordingVersion, CURRENT_LEGAL_VERSIONS.wording);
    const links = [...html.matchAll(/<a\b[^>]*>/g)].map(match => match[0]);
    for (const path of ['/terms', '/privacy']) {
      const link = links.find(tag => tag.includes(`href="${path}?version=`));
      assert.ok(link, `review must link to ${path}`);
      assert.match(link, /target="_blank"/);
      assert.match(link, /rel="[^"]*noopener/);
    }
    assert.equal((await acceptances()).length, 0);
    assert.deepEqual(await effects(), before);
    assert.equal(mailer.devOutbox.length, outboxBefore);
  });

  test('legal acceptance rejects unchecked and forged checkbox values without saving', async () => {
    const cookie = await unaccepted();
    const { fields } = await review(cookie);
    for (const accepted of ['', 'false', '0', '1', 'yes', 'on']) {
      const response = await submit(cookie, fields, { accepted });
      assert.equal(response.status, 400, `unchecked/nonliteral ${JSON.stringify(accepted)} must be rejected`);
      assert.equal((await acceptances()).length, 0);
    }
  });

  test('legal acceptance blocks cross-site requests, missing proof, tampered destinations and stale form versions', async () => {
    const cookie = await unaccepted();
    const { fields } = await review(cookie, '/events?view=drafts');
    const before = await effects();
    const invalid = [
      [{ csrfToken: '' }, {}],
      [{ csrfToken: 'tampered' }, {}],
      [{ next: 'https://attacker.invalid/' }, {}],
      [{ termsVersion: '2000-01-01' }, {}],
      [{ privacyVersion: '2000-01-01' }, {}],
      [{ wordingVersion: '2000-01-01' }, {}],
      [{}, { origin: 'https://attacker.invalid', 'sec-fetch-site': 'cross-site' }],
      [{}, { origin: 'https://attacker.invalid' }]
    ];
    for (const [change, headers] of invalid) {
      const response = await submit(cookie, fields, change, headers);
      assert.ok([400, 403, 409].includes(response.status), `invalid review must fail, got ${response.status}`);
      assert.equal((await acceptances()).length, 0);
    }
    assert.deepEqual(await effects(), before);
  });

  test('legal acceptance binds evidence to the signed-in canonical user and preserves policy snapshots', async () => {
    const cookie = await unaccepted();
    const other = (await pool.query("INSERT INTO organizers(email,name) VALUES ('other-legal@example.test','Other') RETURNING id,user_id")).rows[0];
    const next = '/events/new?id=173&advanced=1#vibe';
    const { fields } = await review(cookie, next);
    const before = await effects();
    const outboxBefore = mailer.devOutbox.length;
    const startedAt = Date.now();
    const saved = await submit(cookie, fields, { user_id: other.user_id, accountId: other.id, accepted_at: '2000-01-01' });
    assert.equal(saved.status, 303);
    assert.equal(saved.headers.get('location'), next);
    const rows = await acceptances();
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].user_id), Number(getOrganizerId()));
    assert.equal(rows[0].terms_version, CURRENT_LEGAL_VERSIONS.terms);
    assert.equal(rows[0].privacy_version, CURRENT_LEGAL_VERSIONS.privacy);
    assert.equal(rows[0].wording_version, CURRENT_LEGAL_VERSIONS.wording);
    assert.ok(new Date(rows[0].accepted_at).getTime() >= startedAt - 1000, 'acceptance date is server-recorded, not trusted from the body');
    assert.equal((await acceptances(other.user_id)).length, 0);
    const snapshots = (await pool.query('SELECT * FROM legal_policy_versions')).rows;
    for (const kind of ['terms', 'privacy', 'wording']) {
      const snapshot = snapshots.find(row => row.kind === kind && row.version === CURRENT_LEGAL_VERSIONS[kind]);
      assert.ok(snapshot, `immutable ${kind} version must exist`);
      assert.ok(snapshot.content.length > 30);
      assert.equal(snapshot.content_sha256, crypto.createHash('sha256').update(snapshot.content).digest('hex'));
    }
    assert.deepEqual(await effects(), before);
    assert.equal(mailer.devOutbox.length, outboxBefore, 'agreeing to legal terms does not send messages');
  });

  test('legal acceptance is concurrent-idempotent and does not repeat on another browser or revisit', async () => {
    const cookie = await unaccepted();
    const { fields } = await review(cookie, '/events?view=going');
    const results = await Promise.all(Array.from({ length: 4 }, () => submit(cookie, fields)));
    assert.ok(results.every(response => response.status === 303));
    const first = (await acceptances())[0];
    assert.equal((await acceptances()).length, 1);
    assert.ok(first.accepted_at);
    const secondDevice = ownerCookie(Date.now() + 1000);
    const page = await request('/account/review?next=%2Fevents%3Fview%3Dgoing', { headers: { cookie: secondDevice } });
    assert.equal(page.status, 303);
    assert.equal(page.headers.get('location'), '/events?view=going');
    const app = await request('/dashboard', { headers: { cookie: secondDevice } });
    assert.equal(app.status, 200);
    await submit(cookie, fields);
    const last = (await acceptances())[0];
    assert.equal((await acceptances()).length, 1);
    assert.equal(new Date(last.accepted_at).toISOString(), new Date(first.accepted_at).toISOString());
  });

  test('legal evidence is immutable and an older document version does not by itself repeat first-visit review', async () => {
    const cookie = await unaccepted();
    const older = 'integration-older-reviewed-policy';
    for (const kind of ['terms', 'privacy', 'wording']) {
      const content = `Earlier reviewed ${kind} version, retained as historical acceptance evidence.`;
      await pool.query(`INSERT INTO legal_policy_versions(kind,version,content,content_sha256)
        VALUES($1,$2,$3,$4) ON CONFLICT(kind,version) DO NOTHING`,
      [kind, older, content, crypto.createHash('sha256').update(content).digest('hex')]);
    }
    await pool.query(`INSERT INTO user_legal_acceptances(user_id,review_version,terms_version,privacy_version,wording_version)
      VALUES($1,$2,$3,$3,$3)`, [getOrganizerId(), REQUIRED_LEGAL_REVIEW_VERSION, older]);
    const revisited = await request('/account/review?next=%2Fdashboard', { headers: { cookie } });
    assert.equal(revisited.status, 303);
    assert.equal(revisited.headers.get('location'), '/dashboard');
    const original = (await acceptances())[0];
    await assert.rejects(pool.query('UPDATE user_legal_acceptances SET accepted_at=NOW() WHERE user_id=$1', [getOrganizerId()]), /append-only/);
    await assert.rejects(pool.query('DELETE FROM user_legal_acceptances WHERE user_id=$1', [getOrganizerId()]), /append-only/);
    await assert.rejects(pool.query("UPDATE legal_policy_versions SET content='replacement' WHERE kind='terms' AND version=$1", [older]), /immutable/);
    await assert.rejects(pool.query("DELETE FROM legal_policy_versions WHERE kind='terms' AND version=$1", [older]), /immutable/);
    assert.deepEqual((await acceptances())[0], original);
  });

  test('the Section 10 update preserves the actual November 10 Terms snapshot and existing acceptance receipt', async () => {
    const {
      legalDocumentSnapshots, registerLegalPolicyVersions, recordLegalAcceptance
    } = require('../../src/lib/legal-acceptance');
    const {
      PREVIOUS_TERMS_VERSION, PREVIOUS_TERMS_HASH, CURRENT_TERMS_VERSION,
      ADDED_PARAGRAPHS, ADDED_TEXT
    } = require('./terms-content-update-fixture');
    const cookie = await unaccepted();
    const currentTerms = legalDocumentSnapshots().find(document => document.kind === 'terms');
    const previousContent = currentTerms.content.replace(ADDED_TEXT, '');
    assert.equal(crypto.createHash('sha256').update(previousContent).digest('hex'), PREVIOUS_TERMS_HASH);
    await pool.query(`INSERT INTO legal_policy_versions(kind,version,content,content_sha256)
      VALUES('terms',$1,$2,$3) ON CONFLICT(kind,version) DO NOTHING`,
    [PREVIOUS_TERMS_VERSION, previousContent, PREVIOUS_TERMS_HASH]);
    await pool.query(`INSERT INTO user_legal_acceptances(user_id,review_version,terms_version,privacy_version,wording_version)
      VALUES($1,$2,$3,$4,$5)`, [getOrganizerId(), REQUIRED_LEGAL_REVIEW_VERSION,
      PREVIOUS_TERMS_VERSION, CURRENT_LEGAL_VERSIONS.privacy, CURRENT_LEGAL_VERSIONS.wording]);
    const originalReceipt = (await acceptances())[0];
    const originalSnapshot = (await pool.query(
      "SELECT * FROM legal_policy_versions WHERE kind='terms' AND version=$1", [PREVIOUS_TERMS_VERSION]
    )).rows[0];
    const before = await effects();
    const outboxBefore = mailer.devOutbox.length;

    await registerLegalPolicyVersions(pool);
    await registerLegalPolicyVersions(pool);
    const historicalResponse = await request(`/terms?version=${PREVIOUS_TERMS_VERSION}`);
    assert.equal(historicalResponse.status, 200);
    const historicalHtml = await historicalResponse.text();
    for (const paragraph of ADDED_PARAGRAPHS) assert.equal(historicalHtml.includes(paragraph), false);
    for (const url of ['/terms', `/terms?version=${CURRENT_TERMS_VERSION}`]) {
      const response = await request(url);
      assert.equal(response.status, 200);
      const html = await response.text();
      for (const paragraph of ADDED_PARAGRAPHS) assert.ok(html.includes(`<p>${paragraph}</p>`));
    }

    const revisit = await request('/account/review?next=%2Fdashboard', { headers: { cookie } });
    assert.equal(revisit.status, 303);
    assert.equal(revisit.headers.get('location'), '/dashboard');
    assert.equal((await request('/dashboard', { headers: { cookie } })).status, 200);
    const repeated = await recordLegalAcceptance(pool, { id: getOrganizerId() });
    assert.equal(repeated.created, false);
    assert.deepEqual((await acceptances())[0], originalReceipt);
    assert.deepEqual((await pool.query(
      "SELECT * FROM legal_policy_versions WHERE kind='terms' AND version=$1", [PREVIOUS_TERMS_VERSION]
    )).rows[0], originalSnapshot);
    assert.deepEqual(await effects(), before);
    assert.equal(mailer.devOutbox.length, outboxBefore);
  });

  test('legal acceptance save failure stays on the review screen with retry and records no false acceptance', async () => {
    const cookie = await unaccepted();
    const { fields } = await review(cookie, '/events');
    const originalQuery = pool.query;
    pool.query = function query(sql, ...args) {
      if (typeof sql === 'string' && sql.includes('INSERT INTO user_legal_acceptances')) {
        return Promise.reject(new Error('Synthetic isolated test failure'));
      }
      return originalQuery.call(this, sql, ...args);
    };
    try {
      const failed = await submit(cookie, fields);
      assert.equal(failed.status, 503);
      assert.equal(failed.headers.get('location'), null);
      const html = await failed.text();
      assert.match(html, /We could not save your agreement\. Please try again\./);
      assert.match(html, /role="alert"/);
      assert.doesNotMatch(html, /Synthetic isolated test failure/);
      assert.equal((await acceptances()).length, 0);
    } finally { pool.query = originalQuery; }
    assert.equal((await submit(cookie, fields)).status, 303);
    assert.equal((await acceptances()).length, 1);
  });

  test('legal acceptance cannot be transferred to another account or replayed after session revocation', async () => {
    const cookie = await unaccepted();
    const { fields } = await review(cookie);
    const other = (await pool.query("INSERT INTO organizers(email,name) VALUES ('csrf-legal@example.test','Other') RETURNING id,user_id")).rows[0];
    const transferred = await submit(`sge_session=${signSession(other.id)}`, fields);
    assert.equal(transferred.status, 403);
    assert.equal((await acceptances(other.user_id)).length, 0);
    await pool.query("UPDATE organizers SET sessions_valid_after=NOW()+INTERVAL '1 second' WHERE id=$1", [getOrganizerId()]);
    const stale = await submit(cookie, fields);
    assert.ok([302, 303, 401].includes(stale.status));
    assert.equal((await acceptances()).length, 0);
    const noSession = await submit('', fields);
    assert.ok([302, 303, 401].includes(noSession.status));
    assert.equal((await acceptances()).length, 0);
  });

  test('unaccepted existing sessions cannot bypass the gate through host pages or direct mutation APIs', async () => {
    const cookie = await unaccepted();
    const event = await createEvent({ slug: 'legal-draft', status: 'draft' });
    const before = await effects();
    for (const path of ['/dashboard', '/events', '/events/new', `/events/${event.id}/manage`, '/settings/messaging', '/following', '/profile', `/e/${event.slug}`]) {
      const response = await request(path, { headers: { cookie } });
      assert.ok([302, 303].includes(response.status), `${path} must require review`);
      assert.match(response.headers.get('location'), /^\/account\/review\?/);
      assert.equal(new URL(response.headers.get('location'), origin()).searchParams.get('next'), path);
    }
    for (const [path, method] of [
      ['/api/events', 'GET'], ['/api/events', 'POST'],
      [`/api/events/${event.id}`, 'PATCH'], ['/api/uploads/cover', 'POST'],
      ['/api/me/profile', 'PATCH'], ['/api/sms-credits', 'GET']
    ]) {
      const response = await request(path, {
        method, headers: { cookie, 'content-type': 'application/json', origin: origin() },
        ...(method === 'GET' ? {} : { body: '{}' })
      });
      assert.equal(response.status, 403, `${method} ${path} must be blocked before mutation`);
      const body = await response.json();
      assert.equal(body.error, 'legal_acceptance_required');
      assert.match(body.redirect, /^\/account\/review/);
    }
    assert.deepEqual(await effects(), before);
  });

  test('policy pages, sign out, guest events and photo-only grants do not require host acceptance', async () => {
    const cookie = await unaccepted();
    const event = await createEvent({ slug: 'legal-public' });
    const guest = (await pool.query("INSERT INTO organizers(email,name) VALUES ('guest-legal@example.test','Guest') RETURNING id")).rows[0];
    await createRsvp(event.id, { first_name: 'Guest', email: 'guest-legal@example.test', account_id: guest.id });
    const before = await effects();
    for (const path of ['/terms', '/privacy', `/e/${event.slug}`]) {
      const response = await request(path, { headers: { cookie: `sge_session=${signSession(guest.id)}` } });
      assert.equal(response.status, 200, `${path} stays open to guests`);
    }
    const photo = await request(`/add-photo?event=${event.slug}`, { headers: { cookie: `sge_photo=${signPhotoAccess(guest.id)}` } });
    assert.equal(photo.status, 200, 'event-scoped photo permission is not platform onboarding');
    const status = await request('/api/legal-acceptance', { headers: { cookie } });
    assert.equal(status.status, 200);
    const logout = await request('/api/auth/logout', { method: 'POST', headers: { cookie, origin: origin() } });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie') || '', /sge_session=;/);
    assert.deepEqual(await effects(), before);
    assert.equal((await acceptances()).length, 0);
  });

  test('published event viewing stays public while owner editing and draft previews require legal review', async () => {
    const cookie = await unaccepted();
    const event = await createEvent({ slug: 'legal-owner-public' });
    const anonymous = await request(`/e/${event.slug}`);
    assert.equal(anonymous.status, 200);
    const owner = await request(`/e/${event.slug}`, { headers: { cookie } });
    assert.equal(owner.status, 200, 'viewing a public event is not platform onboarding');
    const html = await owner.text();
    assert.match(html, /href="\/account\/review\?next=/);
    assert.doesNotMatch(html, /<script[^>]+src="\/js\/event-owner-editor\.js/,
      'unaccepted owners cannot initialize the editing surface');
    const explicit = await request(`/e/${event.slug}?edit=appearance`, { headers: { cookie } });
    assert.ok([302, 303].includes(explicit.status));
    assert.equal(new URL(explicit.headers.get('location'), origin()).searchParams.get('next'), `/e/${event.slug}?edit=appearance`);
    const { fields } = await review(cookie, `/e/${event.slug}?edit=appearance`);
    await submit(cookie, fields);
    const accepted = await request(`/e/${event.slug}?edit=appearance`, { headers: { cookie } });
    assert.equal(accepted.status, 200);
    assert.match(await accepted.text(), /<script[^>]+src="\/js\/event-owner-editor\.js/);
  });

  test('unaccepted hosts cannot moderate other guests comments while attendee own-comment deletion stays available', async () => {
    const cookie = await unaccepted();
    const event = await createEvent({ slug: 'legal-comment-moderation', comments_enabled: true });
    const guest = await createRsvp(event.id, { first_name: 'Guest', email: 'comment-legal-guest@example.test' });
    const hostAsGuest = await createRsvp(event.id, {
      first_name: 'Host', email: 'host@example.test', account_id: getOrganizerId()
    });
    const addComment = async rsvp => (await pool.query(
      'INSERT INTO event_comments(event_id,rsvp_id,message) VALUES($1,$2,$3) RETURNING id',
      [event.id, rsvp.id, 'Synthetic legal moderation test comment']
    )).rows[0];
    const guestComment = await addComment(guest);
    const hostComment = await addComment(hostAsGuest);
    const endpoint = `/api/public/events/${event.slug}/comments`;
    const wall = await request(endpoint, { headers: { cookie } });
    assert.equal(wall.status, 200);
    const body = await wall.json();
    assert.equal(body.canModerate, false);
    assert.equal(body.comments.find(comment => comment.id === guestComment.id).can_delete, false);
    assert.equal(body.comments.find(comment => comment.id === hostComment.id).can_delete, true,
      'being an unaccepted host does not remove attendee control of their own comment');
    const denied = await request(`${endpoint}/${guestComment.id}`, {
      method: 'DELETE', headers: { cookie, origin: origin() }
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, 'legal_acceptance_required');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM event_comments WHERE event_id=$1', [event.id])).rows[0].count, 2);

    const guestDelete = await request(`${endpoint}/${guestComment.id}`, {
      method: 'DELETE', headers: { cookie: `sge_attendee_${event.id}=${encodeURIComponent(guest.manage_token)}`, origin: origin() }
    });
    assert.equal(guestDelete.status, 200, 'a guest may remove their own comment without entering platform onboarding');
    const hostOwnDelete = await request(`${endpoint}/${hostComment.id}`, {
      method: 'DELETE', headers: { cookie, origin: origin() }
    });
    assert.equal(hostOwnDelete.status, 200, 'own attendee deletion is not an event-management action');
    assert.equal((await acceptances()).length, 0);

    const another = await addComment(guest);
    const { fields } = await review(cookie, `/events/${event.id}/manage`);
    await submit(cookie, fields);
    const acceptedWall = await request(endpoint, { headers: { cookie } });
    assert.equal((await acceptedWall.json()).canModerate, true);
    const moderation = await request(`${endpoint}/${another.id}`, {
      method: 'DELETE', headers: { cookie, origin: origin() }
    });
    assert.equal(moderation.status, 200, 'accepted host may moderate the event wall');
  });

  test('signed-out protected page links preserve their destination through login and legal review', async () => {
    for (const next of ['/events/173/manage?tab=people', '/events/new?id=173&advanced=1', '/events?view=hosting']) {
      const response = await request(next);
      assert.ok([302, 303].includes(response.status));
      const login = new URL(response.headers.get('location'), origin());
      assert.equal(login.pathname, '/login');
      assert.equal(login.searchParams.get('next'), next);
    }
    const api = await request('/api/events');
    assert.equal(api.status, 401, 'API callers get authentication status rather than an HTML redirect');
    assert.equal(api.headers.get('location'), null);
  });

  test('email code and email link sign-ins send unaccepted users to review and preserve the specific draft', async () => {
    await unaccepted();
    const event = await createEvent({ slug: 'legal-auth-draft', status: 'draft' });
    const next = `/events/${event.id}/manage`;
    const email = await emailCodeSignIn(next);
    assert.ok(email.cookie);
    assert.match(email.body.redirect, /^\/account\/review\?/);
    assert.equal(new URL(email.body.redirect, origin()).searchParams.get('next'), next);
    assert.equal((await acceptances()).length, 0);
    resetRateLimits();
    const start = await request('/api/auth/magic-link', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'host@example.test', next })
    });
    assert.equal(start.status, 200);
    const message = lastDevEmail('host@example.test', 'magic_link');
    const token = new URL(message.link).searchParams.get('token');
    const scanner = await request(`/auth/verify?token=${encodeURIComponent(token)}`);
    assert.equal(scanner.status, 200);
    assert.equal((await acceptances()).length, 0, 'GET scanners cannot accept terms');
    const link = await request('/auth/verify', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token })
    });
    assert.equal(link.status, 303);
    assert.match(link.headers.get('location'), /^\/account\/review\?/);
    assert.equal(new URL(link.headers.get('location'), origin()).searchParams.get('next'), next);
    const cookie = responseCookie(link, 'sge_session');
    const { fields } = await review(cookie, next);
    assert.equal((await submit(cookie, fields)).headers.get('location'), next);
    const again = await emailCodeSignIn(next);
    assert.equal(again.body.redirect, next, 'accepted email sign-in skips review');
  });

  test('a brand-new account reviews once before name onboarding without losing its create-event destination', async () => {
    const next = '/events/new?advanced=1';
    const email = await emailCodeSignIn(next, 'brand-new-legal@example.test');
    const redirect = new URL(email.body.redirect, origin());
    assert.equal(redirect.pathname, '/account/review');
    const afterReview = new URL(redirect.searchParams.get('next'), origin());
    assert.equal(afterReview.pathname, '/onboarding/name');
    assert.equal(afterReview.searchParams.get('next'), next);
    const user = (await pool.query("SELECT id,user_id FROM organizers WHERE email='brand-new-legal@example.test'")).rows[0];
    assert.equal((await acceptances(user.user_id)).length, 0);
    const reviewNext = `${afterReview.pathname}${afterReview.search}`;
    const { fields } = await review(email.cookie, reviewNext);
    const agreed = await submit(email.cookie, fields);
    assert.equal(agreed.headers.get('location'), reviewNext);
    assert.equal((await acceptances(user.user_id)).length, 1);
    const named = await request(reviewNext, { headers: { cookie: email.cookie } });
    assert.equal(named.status, 200);
    assert.match(await named.text(), /What should we call you/);
  });

  test('typed guest verification finishes the public RSVP context before requiring platform legal review', async () => {
    resetRateLimits();
    const event = await createEvent({ slug: 'legal-guest-code' });
    const email = 'legal-verified-guest@example.test';
    await createRsvp(event.id, { first_name: 'River', email });
    const next = `/e/${event.slug}`;
    const started = await request('/api/auth/guest-code', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, next })
    });
    assert.equal(started.status, 200);
    const verified = await request('/api/auth/verify-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: responseCookie(started, 'sge_sign_in') },
      body: JSON.stringify({ code: lastDevEmail(email, 'verification_code').code })
    });
    assert.equal(verified.status, 200);
    const body = await verified.json();
    assert.equal(body.kind, 'guest');
    assert.equal(body.redirect, next, 'a guest completing RSVP verification is not sent to host onboarding');
    const cookie = responseCookie(verified, 'sge_session');
    assert.ok(cookie);
    const user = (await pool.query('SELECT user_id FROM organizers WHERE email=$1', [email])).rows[0];
    assert.equal((await acceptances(user.user_id)).length, 0);
    assert.equal((await request(next, { headers: { cookie } })).status, 200);
    const app = await request('/dashboard', { headers: { cookie } });
    assert.equal(app.status, 303);
    assert.match(app.headers.get('location'), /^\/account\/review\?/);
  });

  test('verified phone and email identities share the same once-per-account legal acceptance', async () => {
    await unaccepted();
    const phone = '+14155550187';
    await attachVerifiedPhoneIdentity(pool, {
      userId: getOrganizerId(), phone, verifiedAt: new Date(), verificationSource: 'legal_integration_test'
    });
    const originalStart = phoneVerification.startVerification;
    const originalCheck = phoneVerification.checkVerification;
    const verificationSid = `VE${'7'.repeat(32)}`;
    phoneVerification.startVerification = async () => ({ verificationSid, phone, status: 'pending' });
    phoneVerification.checkVerification = async ({ code }) => {
      assert.equal(code, '123456');
      return { verificationSid, phone, approved: true, status: 'approved' };
    };
    async function phoneSignIn() {
      resetRateLimits();
      const start = await request('/api/auth/phone/start', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone, next: '/events?view=hosting' })
      });
      assert.equal(start.status, 200);
      const verified = await request('/api/auth/phone/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: responseCookie(start, 'sge_phone_auth') },
        body: JSON.stringify({ code: '123456' })
      });
      assert.equal(verified.status, 200);
      return { body: await verified.json(), cookie: responseCookie(verified, 'sge_session') };
    }
    try {
      const first = await phoneSignIn();
      assert.match(first.body.redirect, /^\/account\/review\?/);
      const { fields } = await review(first.cookie, '/events?view=hosting');
      assert.equal((await submit(first.cookie, fields)).status, 303);
      const second = await phoneSignIn();
      assert.equal(second.body.redirect, '/events?view=hosting');
      const email = await emailCodeSignIn('/profile');
      assert.equal(email.body.redirect, '/profile');
      assert.equal((await acceptances()).length, 1);
    } finally {
      phoneVerification.startVerification = originalStart;
      phoneVerification.checkVerification = originalCheck;
    }
  });
};
