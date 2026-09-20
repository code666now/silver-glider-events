const crypto = require('crypto');
const { readCookie } = require('./private-events');

const COOKIE_NAME = 'sge_identity_step_up';
const MAX_AGE_SECONDS = 20 * 60;

function secret() {
  const value = String(process.env.SESSION_SECRET || '').trim();
  if (!value) throw new Error('SESSION_SECRET is required');
  return value;
}

function signature(payload) {
  return crypto.createHmac('sha256', secret()).update(`identity-step-up:${payload}`).digest('hex');
}

function signIdentityStepUp(userId, issuedAt = Date.now()) {
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('A valid user id is required');
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS;
  const payload = `${id}.${Math.floor(issuedAt)}.${exp}`;
  return `${payload}.${signature(payload)}`;
}

function parseIdentityStepUp(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4) return null;
  const payload = parts.slice(0, -1).join('.');
  const expected = signature(payload);
  const received = parts[3];
  if (received.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))) return null;
  const userId = Number(parts[0]);
  const issuedAt = Number(parts[1]);
  const expiresAt = Number(parts[2]);
  if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return null;
  return { userId, issuedAt, expiresAt };
}

function hasIdentityStepUp(req, userId) {
  const proof = parseIdentityStepUp(readCookie(req, COOKIE_NAME));
  return Boolean(proof && Number(proof.userId) === Number(userId));
}

function setIdentityStepUpCookie(res, userId) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(signIdentityStepUp(userId))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}${secure}`);
}

function clearIdentityStepUpCookie(res) {
  res.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

module.exports = {
  COOKIE_NAME,
  MAX_AGE_SECONDS,
  clearIdentityStepUpCookie,
  hasIdentityStepUp,
  parseIdentityStepUp,
  setIdentityStepUpCookie,
  signIdentityStepUp
};
