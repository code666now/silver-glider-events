const express = require('express');
const crypto = require('crypto');
const pool = require('../config/db');
const { sendMagicLink } = require('../lib/mailer');
const { setSessionCookie, clearSessionCookie } = require('../lib/session');
const requireOrganizer = require('../middleware/requireOrganizer');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function safeNext(value) {
  const next = String(value || '').trim();
  return next.startsWith('/') && !next.startsWith('//') ? next.slice(0, 700) : '';
}

// In-memory rate limiter for magic-link requests (per email + per IP).
// Single-instance / best-effort — resets on deploy, which is fine at this scale.
const RL_WINDOW_MS = 15 * 60 * 1000;
const RL_MAX_EMAIL = 5;   // one person shouldn't need many links in 15 min
const RL_MAX_IP = 20;     // looser, so shared office/NAT IPs don't block each other
const rlHits = new Map();
function overLimit(key, max) {
  const now = Date.now();
  const recent = (rlHits.get(key) || []).filter(t => now - t < RL_WINDOW_MS);
  recent.push(now);
  rlHits.set(key, recent);
  return recent.length > max;
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';
}
// Occasionally prune stale keys so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of rlHits) {
    if (!arr.some(t => now - t < RL_WINDOW_MS)) rlHits.delete(k);
  }
}, RL_WINDOW_MS).unref();

// POST /api/auth/magic-link — always responds ok (no email enumeration)
router.post('/api/auth/magic-link', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email' });

    if (overLimit('email:' + email, RL_MAX_EMAIL) || overLimit('ip:' + clientIp(req), RL_MAX_IP)) {
      return res.status(429).json({ error: 'Too many requests. Please wait a few minutes and try again.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const nextPath = safeNext(req.body.next);
    await pool.query(
      `INSERT INTO magic_link_tokens (token, email, expires_at) VALUES ($1, $2, NOW() + INTERVAL '15 minutes')`,
      [token, email]
    );
    const link = `${process.env.APP_URL}/auth/verify?token=${token}${nextPath ? `&next=${encodeURIComponent(nextPath)}` : ''}`;
    await sendMagicLink({ to: email, link });
    await pool.query(
      `INSERT INTO message_log (recipient, message_type, channel, status, sent_at) VALUES ($1, 'magic_link', 'email', 'sent', NOW())`,
      [email]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /auth/verify?token= — burn token, upsert organizer, set cookie
router.get('/auth/verify', async (req, res, next) => {
  try {
    const token = String(req.query.token || '').trim();
    if (!token) return res.redirect('/login?error=expired');

    const { rows } = await pool.query(
      `UPDATE magic_link_tokens SET used_at=NOW()
       WHERE token=$1 AND used_at IS NULL AND expires_at > NOW()
       RETURNING email`,
      [token]
    );
    if (!rows.length) return res.redirect('/login?error=expired');
    const email = rows[0].email;

    let organizer = (await pool.query('SELECT * FROM organizers WHERE LOWER(email)=LOWER($1)', [email])).rows[0];
    if (organizer) {
      await pool.query('UPDATE organizers SET last_login_at=NOW() WHERE id=$1', [organizer.id]);
    } else {
      organizer = (await pool.query(
        'INSERT INTO organizers (email, last_login_at) VALUES ($1, NOW()) RETURNING *', [email]
      )).rows[0];
    }

    setSessionCookie(res, organizer.id);
    res.redirect(safeNext(req.query.next) || '/dashboard');
  } catch (err) {
    next(err);
  }
});

router.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/api/auth/me', requireOrganizer, (req, res) => {
  const { id, email, name, org_name, public_slug, logo_url, plan, is_admin, created_at } = req.organizer;
  res.json({ organizer: { id, email, name, org_name, public_slug, logo_url, plan, is_admin, created_at } });
});

module.exports = router;
