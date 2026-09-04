const express = require('express');
const crypto = require('crypto');
const pool = require('../config/db');
const { sendMagicLink } = require('../lib/mailer');
const { setSessionCookie, clearSessionCookie } = require('../lib/session');
const requireOrganizer = require('../middleware/requireOrganizer');
const { findPublicHost, followHost } = require('../lib/host-follows');
const { linkVerifiedRsvps } = require('../lib/account-rsvps');

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
    const requestedIntent = String(req.body.intent || '').trim();
    const intent = requestedIntent === 'follow_host' ? 'follow_host' : 'sign_in';
    let targetOrganizerId = null;
    let returnPath = safeNext(req.body.next);
    let followHostName = '';
    if (intent === 'follow_host') {
      const host = await findPublicHost(pool, req.body.host_slug);
      if (!host) return res.status(404).json({ error: 'Host Page not found' });
      targetOrganizerId = host.id;
      followHostName = host.org_name;
      returnPath = `/h/${encodeURIComponent(host.public_slug)}`;
    }
    await pool.query(
      `INSERT INTO magic_link_tokens
         (token, email, expires_at, intent, target_organizer_id, return_path)
       VALUES ($1, $2, NOW() + INTERVAL '15 minutes', $3, $4, $5)`,
      [token, email, intent, targetOrganizerId, returnPath || null]
    );
    const link = `${process.env.APP_URL}/auth/verify?token=${token}`;
    await sendMagicLink({ to: email, link, followHostName });
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
  const client = await pool.connect();
  try {
    const token = String(req.query.token || '').trim();
    if (!token) {
      return res.redirect('/login?error=expired');
    }

    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE magic_link_tokens SET used_at=NOW()
       WHERE token=$1 AND used_at IS NULL AND expires_at > NOW()
       RETURNING email, intent, target_organizer_id, return_path`,
      [token]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.redirect('/login?error=expired');
    }
    const pending = rows[0];
    const email = pending.email;

    let organizer = (await client.query('SELECT * FROM organizers WHERE LOWER(email)=LOWER($1)', [email])).rows[0];
    if (organizer) {
      await client.query('UPDATE organizers SET last_login_at=NOW() WHERE id=$1', [organizer.id]);
    } else {
      organizer = (await client.query(
        'INSERT INTO organizers (email, last_login_at) VALUES ($1, NOW()) RETURNING *', [email]
      )).rows[0];
    }

    // Reaching this point proves control of the magic-link email. Historical
    // email-only RSVPs may now safely use this account's current avatar.
    await linkVerifiedRsvps(client, organizer.id, email);

    if (pending.intent === 'follow_host') {
      const { rows: targetRows } = await client.query(
        `SELECT id FROM organizers
          WHERE id=$1 AND org_name IS NOT NULL AND public_slug IS NOT NULL`,
        [pending.target_organizer_id]
      );
      if (!targetRows.length) throw new Error('Follow target is no longer available');
      if (Number(organizer.id) !== Number(pending.target_organizer_id)) {
        await followHost(client, organizer.id, pending.target_organizer_id);
      }
    }

    await client.query('COMMIT');
    setSessionCookie(res, organizer.id);
    const storedReturn = safeNext(pending.return_path);
    const legacyReturn = safeNext(req.query.next);
    res.redirect(storedReturn || legacyReturn || '/dashboard');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/api/auth/me', requireOrganizer, (req, res) => {
  const {
    id, email, name, avatar_url, org_name, public_slug, logo_url, header_image_url,
    bio, website_url, instagram_handle, instagram_url, contact_email,
    plan, is_admin, created_at, updated_at
  } = req.organizer;
  res.json({
    organizer: {
      id, email, name, avatar_url, org_name, public_slug, logo_url, header_image_url,
      bio, website_url, instagram_handle, instagram_url, contact_email,
      plan, is_admin, created_at, updated_at
    }
  });
});

router.get('/api/me', requireOrganizer, (req, res) => {
  const { id, email, name, avatar_url } = req.organizer;
  res.json({ user: { id, email, name, avatarUrl: avatar_url || null } });
});

router.post('/api/me/link-rsvps', requireOrganizer, async (req, res, next) => {
  try {
    const linked = await linkVerifiedRsvps(pool, req.organizer.id, req.organizer.email);
    res.json({ ok: true, linked });
  } catch (err) { next(err); }
});

router.patch('/api/me/profile', requireOrganizer, async (req, res, next) => {
  if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'avatarUrl') || req.body.avatarUrl !== null) {
    return res.status(400).json({ error: 'Upload a photo or set avatarUrl to null' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE organizers SET avatar_url=NULL, updated_at=NOW() WHERE id=$1
       RETURNING id, email, name, avatar_url, org_name, public_slug, logo_url, header_image_url,
                 bio, website_url, instagram_handle, instagram_url, contact_email,
                 plan, is_admin, created_at, updated_at`,
      [req.organizer.id]
    );
    const organizer = rows[0];
    res.json({
      user: { id: organizer.id, email: organizer.email, name: organizer.name, avatarUrl: null },
      organizer
    });
  } catch (err) { next(err); }
});

module.exports = router;
