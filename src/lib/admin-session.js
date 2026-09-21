const crypto = require('crypto');
const { readCookie } = require('./private-events');

const COOKIE_NAME = 'sge_admin_session';
const MAX_AGE_SECONDS = 12 * 60 * 60;

function secret() {
  const value = String(process.env.SESSION_SECRET || '').trim();
  if (!value) throw new Error('SESSION_SECRET is required');
  return value;
}

function signature(payload) {
  return crypto.createHmac('sha256', secret())
    .update(`admin-session:${payload}`)
    .digest('hex');
}

function signAdminSession(operatorId, issuedAt = Date.now()) {
  const id = Number(operatorId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('A valid admin operator id is required');
  const expiresAt = Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS;
  const payload = `${id}.${Math.floor(issuedAt)}.${expiresAt}`;
  return `${payload}.${signature(payload)}`;
}

function parseAdminSession(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4) return null;
  const payload = parts.slice(0, -1).join('.');
  const expected = signature(payload);
  const received = parts[3];
  if (received.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))) return null;
  const operatorId = Number(parts[0]);
  const issuedAt = Number(parts[1]);
  const expiresAt = Number(parts[2]);
  if (!Number.isSafeInteger(operatorId) || operatorId <= 0 || !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return null;
  return { operatorId, issuedAt, expiresAt };
}

function readAdminSessionCookie(req) {
  return readCookie(req, COOKIE_NAME);
}

function setAdminSessionCookie(res, operatorId, issuedAt = Date.now()) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(signAdminSession(operatorId, issuedAt))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE_SECONDS}${secure}`);
}

function clearAdminSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie',
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

async function loadAdminOperator(db, req) {
  const cookie = readAdminSessionCookie(req);
  const session = parseAdminSession(cookie);
  if (!session) return { operator: null, session: null, stale: Boolean(cookie) };
  const { rows } = await db.query(
    `SELECT id,email,role,status,sessions_valid_after,last_login_at,created_at,updated_at
       FROM admin_operators
      WHERE id=$1 AND status='active'`,
    [session.operatorId]
  );
  const operator = rows[0] || null;
  const revoked = operator?.sessions_valid_after &&
    session.issuedAt < new Date(operator.sessions_valid_after).getTime();
  if (!operator || revoked) return { operator: null, session: null, stale: true };
  return { operator, session, stale: false };
}

module.exports = {
  COOKIE_NAME,
  MAX_AGE_SECONDS,
  clearAdminSessionCookie,
  loadAdminOperator,
  parseAdminSession,
  readAdminSessionCookie,
  setAdminSessionCookie,
  signAdminSession
};
