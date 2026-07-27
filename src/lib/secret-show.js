const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const SESSION_SECRET = String(process.env.SESSION_SECRET || '').trim();
if (!SESSION_SECRET) throw new Error('SESSION_SECRET is required');

const CODE_LENGTH = 6;
const UNLOCK_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const ATTEMPT_MAX_AGE_SECONDS = 24 * 60 * 60;
const ATTEMPT_COOKIE = 'sge_secret_attempt';

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function validateCode(value) {
  const code = normalizeCode(value);
  if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(code)) {
    return { error: `Use exactly ${CODE_LENGTH} letters or numbers` };
  }
  return { code };
}

async function hashCode(value) {
  const validated = validateCode(value);
  if (validated.error) throw new Error(validated.error);
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(validated.code, salt, 32);
  return `scrypt$${salt}$${Buffer.from(derived).toString('hex')}`;
}

async function verifyCode(value, storedHash) {
  const validated = validateCode(value);
  if (validated.error) return false;
  const [algorithm, salt, expectedHex] = String(storedHash || '').split('$');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/i.test(salt || '') || !/^[a-f0-9]{64}$/i.test(expectedHex || '')) {
    return false;
  }
  const actual = Buffer.from(await scrypt(validated.code, salt, 32));
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function hmac(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
}

function sign(parts, maxAgeSeconds) {
  const exp = Math.floor(Date.now() / 1000) + maxAgeSeconds;
  const payload = [...parts, exp].join('.');
  return `${payload}.${hmac(payload)}`;
}

function parseSigned(value, partCount) {
  const parts = String(value || '').split('.');
  if (parts.length !== partCount + 2) return null;
  const signature = parts.pop();
  const exp = Number(parts.pop());
  const payload = [...parts, exp].join('.');
  const expected = hmac(payload);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  if (signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return { parts, exp };
}

function readCookie(req, name) {
  const header = String(req.headers.cookie || '');
  const part = header.split(';').map(item => item.trim()).find(item => item.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
}

function cookieSuffix(maxAgeSeconds) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function unlockCookieName(eventId) {
  return `sge_secret_${Number(eventId)}`;
}

function setUnlockCookie(res, event) {
  const value = sign([Number(event.id), Number(event.secret_show_version)], UNLOCK_MAX_AGE_SECONDS);
  res.append('Set-Cookie', `${unlockCookieName(event.id)}=${encodeURIComponent(value)}${cookieSuffix(UNLOCK_MAX_AGE_SECONDS)}`);
}

function hasUnlockCookie(req, event) {
  const parsed = parseSigned(readCookie(req, unlockCookieName(event.id)), 2);
  if (!parsed) return false;
  const [eventId, version] = parsed.parts.map(Number);
  return eventId === Number(event.id) && version === Number(event.secret_show_version);
}

function ensureAttemptSession(req, res) {
  const current = parseSigned(readCookie(req, ATTEMPT_COOKIE), 1);
  if (current && /^[a-f0-9]{24}$/.test(current.parts[0])) return current.parts[0];
  const id = crypto.randomBytes(12).toString('hex');
  const value = sign([id], ATTEMPT_MAX_AGE_SECONDS);
  res.append('Set-Cookie', `${ATTEMPT_COOKIE}=${encodeURIComponent(value)}${cookieSuffix(ATTEMPT_MAX_AGE_SECONDS)}`);
  return id;
}

module.exports = {
  CODE_LENGTH,
  ensureAttemptSession,
  hasUnlockCookie,
  hashCode,
  normalizeCode,
  setUnlockCookie,
  unlockCookieName,
  validateCode,
  verifyCode
};
