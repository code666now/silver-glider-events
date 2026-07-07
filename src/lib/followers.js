const crypto = require('crypto');

const SECRET = (process.env.SESSION_SECRET || '').trim();
if (!SECRET) throw new Error('SESSION_SECRET is required');

// Stateless signed unsubscribe token: base64url(organizerId:email).sig
function signOptout(organizerId, email) {
  const payload = Buffer.from(`${organizerId}:${email.toLowerCase()}`).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex').slice(0, 32);
  return `${payload}.${sig}`;
}

function verifyOptout(token) {
  if (!token) return null;
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex').slice(0, 32);
  if (sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const decoded = Buffer.from(payload, 'base64url').toString();
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  const organizerId = parseInt(decoded.slice(0, idx), 10);
  const email = decoded.slice(idx + 1);
  if (!Number.isFinite(organizerId) || !email) return null;
  return { organizerId, email };
}

module.exports = { signOptout, verifyOptout };
