const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'auth-hardening-unit-secret';
const { signSession, parseSession, sessionRevoked, MAX_AGE_SECONDS } = require('../src/lib/session');
const { maskEmail, normalizeCode } = require('../src/lib/sign-in-challenges');
const { signPhotoAccess, readPhotoAccess } = require('../src/lib/photo-access');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('session cookies carry an issue time and still accept pre-v1.0.85 cookies', () => {
  const issuedAt = Date.now() - 5000;
  const current = parseSession(signSession(42, issuedAt));
  assert.equal(current.id, 42);
  assert.equal(current.iat, issuedAt);

  // Legacy format: id.exp.sig, signed with the same secret.
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const legacyPayload = `42.${exp}`;
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(legacyPayload).digest('hex');
  const legacy = parseSession(`${legacyPayload}.${sig}`);
  assert.equal(legacy.id, 42);
  assert.equal(legacy.iat, (exp - MAX_AGE_SECONDS) * 1000);

  assert.equal(parseSession(`42.${issuedAt}.${exp}.${'0'.repeat(64)}`), null);
  assert.equal(parseSession('not-a-cookie'), null);
});

test('"sign out of all devices" rejects every cookie issued before it', () => {
  const session = parseSession(signSession(7, Date.now() - 60000));
  assert.equal(sessionRevoked(session, { sessions_valid_after: null }), false);
  assert.equal(sessionRevoked(session, { sessions_valid_after: new Date() }), true);
  const fresh = parseSession(signSession(7, Date.now() + 1000));
  assert.equal(sessionRevoked(fresh, { sessions_valid_after: new Date() }), false);
});

test('photo-only grants are signed, short-lived, and not account sessions', () => {
  const grant = signPhotoAccess(99);
  assert.equal(readPhotoAccess({ headers: { cookie: `sge_photo=${grant}` } }), 99);
  assert.equal(readPhotoAccess({ headers: { cookie: `sge_photo=${grant.replace(/.$/, grant.endsWith('0') ? '1' : '0')}` } }), null);
  // A photo grant is not a valid account cookie.
  assert.equal(parseSession(grant), null);
});

test('codes and masked emails are normalized for display and entry', () => {
  assert.equal(normalizeCode(' 482 913 '), '482913');
  assert.equal(normalizeCode('48-29-13-77'), '482913');
  assert.equal(maskEmail('lucas@example.com'), 'l•••@example.com');
  assert.equal(maskEmail('a@b.co'), 'a@b.co');
});

test('opening a sign-in link never uses it up; only the Continue POST does', () => {
  const auth = read('src/routes/auth.js');
  const getHandler = auth.slice(auth.indexOf("router.get('/auth/verify'"), auth.indexOf('function sameOriginPost'));
  assert.match(getHandler, /peekLink\(pool, token\)/);
  assert.doesNotMatch(getHandler, /consumeLink|used_at|setSessionCookie/);
  assert.match(getHandler, /continuePage\(/);

  const postHandler = auth.slice(auth.indexOf("router.post('/auth/verify'"), auth.indexOf('const CODE_ERRORS'));
  assert.match(postHandler, /sameOriginPost\(req\)/);
  assert.match(postHandler, /consumeLink\(client, token\)/);
  assert.match(auth, /<form method="POST" action="\/auth\/verify">/);
});

test('sign-in links and codes are stored only as hashes and codes bind to the requesting browser', () => {
  const challenges = read('src/lib/sign-in-challenges.js');
  const migration = read('src/db/migrations/037_sign_in_codes_and_session_revocation.sql');
  assert.match(challenges, /const hashedToken = tokenHash\(token\)/);
  assert.match(challenges, /codeHash\(hashedToken, code\)/);
  assert.match(challenges, /requestToken \? tokenHash\(requestToken\) : null/);
  assert.match(challenges, /MAX_CODE_ATTEMPTS = 5/);
  assert.match(challenges, /crypto\.timingSafeEqual/);
  assert.match(migration, /SET token = encode\(sha256\(convert_to\(token, 'UTF8'\)\), 'hex'\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS sessions_valid_after TIMESTAMPTZ/);
  assert.match(migration, /'sign_in', 'follow_host', 'add_photo', 'verify_guest'/);
  // Photo links already in inboxes stop being full sign-ins at deploy time.
  assert.match(migration, /SET intent = 'add_photo'\s+WHERE intent = 'sign_in' AND used_at IS NULL AND return_path LIKE '\/add-photo%'/);
});

test('signing out forgets the remembered guest and "all devices" revokes server-side', () => {
  const auth = read('src/routes/auth.js');
  const logout = auth.slice(auth.indexOf("router.post('/api/auth/logout',"), auth.indexOf("router.post('/api/auth/logout-all'"));
  assert.match(logout, /revokeGuestSession\(pool, req\)/);
  assert.match(logout, /clearGuestSessionCookie\(res\)/);
  assert.match(logout, /clearPhotoAccessCookie\(res\)/);
  const logoutAll = auth.slice(auth.indexOf("router.post('/api/auth/logout-all'"), auth.indexOf("router.get('/api/auth/me'"));
  assert.match(logoutAll, /requireOrganizer/);
  assert.match(logoutAll, /sessions_valid_after=\$2/);
  assert.match(logoutAll, /revokeIdentityGuestSessions/);
  assert.match(read('src/views/settings-v2.html'), /Sign out of all devices/);
});

test('the sign-in page and Host Page follow modal accept the emailed code', () => {
  const login = read('src/views/login.html');
  const host = read('src/views/host-public.html');
  for (const view of [login, host]) {
    assert.match(view, /autocomplete="one-time-code"/);
    assert.match(view, /\/api\/auth\/verify-code/);
  }
  assert.match(login, /Enter the 6-digit code/);
});
