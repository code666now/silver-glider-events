const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'legal-acceptance-unit-secret';
const {
  CURRENT_LEGAL_VERSIONS, REQUIRED_LEGAL_REVIEW_VERSION,
  legalDocumentSnapshots, registerLegalPolicyVersions, legalAcceptanceState,
  safeLegalNext, acceptanceRedirect, issueReviewToken, verifyReviewToken,
  recordLegalAcceptance, legalGateExempt, requireLegalAcceptance
} = require('../src/lib/legal-acceptance');
const { signSession } = require('../src/lib/session');
const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const request = (userId = 7, issuedAt = Date.now()) => ({ headers: { cookie: `sge_session=${signSession(userId, issuedAt)}` } });
const account = { id: 7, user_id: 42 };
const bodyFor = (req, next = '/events/123/manage') => ({
  csrfToken: issueReviewToken(req, account, next), next,
  termsVersion: CURRENT_LEGAL_VERSIONS.terms,
  privacyVersion: CURRENT_LEGAL_VERSIONS.privacy,
  wordingVersion: CURRENT_LEGAL_VERSIONS.wording,
  accepted: true
});

test('legal safe return paths preserve drafts and fragment locations without external, API or auth redirects', () => {
  for (const next of ['/dashboard', '/events/123/manage', '/events/new?id=42&advanced=1#vibe', '/e/winter?edit=appearance', '/onboarding/name?next=%2Fevents', '/profile']) {
    assert.equal(safeLegalNext(next), next);
    const redirect = new URL(acceptanceRedirect(next), 'https://example.test');
    assert.equal(redirect.pathname, '/account/review');
    assert.equal(redirect.searchParams.get('next'), next);
  }
  for (const next of [null, {}, ['//evil.test'], '', 'https://evil.test', '//evil.test', '/\\evil.test', '/%5cevil.test', '/%2f%2fevil.test', '/%0d%0aLocation:bad', '/foo\nbar', '/foo\0bar', '/foo%ZZ', '/login', '/auth/verify?token=secret', '/api/events', '/admin', '/admin-editor', '/account/review?next=/account/review', '/legal/accept', '/x'.repeat(800)]) {
    assert.equal(safeLegalNext(next), '/dashboard', `unsafe next ${JSON.stringify(next)} should not be used`);
  }
});

test('legal evidence snapshots match shipped source documents and include the exact agreed checkbox wording', () => {
  const snapshots = legalDocumentSnapshots();
  assert.deepEqual(snapshots.map(item => item.kind), ['terms', 'privacy', 'wording']);
  for (const snapshot of snapshots) {
    assert.equal(snapshot.version, CURRENT_LEGAL_VERSIONS[snapshot.kind]);
    assert.equal(snapshot.contentHash, crypto.createHash('sha256').update(snapshot.content).digest('hex'));
    if (snapshot.kind !== 'wording') assert.equal(snapshot.content, read(`src/legal/${snapshot.kind}.txt`));
  }
  const wording = snapshots.find(item => item.kind === 'wording').content;
  assert.match(wording, /Please review our Terms of Service and Privacy Policy to continue\./);
  assert.match(wording, /I agree to the Terms of Service and acknowledge the Privacy Policy\./);
  assert.match(wording, /Agree and continue/);
  assert.doesNotMatch(wording, /Before you begin|marketing|subscribe/i);
});

test('legal snapshot registration is idempotent but fails closed on a version/content collision', async () => {
  const documents = new Map();
  let calls = 0;
  const db = { async query(sql, values) {
    calls += 1;
    const key = `${values[0]}:${values[1]}`;
    if (sql.includes('INSERT INTO')) {
      assert.match(sql, /ON CONFLICT \(kind,version\) DO NOTHING/);
      if (!documents.has(key)) documents.set(key, { content: values[2], content_sha256: values[3] });
      return { rows: [] };
    }
    return { rows: [documents.get(key)] };
  } };
  await registerLegalPolicyVersions(db);
  await registerLegalPolicyVersions(db);
  assert.equal(documents.size, 3);
  assert.equal(calls, 12);
  documents.get(`terms:${CURRENT_LEGAL_VERSIONS.terms}`).content = 'Unexpected replacement';
  await assert.rejects(registerLegalPolicyVersions(db), /does not match this release/);
});

test('legal acceptance belongs to the canonical user and a deliberate review revision, not a device or document edit', async () => {
  const receipt = {
    accepted_at: new Date('2026-01-01'), terms_version: 'older', privacy_version: 'older', wording_version: 'older'
  };
  let seen;
  const state = await legalAcceptanceState({ query: async (sql, values) => {
    seen = values;
    assert.match(sql, /user_id=\$1 AND review_version=\$2/);
    assert.doesNotMatch(sql, /terms_version=\$|privacy_version=\$|wording_version=\$/);
    return { rows: [receipt] };
  } }, account);
  assert.deepEqual(seen, [42, REQUIRED_LEGAL_REVIEW_VERSION]);
  assert.equal(state.required, false);
  assert.equal(state.acceptedAt, receipt.accepted_at);
  assert.equal(state.redirect, null);
  const fresh = await legalAcceptanceState({ query: async () => ({ rows: [] }) }, account);
  assert.equal(fresh.required, true);
  assert.equal(fresh.acceptedAt, null);
  assert.match(fresh.redirect, /^\/account\/review\?/);
  await assert.rejects(legalAcceptanceState({ query: async () => assert.fail('invalid identity must not query') }, { id: -1 }));
});

test('legal review tokens bind canonical account, exact session, intended destination and expiry', () => {
  const req = request();
  const body = bodyFor(req);
  assert.equal(verifyReviewToken(req, account, body), true);
  assert.equal(verifyReviewToken(req, { id: 7, user_id: 43 }, body), false);
  assert.equal(verifyReviewToken(request(7, Date.now() + 1000), account, body), false);
  assert.equal(verifyReviewToken({ headers: {} }, account, body), false);
  assert.equal(verifyReviewToken(req, account, { ...body, next: '/events/999/manage' }), false);
  const [payload, signature] = body.csrfToken.split('.');
  for (const csrfToken of ['', 'malformed', `${body.csrfToken}x`, `${body.csrfToken}.`, `${body.csrfToken}.extra`, `${payload}.${'é'.repeat(signature.length)}`, 'x'.repeat(6001)]) {
    assert.equal(verifyReviewToken(req, account, { ...body, csrfToken }), false);
  }
  const originalNow = Date.now;
  try {
    const fixed = originalNow();
    Date.now = () => fixed;
    const expires = bodyFor(req);
    Date.now = () => fixed + 2 * 60 * 60 * 1000 + 1;
    assert.equal(verifyReviewToken(req, account, expires), false);
  } finally { Date.now = originalNow; }
});

test('legal recording is server timestamped, canonical, idempotent, active-account scoped and never uses client identity data', async () => {
  const acceptedAt = new Date('2026-11-10T12:00:00Z');
  let inserts = 0;
  const db = { async query(sql, values) {
    if (sql.includes('INSERT INTO user_legal_acceptances')) {
      inserts += 1;
      assert.deepEqual(values, [42, REQUIRED_LEGAL_REVIEW_VERSION,
        CURRENT_LEGAL_VERSIONS.terms, CURRENT_LEGAL_VERSIONS.privacy, CURRENT_LEGAL_VERSIONS.wording]);
      assert.match(sql, /account_status='active'/);
      assert.match(sql, /ON CONFLICT \(user_id,review_version\) DO NOTHING/);
      assert.doesNotMatch(sql, /UPDATE|email_optins|host_follows|sms_|message_log/);
      return { rows: inserts === 1 ? [{ accepted_at: acceptedAt }] : [] };
    }
    return { rows: [{ accepted_at: acceptedAt }] };
  } };
  assert.deepEqual(await recordLegalAcceptance(db, account), { acceptedAt, created: true });
  assert.deepEqual(await recordLegalAcceptance(db, account), { acceptedAt, created: false });
  await assert.rejects(recordLegalAcceptance({ query: async () => ({ rows: [] }) }, account), /no longer available/);
  await assert.rejects(recordLegalAcceptance({ query: async () => { throw new Error('offline'); } }, account), /offline/);
});

test('legal recovery exceptions cannot be broadened to host actions or new marketing consent', () => {
  const exempt = (method, originalUrl, body = {}) => legalGateExempt({ method, originalUrl, body });
  for (const [method, url] of [
    ['GET', '/api/auth/me'], ['GET', '/api/me'], ['GET', '/settings/account'],
    ['GET', '/add-photo'], ['POST', '/api/auth/logout-all'], ['POST', '/api/feedback'],
    ['POST', '/api/uploads/avatar'], ['GET', '/api/me/identities'],
    ['GET', '/api/hosts/someone/follow'], ['DELETE', '/api/hosts/someone/follow'],
    ['DELETE', '/api/people/someone/follow']
  ]) assert.equal(exempt(method, url), true, `${method} ${url} is a recovery/privacy exception`);
  assert.equal(exempt('PATCH', '/api/hosts/someone/follow', { email: false, text: false }), true);
  for (const [method, url, body] of [
    ['GET', '/dashboard'], ['GET', '/events'], ['POST', '/api/events'],
    ['POST', '/api/uploads/cover'], ['PATCH', '/api/me/profile'],
    ['POST', '/api/hosts/someone/follow'], ['PATCH', '/api/hosts/someone/follow', { email: true }],
    ['PATCH', '/api/hosts/someone/follow', { text: true }], ['PATCH', '/api/hosts/someone/follow/texts'],
    ['POST', '/api/people/someone/follow'], ['GET', '/settings/account/unrelated'],
    ['POST', '/api/feedback/unrelated'], ['GET', '/api/me/identities-unrelated']
  ]) assert.equal(exempt(method, url, body), false, `${method} ${url} must not bypass review`);
});

test('legal gate stops private responses server-side and does not let a failed state lookup pass through', async () => {
  const makeRes = () => ({ headers: {}, setHeader(key, value) { this.headers[key] = value; },
    status(status) { this.code = status; return this; }, json(value) { this.body = value; return this; },
    redirect(status, location) { this.code = status; this.location = location; return this; } });
  const makeReq = (path, required) => ({ path, originalUrl: path, baseUrl: '',
    legalAcceptanceUserId: 42, legalAcceptanceStatePromise: Promise.resolve({ required }) });
  const api = makeRes();
  assert.equal(await requireLegalAcceptance(makeReq('/api/events', true), api, account), true);
  assert.equal(api.code, 403);
  assert.equal(api.body.error, 'legal_acceptance_required');
  assert.match(api.headers['Cache-Control'], /no-store/);
  const page = makeRes();
  assert.equal(await requireLegalAcceptance(makeReq('/events/123/manage', true), page, account), true);
  assert.equal(page.code, 303);
  assert.equal(new URL(page.location, 'https://example.test').searchParams.get('next'), '/events/123/manage');
  assert.equal(await requireLegalAcceptance(makeReq('/events', false), makeRes(), account), false);
  const unavailable = makeReq('/api/events', true);
  unavailable.legalAcceptanceStatePromise = Promise.reject(new Error('unavailable'));
  await assert.rejects(requireLegalAcceptance(unavailable, makeRes(), account), /unavailable/);
});

test('existing browser tabs route legal API denials to review without replaying the interrupted mutation', async () => {
  const source = read('public/js/api.js').split('let sgAdminSessionPromise')[0];
  let fetchCalls = 0;
  const navigations = [];
  const location = { pathname: '/events/123/manage', search: '?tab=people', hash: '#invites', assign(value) { navigations.push(value); } };
  const context = vm.createContext({ location, window: { location }, fetch: async () => {
    fetchCalls += 1;
    return { status: 403, ok: false, json: async () => ({ error: 'legal_acceptance_required', redirect: 'https://untrusted.invalid/' }) };
  }, URL, URLSearchParams, Error });
  vm.runInContext(`${source}\nglobalThis.testApi = api;`, context);
  await assert.rejects(context.testApi('/api/events/123', { method: 'PATCH', body: { title: 'Edited' } }), error => error.status === 403 && error.code === 'legal_acceptance_required');
  assert.equal(fetchCalls, 1, 'failed mutation must never be automatically retried');
  assert.equal(navigations.length, 1);
  const next = new URL(navigations[0], 'https://example.test');
  assert.equal(next.pathname, '/account/review');
  assert.equal(next.searchParams.get('next'), '/events/123/manage?tab=people#invites');
  location.pathname = '/admin-editor/events';
  await assert.rejects(context.testApi('/api/events/123', { method: 'PATCH', body: {} }));
  assert.equal(navigations.length, 1, 'dedicated admin realm must not redirect into account onboarding');
});
