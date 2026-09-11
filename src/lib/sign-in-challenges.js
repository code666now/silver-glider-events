const crypto = require('crypto');
const { tokenHash } = require('./guest-session');
const { readCookie } = require('./private-events');

// One emailed challenge carries two ways in: a link (works on any device) and
// a 6-digit code (typed into the page that asked for it). The code is bound to
// the requesting browser by `sge_sign_in`, so a code is useless without the
// cookie, and `code_attempts` caps guessing. Only hashes are stored.
const REQUEST_COOKIE = 'sge_sign_in';
const MAX_CODE_ATTEMPTS = 5;
const CODE_LENGTH = 6;

function codeHash(hashedToken, code) {
  return crypto.createHmac('sha256', String(process.env.SESSION_SECRET || '').trim())
    .update(`sign-in-code:${hashedToken}:${code}`).digest('hex');
}

function newCode() {
  return String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

function normalizeCode(value) {
  return String(value || '').replace(/\D/g, '').slice(0, CODE_LENGTH);
}

function maskEmail(email) {
  const [local = '', domain = ''] = String(email || '').split('@');
  return domain ? `${local.slice(0, 1)}${local.length > 1 ? '•••' : ''}@${domain}` : '';
}

async function createSignInChallenge(db, {
  email,
  intent = 'sign_in',
  targetOrganizerId = null,
  returnPath = null,
  ttlMinutes = 15,
  withCode = true
}) {
  const token = crypto.randomBytes(32).toString('hex');
  const hashedToken = tokenHash(token);
  const code = withCode ? newCode() : null;
  const requestToken = withCode ? crypto.randomBytes(24).toString('base64url') : null;
  await db.query(
    `INSERT INTO magic_link_tokens
       (token, email, expires_at, intent, target_organizer_id, return_path, code_hash, request_hash)
     VALUES ($1,$2,NOW() + make_interval(mins => $3),$4,$5,$6,$7,$8)`,
    [hashedToken, email, ttlMinutes, intent, targetOrganizerId, returnPath || null,
     code ? codeHash(hashedToken, code) : null, requestToken ? tokenHash(requestToken) : null]
  );
  return { token, code, requestToken };
}

const PENDING_COLUMNS = 'email, intent, target_organizer_id, return_path';

// Read-only: GET requests (and the email scanners that make them) must never
// use up a link.
async function peekLink(db, token) {
  if (!token || token.length > 200) return null;
  const { rows } = await db.query(
    `SELECT ${PENDING_COLUMNS} FROM magic_link_tokens
      WHERE token=$1 AND used_at IS NULL AND expires_at > NOW()`,
    [tokenHash(token)]
  );
  return rows[0] || null;
}

async function consumeLink(client, token) {
  if (!token || token.length > 200) return null;
  const { rows } = await client.query(
    `UPDATE magic_link_tokens SET used_at=NOW()
      WHERE token=$1 AND used_at IS NULL AND expires_at > NOW()
      RETURNING ${PENDING_COLUMNS}`,
    [tokenHash(token)]
  );
  return rows[0] || null;
}

// Returns { pending } on success or { error: 'expired' | 'invalid' | 'locked' }.
// Call inside a transaction and COMMIT even on failure so attempts persist.
async function consumeCode(client, requestToken, submittedCode) {
  if (!requestToken || requestToken.length > 100) return { error: 'expired' };
  const { rows } = await client.query(
    `SELECT id, token, code_hash, code_attempts
       FROM magic_link_tokens
      WHERE request_hash=$1 AND used_at IS NULL AND expires_at > NOW() AND code_hash IS NOT NULL
      ORDER BY id DESC LIMIT 1
      FOR UPDATE`,
    [tokenHash(requestToken)]
  );
  const challenge = rows[0];
  if (!challenge) return { error: 'expired' };
  if (challenge.code_attempts >= MAX_CODE_ATTEMPTS) return { error: 'locked' };

  const code = normalizeCode(submittedCode);
  const expected = Buffer.from(challenge.code_hash);
  const actual = Buffer.from(codeHash(challenge.token, code));
  const matches = code.length === CODE_LENGTH &&
    expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  if (!matches) {
    const attempts = challenge.code_attempts + 1;
    await client.query('UPDATE magic_link_tokens SET code_attempts=$2 WHERE id=$1', [challenge.id, attempts]);
    return attempts >= MAX_CODE_ATTEMPTS
      ? { error: 'locked' }
      : { error: 'invalid', remaining: MAX_CODE_ATTEMPTS - attempts };
  }

  const consumed = await client.query(
    `UPDATE magic_link_tokens SET used_at=NOW() WHERE id=$1 RETURNING ${PENDING_COLUMNS}`,
    [challenge.id]
  );
  return { pending: consumed.rows[0] };
}

function setSignInRequestCookie(res, requestToken, maxAgeSeconds = 15 * 60) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${REQUEST_COOKIE}=${encodeURIComponent(requestToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`);
}

function readSignInRequest(req) {
  return readCookie(req, REQUEST_COOKIE);
}

function clearSignInRequestCookie(res) {
  res.append('Set-Cookie', `${REQUEST_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

module.exports = {
  CODE_LENGTH,
  MAX_CODE_ATTEMPTS,
  REQUEST_COOKIE,
  clearSignInRequestCookie,
  consumeCode,
  consumeLink,
  createSignInChallenge,
  maskEmail,
  normalizeCode,
  peekLink,
  readSignInRequest,
  setSignInRequestCookie
};
