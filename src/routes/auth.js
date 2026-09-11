const express = require('express');
const pool = require('../config/db');
const { sendMagicLink, sendVerificationCode } = require('../lib/mailer');
const { setSessionCookie, clearSessionCookie } = require('../lib/session');
const requireOrganizer = require('../middleware/requireOrganizer');
const requirePhotoAccess = require('../middleware/requirePhotoAccess');
const { findPublicHost, followHost } = require('../lib/host-follows');
const { linkOwnedRsvpForEvent, linkVerifiedRsvps } = require('../lib/account-rsvps');
const { attendeeCookieName, readCookie } = require('../lib/private-events');
const { ensureGuestIdentity } = require('../lib/guest-identity');
const {
  clearGuestSessionCookie,
  createGuestSession,
  readGuestSession,
  revokeGuestSession,
  revokeIdentityGuestSessions,
  setGuestSessionCookie
} = require('../lib/guest-session');
const { clearPhotoAccessCookie, setPhotoAccessCookie } = require('../lib/photo-access');
const {
  CODE_LENGTH,
  clearSignInRequestCookie,
  consumeCode,
  consumeLink,
  createSignInChallenge,
  maskEmail,
  peekLink,
  readSignInRequest,
  setSignInRequestCookie
} = require('../lib/sign-in-challenges');
const { createRateLimiter, clientIp } = require('../lib/rate-limit');
const { esc } = require('../lib/public-html');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function safeNext(value) {
  const next = String(value || '').trim();
  return next.startsWith('/') && !next.startsWith('//') ? next.slice(0, 700) : '';
}

// In-memory limits (single instance, reset on deploy — fine at this scale).
const RL_WINDOW_MS = 15 * 60 * 1000;
const emailRequestLimiter = createRateLimiter({
  windowMs: RL_WINDOW_MS,
  rules: [
    { name: 'email', max: 5, key: ({ email }) => email },   // one person shouldn't need many emails
    { name: 'ip', max: 20, key: ({ ip }) => ip }             // looser for shared office/NAT IPs
  ]
});
const codeAttemptLimiter = createRateLimiter({
  windowMs: RL_WINDOW_MS,
  rules: [{ name: 'ip', max: 30, key: ({ ip }) => ip }]
});
setInterval(() => {
  emailRequestLimiter.prune();
  codeAttemptLimiter.prune();
}, RL_WINDOW_MS).unref();

function limitEmailRequest(req, res, email) {
  const result = emailRequestLimiter.consume({ email, ip: clientIp(req) });
  if (result.allowed) return true;
  res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
  res.status(429).json({ error: 'Too many requests. Please wait a few minutes and try again.' });
  return false;
}

async function logEmail(email) {
  await pool.query(
    `INSERT INTO message_log (recipient, message_type, channel, status, sent_at)
     VALUES ($1, 'magic_link', 'email', 'sent', NOW())`,
    [email]
  );
}

// Emails one link + code and remembers, in this browser only, which request
// the code belongs to.
async function issueSignIn(res, { email, intent = 'sign_in', targetOrganizerId = null, returnPath = null, followHostName = '' }) {
  const { token, code, requestToken } = await createSignInChallenge(pool, {
    email, intent, targetOrganizerId, returnPath
  });
  const link = `${process.env.APP_URL}/auth/verify?token=${token}`;
  await sendMagicLink({ to: email, link, code, followHostName });
  await logEmail(email);
  setSignInRequestCookie(res, requestToken);
}

// POST /api/auth/magic-link — always responds ok (no email enumeration)
router.post('/api/auth/magic-link', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
    if (!limitEmailRequest(req, res, email)) return;

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
    await issueSignIn(res, { email, intent, targetOrganizerId, returnPath, followHostName });
    res.json({ ok: true, codeLength: CODE_LENGTH });
  } catch (err) {
    next(err);
  }
});

// A remembered RSVP can become a creator without re-entering an email. The
// emailed link or code remains the authentication boundary.
router.post('/api/auth/guest-magic-link', async (req, res, next) => {
  try {
    const guest = await readGuestSession(pool, req, { touch: true });
    if (!guest) return res.status(401).json({ error: 'This browser is no longer recognized' });
    const email = String(guest.email || '').trim().toLowerCase();
    if (!limitEmailRequest(req, res, email)) return;
    await issueSignIn(res, { email, returnPath: safeNext(req.body?.next) });
    res.json({ ok: true, maskedEmail: maskEmail(email), codeLength: CODE_LENGTH });
  } catch (error) { next(error); }
});

// POST /api/auth/guest-code — Luma-style "confirm it's you" for the public RSVP
// flow. Emails a code only (the guest is on the page that asked). Proving the
// email upgrades this browser's remembered guest; it never creates an account
// session. `remembered: true` targets the email this browser already knows.
router.post('/api/auth/guest-code', async (req, res, next) => {
  try {
    let email;
    if (req.body?.remembered === true) {
      const guest = await readGuestSession(pool, req, { touch: true });
      if (!guest) return res.status(401).json({ error: 'This browser is no longer recognized. Enter your name and email again.' });
      email = String(guest.email || '').trim().toLowerCase();
    } else {
      email = String(req.body?.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
    }
    if (!limitEmailRequest(req, res, email)) return;
    const { code, requestToken } = await createSignInChallenge(pool, {
      email, intent: 'verify_guest', returnPath: safeNext(req.body?.next)
    });
    await sendVerificationCode({ to: email, code });
    await logEmail(email);
    setSignInRequestCookie(res, requestToken);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, maskedEmail: maskEmail(email), codeLength: CODE_LENGTH });
  } catch (error) { next(error); }
});

function displayNameParts(value, email) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  const fallback = String(email || '').split('@')[0] || 'there';
  const full = (name || fallback).slice(0, 160);
  return { full, first: full.split(' ')[0].slice(0, 80) || 'there' };
}

// Finishes a consumed link or code. Database work happens on `client` inside
// the caller's transaction; cookies are applied only after COMMIT through
// `afterCommit(res)`.
async function completeChallenge(client, req, pending) {
  const email = pending.email;

  if (pending.intent === 'verify_guest') {
    const identity = await ensureGuestIdentity(client, { email, displayName: '' });
    await linkVerifiedRsvps(client, identity.id, email);
    const current = await readGuestSession(client, req);
    let displayName = current && Number(current.identity_id) === Number(identity.id) ? current.display_name : '';
    if (!displayName) {
      const { rows } = await client.query(
        `SELECT first_name, last_name FROM rsvps WHERE LOWER(email)=LOWER($1) ORDER BY id DESC LIMIT 1`,
        [email]
      );
      displayName = rows[0] ? `${rows[0].first_name || ''} ${rows[0].last_name || ''}` : identity.name;
    }
    const names = displayNameParts(displayName, email);
    if (current) await revokeGuestSession(client, req);
    const session = await createGuestSession(client, {
      identityId: identity.id,
      displayFirstName: names.first,
      displayName: names.full,
      verified: true
    });
    return {
      kind: 'guest',
      firstName: names.first,
      redirect: safeNext(pending.return_path) || null,
      afterCommit: res => setGuestSessionCookie(res, session.token)
    };
  }

  if (pending.intent === 'add_photo') {
    let identity = (await client.query(
      'SELECT id FROM organizers WHERE LOWER(email)=LOWER($1)', [email]
    )).rows[0];
    if (!identity) identity = await ensureGuestIdentity(client, { email, displayName: '' });
    await linkVerifiedRsvps(client, identity.id, email);
    const alreadySignedIn = Number(req.sessionAccount?.id) === Number(identity.id);
    return {
      kind: 'photo',
      redirect: safeNext(pending.return_path) || '/add-photo',
      afterCommit: res => { if (!alreadySignedIn) setPhotoAccessCookie(res, identity.id); }
    };
  }

  let organizer = (await client.query('SELECT * FROM organizers WHERE LOWER(email)=LOWER($1)', [email])).rows[0];
  if (organizer) {
    await client.query('UPDATE organizers SET last_login_at=NOW() WHERE id=$1', [organizer.id]);
  } else {
    organizer = (await client.query(
      'INSERT INTO organizers (email, last_login_at) VALUES ($1, NOW()) RETURNING *', [email]
    )).rows[0];
  }

  // Reaching this point proves control of the email. Historical email-only
  // RSVPs may now safely use this account's current avatar.
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

  return {
    kind: 'account',
    redirect: safeNext(pending.return_path) || null,
    afterCommit: res => {
      clearPhotoAccessCookie(res);
      setSessionCookie(res, organizer.id);
    }
  };
}

function continuePageCopy(pending, hostName) {
  const masked = esc(maskEmail(pending.email));
  if (pending.intent === 'follow_host' && hostName) {
    return {
      title: `Follow ${esc(hostName)}`,
      body: `Confirm it’s you (${masked}) to follow ${esc(hostName)} on Silver Glider Events.`,
      button: `Follow ${esc(hostName)}`
    };
  }
  if (pending.intent === 'add_photo') {
    return {
      title: 'Add your photo',
      body: `Confirm it’s you (${masked}) to add a photo friends will recognize.`,
      button: 'Continue'
    };
  }
  return {
    title: 'Continue to Silver Glider Events',
    body: `You’re signing in as ${masked}.`,
    button: 'Continue'
  };
}

function continuePage({ copy, token, next }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Continue — Silver Glider Events</title>
<link rel="stylesheet" href="/css/brand.css"><script src="/js/legal-footer.js" defer></script></head>
<body><div class="sg-aurora" aria-hidden="true"></div><div class="sg-aurora-veil" aria-hidden="true"></div>
<main style="max-width:400px;margin:0 auto;padding:12vh 24px 0">
<p class="sg-label" style="margin-bottom:28px">Silver Glider Events</p>
<h1 style="font-size:32px;margin-bottom:10px">${copy.title}</h1>
<p style="color:var(--sg-text-dim);font-size:15px;line-height:1.7;margin-bottom:28px">${copy.body}</p>
<form method="POST" action="/auth/verify">
<input type="hidden" name="token" value="${esc(token)}">
${next ? `<input type="hidden" name="next" value="${esc(next)}">` : ''}
<button class="sg-btn sg-btn-primary sg-btn-block" type="submit" autofocus>${copy.button}</button>
</form>
<p style="color:var(--sg-text-faint);font-size:13px;margin-top:24px">Didn’t request this? You can close this page.</p>
</main></body></html>`;
}

function expiredRedirect(next) {
  return `/login?error=expired${next ? `&next=${encodeURIComponent(next)}` : ''}`;
}

// GET /auth/verify?token= — read-only. Email security scanners open every
// link in a message; using the token up here would leave the real person with
// "expired". Only the Continue button (POST) signs in.
router.get('/auth/verify', async (req, res, next) => {
  try {
    const token = String(req.query.token || '').trim();
    const legacyNext = safeNext(req.query.next);
    const pending = await peekLink(pool, token);
    if (!pending) {
      // An old or already-used link from someone who is already signed in.
      if (req.sessionAccount) return res.redirect(legacyNext || '/dashboard');
      return res.redirect(expiredRedirect(legacyNext));
    }
    let hostName = '';
    if (pending.intent === 'follow_host' && pending.target_organizer_id) {
      const { rows } = await pool.query('SELECT org_name FROM organizers WHERE id=$1', [pending.target_organizer_id]);
      hostName = rows[0]?.org_name || '';
    }
    res.setHeader('Cache-Control', 'private, no-store');
    // same-origin, not no-referrer: the token-bearing URL still never leaves
    // the site, but no-referrer would make browsers send `Origin: null` on the
    // Continue POST and fail the same-origin check below.
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.type('html').send(continuePage({ copy: continuePageCopy(pending, hostName), token, next: legacyNext }));
  } catch (err) { next(err); }
});

// Blocks login CSRF: another site must not be able to POST a token for the
// attacker's own account into a victim's browser. Modern browsers say where a
// request came from in Sec-Fetch-Site; older ones only send Origin.
function sameOriginPost(req) {
  const site = req.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.get('origin');
  if (!origin || origin === 'null') return true;
  let originHost;
  try { originHost = new URL(origin).host; } catch (_) { return false; }
  const allowed = [req.get('host'), req.get('x-forwarded-host')];
  try { allowed.push(new URL(process.env.APP_URL).host); } catch (_) {}
  return allowed.filter(Boolean).includes(originHost);
}

// POST /auth/verify — the Continue button. Uses the link up and signs in.
router.post('/auth/verify', async (req, res, next) => {
  if (!sameOriginPost(req)) return res.status(403).send('Forbidden');
  const token = String(req.body?.token || '').trim();
  const legacyNext = safeNext(req.body?.next);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pending = await consumeLink(client, token);
    if (!pending) {
      await client.query('ROLLBACK');
      if (req.sessionAccount) return res.redirect(303, legacyNext || '/dashboard');
      return res.redirect(303, expiredRedirect(legacyNext));
    }
    const outcome = await completeChallenge(client, req, pending);
    await client.query('COMMIT');
    outcome.afterCommit(res);
    clearSignInRequestCookie(res);
    const fallback = outcome.kind === 'guest' ? '/' : '/dashboard';
    res.redirect(303, outcome.redirect || legacyNext || fallback);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

const CODE_ERRORS = {
  expired: 'That code has expired. Request a new one.',
  invalid: 'That code isn’t right. Check the email and try again.',
  locked: 'Too many incorrect codes. Request a new one.'
};

// POST /api/auth/verify-code — the 6-digit code, typed into the browser that
// requested it. Works for sign-in, follows, and RSVP guest verification.
router.post('/api/auth/verify-code', async (req, res, next) => {
  const rate = codeAttemptLimiter.consume({ ip: clientIp(req) });
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)));
    return res.status(429).json({ error: 'too_many_attempts', message: 'Too many attempts. Wait a few minutes and try again.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await consumeCode(client, readSignInRequest(req), req.body?.code);
    if (result.error) {
      await client.query('COMMIT'); // keep the attempt count
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(400).json({ error: result.error, message: CODE_ERRORS[result.error], remaining: result.remaining });
    }
    const outcome = await completeChallenge(client, req, result.pending);
    await client.query('COMMIT');
    outcome.afterCommit(res);
    clearSignInRequestCookie(res);
    res.setHeader('Cache-Control', 'private, no-store');
    const fallback = outcome.kind === 'account' ? '/dashboard' : null;
    res.json({
      ok: true,
      kind: outcome.kind,
      firstName: outcome.firstName || null,
      redirect: outcome.redirect || fallback
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// Signing out forgets everything this browser holds: the account session, the
// remembered guest (so a shared laptop stops greeting the last person), and
// any photo-only grant.
router.post('/api/auth/logout', async (req, res, next) => {
  try {
    await revokeGuestSession(pool, req);
    clearSessionCookie(res);
    clearGuestSessionCookie(res);
    clearPhotoAccessCookie(res);
    clearSignInRequestCookie(res);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Rejects every account cookie issued before now, on every device, and ends
// every remembered-guest browser and unused sign-in link for this email.
router.post('/api/auth/logout-all', requireOrganizer, async (req, res, next) => {
  try {
    await pool.query('UPDATE organizers SET sessions_valid_after=$2 WHERE id=$1', [req.organizer.id, new Date()]);
    await revokeIdentityGuestSessions(pool, req.organizer.id);
    await pool.query(
      'UPDATE magic_link_tokens SET used_at=NOW() WHERE LOWER(email)=LOWER($1) AND used_at IS NULL',
      [req.organizer.email]
    );
    clearSessionCookie(res);
    clearGuestSessionCookie(res);
    clearPhotoAccessCookie(res);
    res.json({ ok: true });
  } catch (err) { next(err); }
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

// Also answers for a photo-only grant, which the Add Photo page needs; `scope`
// tells the page not to render account navigation.
router.get('/api/me', requirePhotoAccess, (req, res) => {
  const { id, email, name, avatar_url } = req.organizer;
  res.json({
    user: { id, email, name, avatarUrl: avatar_url || null },
    scope: req.photoAccessOnly ? 'photo' : 'account'
  });
});

router.post('/api/me/link-rsvps', requireOrganizer, async (req, res, next) => {
  try {
    const eventSlug = String(req.body?.eventSlug || '').trim().slice(0, 180);
    let linked;
    if (eventSlug) {
      const { rows } = await pool.query('SELECT id FROM events WHERE slug=$1', [eventSlug]);
      if (!rows.length) return res.json({ ok: true, linked: 0 });
      const eventId = rows[0].id;
      const attendeeToken = readCookie(req, attendeeCookieName(eventId));
      linked = await linkOwnedRsvpForEvent(
        pool,
        req.organizer.id,
        req.organizer.email,
        eventId,
        attendeeToken
      );
    } else {
      linked = await linkVerifiedRsvps(pool, req.organizer.id, req.organizer.email);
    }
    res.json({ ok: true, linked });
  } catch (err) { next(err); }
});

router.patch('/api/me/profile', requireOrganizer, async (req, res, next) => {
  const body = req.body || {};
  const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
  const hasAvatar = Object.prototype.hasOwnProperty.call(body, 'avatarUrl');
  if (!hasName && !hasAvatar) return res.status(400).json({ error: 'Choose a profile field to update' });
  if (hasAvatar && body.avatarUrl !== null) {
    return res.status(400).json({ error: 'Upload a photo or set avatarUrl to null' });
  }
  const name = hasName ? (String(body.name ?? '').trim().slice(0, 100) || null) : req.organizer.name;
  try {
    const { rows } = await pool.query(
      `UPDATE organizers
          SET name=$2,
              avatar_url=CASE WHEN $3 THEN NULL ELSE avatar_url END,
              updated_at=NOW()
        WHERE id=$1
       RETURNING id, email, name, avatar_url, org_name, public_slug, logo_url, header_image_url,
                 bio, website_url, instagram_handle, instagram_url, contact_email,
                 plan, is_admin, created_at, updated_at`,
      [req.organizer.id, name, hasAvatar]
    );
    const organizer = rows[0];
    res.json({
      user: {
        id: organizer.id,
        email: organizer.email,
        name: organizer.name,
        avatarUrl: organizer.avatar_url || null
      },
      organizer
    });
  } catch (err) { next(err); }
});

// Test-only: the in-memory limiters are process-wide.
router.resetRateLimitsForTests = () => {
  emailRequestLimiter.reset();
  codeAttemptLimiter.reset();
};

module.exports = router;
