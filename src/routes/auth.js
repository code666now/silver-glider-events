const express = require('express');
const pool = require('../config/db');
const { sendMagicLink, sendVerificationCode, sendAccountVerificationCode } = require('../lib/mailer');
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
const sms = require('../lib/sms');
const phoneVerification = require('../lib/phone-verification');
const {
  attachIdentity,
  attachVerifiedPhoneIdentity,
  CanonicalIdentityError,
  CanonicalIdentityConflictError,
  IDENTITY_TYPES,
  normalizeEmail,
  resolveOrCreateOrganizerByEmail,
  resolveVerifiedPhoneIdentity
} = require('../lib/canonical-identity');
const {
  listAccountIdentities,
  makePrimaryEmail,
  recordOwnershipConflict,
  removeAccountIdentity,
  replaceVerifiedPhone
} = require('../lib/account-identities');
const {
  clearIdentityStepUpCookie,
  hasIdentityStepUp,
  setIdentityStepUpCookie
} = require('../lib/identity-step-up');
const {
  CODE_LENGTH: PHONE_CODE_LENGTH,
  PhoneAuthError,
  bindVerifiedPhone,
  cancelPhoneChallenge,
  clearPhoneAuthCookie,
  createPhoneChallenge,
  markPhoneChallengeVerified,
  maskPhone,
  readPhoneChallenge,
  setPhoneAuthCookie
} = require('../lib/phone-auth');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function safeNext(value) {
  const next = String(value || '').trim();
  return next.startsWith('/') && !next.startsWith('//') ? next.slice(0, 700) : '';
}

// Phone-first auth is intentionally reserved for the high-intent creator
// journey. Guest RSVP, Follow Host, photo links, and ordinary account login
// keep their existing email-first boundaries.
function creatorNext(value) {
  const next = safeNext(value);
  return next === '/events/new' || next.startsWith('/events/new?') ? next : '';
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
const phoneRequestLimiter = createRateLimiter({
  windowMs: RL_WINDOW_MS,
  rules: [
    { name: 'phone', max: 4, key: ({ phone }) => phone },
    { name: 'ip', max: 12, key: ({ ip }) => ip }
  ]
});
const phoneCodeAttemptLimiter = createRateLimiter({
  windowMs: RL_WINDOW_MS,
  rules: [{ name: 'ip', max: 30, key: ({ ip }) => ip }]
});
const phoneEmailLimiter = createRateLimiter({
  windowMs: RL_WINDOW_MS,
  rules: [
    { name: 'phone-email', max: 4, key: ({ email }) => email },
    { name: 'phone', max: 5, key: ({ phone }) => phone },
    { name: 'ip', max: 20, key: ({ ip }) => ip }
  ]
});
setInterval(() => {
  emailRequestLimiter.prune();
  codeAttemptLimiter.prune();
  phoneRequestLimiter.prune();
  phoneCodeAttemptLimiter.prune();
  phoneEmailLimiter.prune();
}, RL_WINDOW_MS).unref();

function limitEmailRequest(req, res, email) {
  const result = emailRequestLimiter.consume({ email, ip: clientIp(req) });
  if (result.allowed) return true;
  res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
  res.status(429).json({ error: 'Too many requests. Please wait a few minutes and try again.' });
  return false;
}

async function logEmail(email, recipientUserId = null) {
  await pool.query(
    `INSERT INTO message_log
       (recipient,recipient_user_id,message_type,channel,status,sent_at)
     VALUES ($1,$2,'magic_link','email','sent',NOW())`,
    [email, recipientUserId]
  );
}

async function accountIdentityState(req) {
  const userId = Number(req.organizer.user_id || req.organizer.id);
  return {
    identities: await listAccountIdentities(pool, userId),
    capabilities: {
      canAddPhone: !req.organizer.is_admin,
      identityStepUpVerified: hasIdentityStepUp(req, userId),
      phoneLimit: 1
    }
  };
}

function phoneError(res, error) {
  const safe = error instanceof PhoneAuthError ||
    error instanceof CanonicalIdentityError ||
    error instanceof phoneVerification.PhoneVerificationError ||
    error instanceof sms.SmsDeliveryError;
  if (!safe) return false;
  res.status(error.status || 400).json({
    error: error.code || 'phone_auth_error',
    message: error.message || 'Phone sign-in could not be completed'
  });
  return true;
}

function requireIdentityStepUp(req, res, next) {
  const userId = req.organizer?.user_id || req.organizer?.id;
  if (hasIdentityStepUp(req, userId)) return next();
  return res.status(403).json({
    error: 'identity_step_up_required',
    message: 'Confirm your current email before changing sign-in methods.'
  });
}

function waitForMinimum(startedAt, minimumMs = 650) {
  const remaining = minimumMs - (Date.now() - startedAt);
  return remaining > 0 ? new Promise(resolve => setTimeout(resolve, remaining)) : Promise.resolve();
}

function phoneStartProviderError(error) {
  return error instanceof phoneVerification.PhoneVerificationError;
}

function limitPhoneEmailRequest(req, res, { email, phone }) {
  const result = phoneEmailLimiter.consume({ email, phone, ip: clientIp(req) });
  if (result.allowed) return true;
  res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
  res.status(429).json({
    error: 'too_many_phone_email_requests',
    message: 'Too many requests. Wait a few minutes and try again.'
  });
  return false;
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

async function signInIntent(body = {}) {
  body = body && typeof body === 'object' ? body : {};
  const requestedIntent = String(body.intent || '').trim();
  const intent = requestedIntent === 'follow_host' ? 'follow_host' : 'sign_in';
  let targetOrganizerId = null;
  let returnPath = safeNext(body.next);
  let followHostName = '';
  if (intent === 'follow_host') {
    const host = await findPublicHost(pool, body.host_slug);
    if (!host) return null;
    targetOrganizerId = host.id;
    followHostName = host.org_name;
    returnPath = `/h/${encodeURIComponent(host.public_slug)}?followed=1`;
  }
  return { intent, targetOrganizerId, returnPath, followHostName };
}

// POST /api/auth/magic-link — always responds ok (no email enumeration)
router.post('/api/auth/magic-link', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
    if (!limitEmailRequest(req, res, email)) return;

    const challenge = await signInIntent(req.body);
    if (!challenge) return res.status(404).json({ error: 'Host Page not found' });
    await issueSignIn(res, { email, ...challenge });
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
    const challenge = await signInIntent(req.body);
    if (!challenge) return res.status(404).json({ error: 'Host Page not found' });
    await issueSignIn(res, { email, ...challenge });
    res.json({ ok: true, maskedEmail: maskEmail(email), codeLength: CODE_LENGTH });
  } catch (error) { next(error); }
});

// POST /api/auth/guest-code — Luma-style "confirm it's you" for the public RSVP
// flow. Emails a code only (the guest is on the page that asked). Proving the
// email upgrades this browser's remembered guest and, when the code is typed,
// establishes the normal account session. `remembered: true` targets the email
// this browser already knows.
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

// Creator-only phone-first entry. Twilio Verify proves both new and returning
// phones so authentication never shares a sender with lifecycle/marketing SMS.
// The response deliberately does not reveal whether the phone exists.
router.post('/api/auth/phone/start', async (req, res, next) => {
  if (!sameOriginPost(req)) return res.status(403).json({ error: 'forbidden' });
  const startedAt = Date.now();
  let phone;
  try {
    const returnPath = creatorNext(req.body?.next);
    if (!returnPath) {
      return res.status(400).json({
        error: 'creator_phone_auth_only',
        message: 'Phone sign-in is available when creating an event.'
      });
    }
    phone = sms.normalizeE164(req.body?.phone);
    const rate = phoneRequestLimiter.consume({ phone, ip: clientIp(req) });
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)));
      return res.status(429).json({
        error: 'too_many_phone_requests',
        message: 'Too many requests. Wait a few minutes and try again.'
      });
    }

    const resolvedPhone = await resolveVerifiedPhoneIdentity(pool, { phone });
    const verification = await phoneVerification.startVerification(phone);
    const returningOrganizerId = resolvedPhone
      ? Number(resolvedPhone.identity.user_id)
      : null;
    const challenge = await createPhoneChallenge(pool, {
      phone,
      purpose: returningOrganizerId ? 'sign_in' : 'enroll',
      organizerId: returningOrganizerId,
      providerSid: verification.verificationSid,
      returnPath
    });

    setPhoneAuthCookie(res, challenge.requestToken);
    res.setHeader('Cache-Control', 'private, no-store');
    await waitForMinimum(startedAt);
    res.json({ ok: true, codeLength: PHONE_CODE_LENGTH });
  } catch (error) {
    if (phoneStartProviderError(error) || error instanceof CanonicalIdentityError) {
      if (error instanceof CanonicalIdentityError) {
        console.error('[auth:phone-start] canonical identity resolution failed:', error.code);
      }
      await waitForMinimum(startedAt);
      return res.status(503).json({
        error: 'phone_code_unavailable',
        message: 'We couldn’t send a code. Try again or use email.'
      });
    }
    if (!phoneError(res, error)) next(error);
  }
});

router.post('/api/auth/phone/verify', async (req, res, next) => {
  if (!sameOriginPost(req)) return res.status(403).json({ error: 'forbidden' });
  const rate = phoneCodeAttemptLimiter.consume({ ip: clientIp(req) });
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)));
    return res.status(429).json({
      error: 'too_many_attempts',
      message: 'Too many attempts. Wait a few minutes and try again.'
    });
  }

  let challenge;
  try {
    challenge = await readPhoneChallenge(pool, req);
    if (!challenge) {
      throw new PhoneAuthError('That code has expired. Request a new one.', {
        code: 'phone_verification_expired', status: 400
      });
    }

    const verification = await phoneVerification.checkVerification({
      verificationSid: challenge.provider_sid,
      code: req.body?.code
    });
    if (!verification.phone || verification.phone !== challenge.phone_e164) {
      throw new PhoneAuthError('Phone verification could not be completed.', {
        code: 'phone_verification_mismatch', status: 400
      });
    }

    if (challenge.purpose === 'sign_in') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await readPhoneChallenge(client, req, { forUpdate: true });
        if (!locked || Number(locked.id) !== Number(challenge.id) || locked.purpose !== 'sign_in' ||
            locked.provider_sid !== verification.verificationSid) {
          throw new PhoneAuthError('Phone verification expired. Start again.', {
            code: 'phone_verification_expired', status: 400
          });
        }
        const canonicalPhone = await resolveVerifiedPhoneIdentity(client, {
          phone: locked.phone_e164
        });
        if (!canonicalPhone || Number(canonicalPhone.identity.user_id) !== Number(locked.organizer_id)) {
          throw new PhoneAuthError('This phone sign-in is no longer available. Use email instead.', {
            code: 'phone_credential_unavailable', status: 400
          });
        }
        const { rows } = await client.query(
          `SELECT account.id,account.is_admin
             FROM organizers account
            WHERE account.id=$1
            FOR UPDATE`,
          [locked.organizer_id]
        );
        const account = rows[0];
        if (!account) {
          throw new PhoneAuthError('This phone sign-in is no longer available. Use email instead.', {
            code: 'phone_credential_unavailable', status: 400
          });
        }
        if (account.is_admin) {
          await client.query('UPDATE phone_auth_challenges SET used_at=NOW() WHERE id=$1', [locked.id]);
          await client.query('COMMIT');
          clearPhoneAuthCookie(res);
          res.setHeader('Cache-Control', 'private, no-store');
          return res.status(403).json({
            error: 'email_sign_in_required',
            message: 'For account security, sign in with email.'
          });
        }
        // Canonical identity is authoritative. Repair the legacy compatibility
        // credential after possession is proved so a partially migrated row
        // cannot receive an OTP and then fail only at completion.
        await attachVerifiedPhoneIdentity(client, {
          userId: account.id,
          phone: locked.phone_e164,
          verifiedAt: new Date(),
          verificationSource: 'twilio_verify_sign_in'
        });
        await client.query('UPDATE organizers SET last_login_at=NOW() WHERE id=$1', [account.id]);
        await client.query(
          `UPDATE account_phone_credentials SET last_used_at=NOW(),updated_at=NOW()
            WHERE organizer_id=$1 AND phone_e164=$2 AND revoked_at IS NULL`,
          [account.id, locked.phone_e164]
        );
        await client.query('UPDATE phone_auth_challenges SET used_at=NOW() WHERE id=$1', [locked.id]);
        await client.query('COMMIT');
        clearPhoneAuthCookie(res);
        clearPhotoAccessCookie(res);
        setSessionCookie(res, account.id);
        setIdentityStepUpCookie(res, account.id);
        res.setHeader('Cache-Control', 'private, no-store');
        return res.json({ ok: true, redirect: creatorNext(locked.return_path) || '/events/new' });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await readPhoneChallenge(client, req, { forUpdate: true });
      if (!locked || Number(locked.id) !== Number(challenge.id) || locked.purpose !== 'enroll' ||
          locked.provider_sid !== verification.verificationSid) {
        throw new PhoneAuthError('Phone verification expired. Start again.', {
          code: 'phone_verification_expired', status: 400
        });
      }
      const verified = await markPhoneChallengeVerified(client, locked.id);
      if (!verified) {
        throw new PhoneAuthError('Phone verification expired. Start again.', {
          code: 'phone_verification_expired', status: 400
        });
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, needsEmail: true, maskedPhone: maskPhone(challenge.phone_e164) });
  } catch (error) {
    if (!phoneError(res, error)) next(error);
  }
});

// A verified phone alone never claims an email identity. The inbox code is
// mandatory on first binding, including when that email already has RSVPs,
// events, credits, or administrative access.
router.post('/api/auth/phone/email', async (req, res, next) => {
  if (!sameOriginPost(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
    const challenge = await readPhoneChallenge(pool, req);
    if (!challenge || challenge.purpose !== 'enroll' || !challenge.verified_at) {
      throw new PhoneAuthError('Verify your phone before adding your email.', {
        code: 'phone_verification_required', status: 400
      });
    }
    if (!limitPhoneEmailRequest(req, res, { email, phone: challenge.phone_e164 })) return;
    const { rows: extendedRows } = await pool.query(
      `UPDATE phone_auth_challenges
          SET expires_at=GREATEST(expires_at,NOW() + INTERVAL '20 minutes')
        WHERE id=$1 AND purpose='enroll' AND verified_at IS NOT NULL
          AND used_at IS NULL AND expires_at > NOW()
        RETURNING id`,
      [challenge.id]
    );
    if (!extendedRows.length) {
      throw new PhoneAuthError('Phone verification expired. Start again.', {
        code: 'phone_verification_expired', status: 400
      });
    }
    const { code, requestToken } = await createSignInChallenge(pool, {
      email,
      intent: 'bind_phone',
      returnPath: creatorNext(challenge.return_path) || '/events/new',
      phoneAuthChallengeId: challenge.id
    });
    await sendAccountVerificationCode({ to: email, code });
    await logEmail(email);
    setSignInRequestCookie(res, requestToken);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, maskedEmail: maskEmail(email), codeLength: CODE_LENGTH });
  } catch (error) {
    if (!phoneError(res, error)) next(error);
  }
});

router.post('/api/auth/phone/cancel', async (req, res, next) => {
  if (!sameOriginPost(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    await cancelPhoneChallenge(pool, req);
    clearPhoneAuthCookie(res);
    res.json({ ok: true });
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
async function completeChallenge(client, req, pending, {
  globalizeTypedGuestCode = false,
  emailProofSource = 'email_link'
} = {}) {
  const email = pending.email;

  if (pending.intent === 'identity_step_up') {
    const requestedUserId = Number(pending.requested_user_id);
    const signedInUserId = Number(req.sessionAccount?.user_id || req.sessionAccount?.id);
    if (!requestedUserId || !signedInUserId || requestedUserId !== signedInUserId) {
      throw new CanonicalIdentityError(
        'Sign in to the account that requested this confirmation.',
        { code: 'identity_session_mismatch', status: 401 }
      );
    }
    return {
      kind: 'identity_step_up',
      redirect: '/settings/account',
      afterCommit: res => setIdentityStepUpCookie(res, requestedUserId)
    };
  }

  if (pending.intent === 'attach_email') {
    const requestedUserId = Number(pending.requested_user_id);
    const signedInUserId = Number(req.sessionAccount?.user_id || req.sessionAccount?.id);
    if (!requestedUserId || !signedInUserId || requestedUserId !== signedInUserId) {
      throw new CanonicalIdentityError(
        'Sign in to the account that requested this email before entering the code.',
        { code: 'identity_session_mismatch', status: 401 }
      );
    }
    if (!hasIdentityStepUp(req, requestedUserId)) {
      throw new CanonicalIdentityError(
        'Confirm your current email before adding a new one.',
        { code: 'identity_step_up_required', status: 403 }
      );
    }
    const attached = await attachIdentity(client, {
      userId: requestedUserId,
      identityType: IDENTITY_TYPES.EMAIL,
      value: email,
      verifiedAt: new Date(),
      verificationScope: 'account',
      verificationSource: 'account_settings.email_code',
      sourceRecordId: Number(pending.id),
      isPrimary: false
    });
    return {
      kind: 'identity',
      identity: attached.identity,
      redirect: '/settings/account',
      afterCommit: () => {}
    };
  }

  if (pending.intent === 'verify_guest') {
    let identity = await ensureGuestIdentity(client, { email, displayName: '' });
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
    if (globalizeTypedGuestCode) {
      const canonical = await resolveOrCreateOrganizerByEmail(client, {
        email,
        name: names.full,
        accountVerification: {
          verifiedAt: new Date(),
          verificationSource: emailProofSource
        }
      });
      identity = canonical.organizer;
    }
    if (current) await revokeGuestSession(client, req);
    const session = await createGuestSession(client, {
      identityId: identity.id,
      userId: identity.user_id,
      displayFirstName: names.first,
      displayName: names.full,
      verified: true
    });
    return {
      kind: 'guest',
      firstName: names.first,
      redirect: safeNext(pending.return_path) || null,
      afterCommit: res => {
        setGuestSessionCookie(res, session.token);
        if (globalizeTypedGuestCode) {
          clearPhotoAccessCookie(res);
          setSessionCookie(res, identity.id);
          setIdentityStepUpCookie(res, identity.id);
        }
      }
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

  const canonical = await resolveOrCreateOrganizerByEmail(client, {
    email,
    accountVerification: {
      verifiedAt: new Date(),
      verificationSource: emailProofSource
    }
  });
  const organizer = (await client.query(
    'SELECT * FROM organizers WHERE id=$1', [canonical.user.id]
  )).rows[0];

  if (pending.intent === 'bind_phone') {
    if (!pending.phone_auth_challenge_id) {
      throw new PhoneAuthError('Phone verification expired. Start again.', {
        code: 'phone_verification_expired', status: 400
      });
    }
    if (organizer.is_admin) {
      throw new PhoneAuthError('For account security, administrators must sign in with email.', {
        code: 'email_sign_in_required', status: 403
      });
    }
    await bindVerifiedPhone(client, {
      challengeId: pending.phone_auth_challenge_id,
      organizerId: organizer.id
    });
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
      if (pending.intent === 'bind_phone') clearPhoneAuthCookie(res);
      setSessionCookie(res, organizer.id);
      setIdentityStepUpCookie(res, organizer.id);
    }
  };
}

function continuePageCopy(pending, hostName) {
  const masked = esc(maskEmail(pending.email));
  if (pending.intent === 'identity_step_up') {
    return {
      title: 'Confirm it’s you',
      body: `Confirm ${masked} before changing sign-in methods.`,
      button: 'Confirm account'
    };
  }
  if (pending.intent === 'attach_email') {
    return {
      title: 'Confirm this email',
      body: `Confirm ${masked} for the Silver Glider account that requested it.`,
      button: 'Confirm email'
    };
  }
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
    const outcome = await completeChallenge(client, req, pending, {
      emailProofSource: 'email_link'
    });
    await client.query('COMMIT');
    outcome.afterCommit(res);
    clearSignInRequestCookie(res);
    const fallback = outcome.kind === 'guest' ? '/' : '/dashboard';
    res.redirect(303, outcome.redirect || legacyNext || fallback);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (!phoneError(res, err)) next(err);
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
  let consumedPending = null;
  try {
    await client.query('BEGIN');
    const result = await consumeCode(client, readSignInRequest(req), req.body?.code);
    if (result.error) {
      await client.query('COMMIT'); // keep the attempt count
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(400).json({ error: result.error, message: CODE_ERRORS[result.error], remaining: result.remaining });
    }
    consumedPending = result.pending;
    // Typing a browser-bound code is an explicit proof of the inbox. A guest
    // verification code therefore also establishes the normal account
    // session; limited email links keep their narrower scopes.
    const outcome = await completeChallenge(client, req, result.pending, {
      globalizeTypedGuestCode: result.pending.intent === 'verify_guest',
      emailProofSource: 'email_code'
    });
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
    if (err instanceof CanonicalIdentityConflictError && consumedPending?.intent === 'attach_email') {
      const candidateUserId = Number(consumedPending.requested_user_id);
      await recordOwnershipConflict(pool, {
        identityType: IDENTITY_TYPES.EMAIL,
        normalizedValue: consumedPending.email,
        candidateUserId,
        conflictingUserId: err.existingUserId,
        verificationSource: 'account_settings.email_code',
        sourceRecordId: Number(consumedPending.id)
      }).catch(auditError => console.error('[identity:email-conflict-audit]', auditError.message));
      await pool.query(
        'UPDATE magic_link_tokens SET used_at=COALESCE(used_at,NOW()) WHERE id=$1',
        [consumedPending.id]
      ).catch(() => {});
      clearSignInRequestCookie(res);
    }
    if (!phoneError(res, err)) next(err);
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
    await cancelPhoneChallenge(pool, req);
    clearSessionCookie(res);
    clearGuestSessionCookie(res);
    clearPhotoAccessCookie(res);
    clearSignInRequestCookie(res);
    clearPhoneAuthCookie(res);
    clearIdentityStepUpCookie(res);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Rejects every account cookie issued before now, on every device, and ends
// every remembered-guest browser and unused sign-in link for this email.
router.post('/api/auth/logout-all', requireOrganizer, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE organizers SET sessions_valid_after=$2 WHERE id=$1', [req.organizer.id, new Date()]);
    await revokeIdentityGuestSessions(client, req.organizer.id, req.organizer.user_id);
    const { rows: activeEmails } = await client.query(
      `SELECT normalized_value AS email
         FROM user_identities
        WHERE user_id=$1 AND identity_type='email' AND revoked_at IS NULL
          AND verification_scope='account' AND verified_at IS NOT NULL`,
      [req.organizer.user_id || req.organizer.id]
    );
    const emailValues = activeEmails.map(row => row.email);
    if (!emailValues.includes(String(req.organizer.email || '').trim().toLowerCase())) {
      emailValues.push(String(req.organizer.email || '').trim().toLowerCase());
    }
    await client.query(
      `UPDATE magic_link_tokens
          SET used_at=NOW()
        WHERE used_at IS NULL
          AND (LOWER(BTRIM(email))=ANY($2::text[]) OR requested_user_id=$1)`,
      [req.organizer.user_id || req.organizer.id, emailValues]
    );
    const { rows: activePhones } = await client.query(
      `SELECT phone_e164 AS phone
         FROM account_phone_credentials
        WHERE organizer_id=$1 AND revoked_at IS NULL
       UNION
       SELECT normalized_value AS phone
         FROM user_identities
        WHERE user_id=$1 AND identity_type='phone' AND revoked_at IS NULL`,
      [req.organizer.id]
    );
    const phoneValues = activePhones.map(row => row.phone);
    await client.query(
      `UPDATE phone_auth_challenges
          SET used_at=COALESCE(used_at,NOW())
        WHERE used_at IS NULL
          AND (organizer_id=$1 OR phone_e164=ANY($2::text[]))`,
      [req.organizer.id, phoneValues]
    );
    // Recovery must always invalidate sessions, even if an operator is still
    // reviewing a quarantined legacy/canonical ownership mismatch. Revoke only
    // rows that belong to this user; never guess at or mutate another owner.
    await client.query(
      `UPDATE user_identities
          SET revoked_at=COALESCE(revoked_at,NOW()),updated_at=NOW()
        WHERE user_id=$1 AND identity_type='phone' AND revoked_at IS NULL`,
      [req.organizer.id]
    );
    await client.query(
      `UPDATE account_phone_credentials
          SET revoked_at=COALESCE(revoked_at,NOW()),updated_at=NOW()
        WHERE organizer_id=$1 AND revoked_at IS NULL`,
      [req.organizer.id]
    );
    await client.query('COMMIT');
    clearSessionCookie(res);
    clearGuestSessionCookie(res);
    clearPhotoAccessCookie(res);
    clearSignInRequestCookie(res);
    clearPhoneAuthCookie(res);
    clearIdentityStepUpCookie(res);
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.get('/api/auth/me', requireOrganizer, (req, res) => {
  const {
    id, email, name, avatar_url, org_name, public_slug, logo_url, header_image_url,
    bio, website_url, instagram_handle, instagram_url, contact_email,
    plan, is_admin, sms_credits, created_at, updated_at
  } = req.organizer;
  res.json({
    organizer: {
      id, email, name, avatar_url, org_name, public_slug, logo_url, header_image_url,
      bio, website_url, instagram_handle, instagram_url, contact_email,
      plan, is_admin, sms_credits, created_at, updated_at
    }
  });
});

router.get('/api/me/identities', requireOrganizer, async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await accountIdentityState(req));
  } catch (error) { next(error); }
});

// Sensitive credential changes require fresh proof of the account's current
// primary inbox. The resulting HttpOnly proof lasts only long enough to finish
// one account-settings visit; the normal 30-day session remains unchanged.
router.post('/api/me/identities/step-up/start', requireOrganizer, async (req, res, next) => {
  if (!sameOriginPost(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    const email = normalizeEmail(req.organizer.email);
    if (!limitEmailRequest(req, res, email)) return;
    const userId = Number(req.organizer.user_id || req.organizer.id);
    const { code, requestToken } = await createSignInChallenge(pool, {
      email,
      intent: 'identity_step_up',
      requestedUserId: userId,
      returnPath: '/settings/account'
    });
    await sendAccountVerificationCode({ to: email, code, purpose: 'identity_step_up' });
    await logEmail(email, userId);
    setSignInRequestCookie(res, requestToken);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, maskedEmail: maskEmail(email), codeLength: CODE_LENGTH });
  } catch (error) {
    if (!phoneError(res, error)) next(error);
  }
});

router.post(
  '/api/me/identities/email/start',
  requireOrganizer,
  requireIdentityStepUp,
  async (req, res, next) => {
    if (!sameOriginPost(req)) return res.status(403).json({ error: 'forbidden' });
    try {
      const email = normalizeEmail(req.body?.email);
      const userId = Number(req.organizer.user_id || req.organizer.id);
      const own = await pool.query(
        `SELECT id FROM user_identities
          WHERE user_id=$1 AND identity_type='email' AND normalized_value=$2
            AND revoked_at IS NULL AND verification_scope='account' AND verified_at IS NOT NULL`,
        [userId, email]
      );
      if (own.rows[0]) {
        return res.status(409).json({
          error: 'identity_already_connected',
          message: 'That email is already connected to your account.'
        });
      }
      if (!limitEmailRequest(req, res, email)) return;
      const { code, requestToken } = await createSignInChallenge(pool, {
        email,
        intent: 'attach_email',
        requestedUserId: userId,
        returnPath: '/settings/account'
      });
      await sendAccountVerificationCode({ to: email, code, purpose: 'attach_email' });
      // Ownership is not known until the code is entered. Do not attach the
      // requester to this delivery snapshot prematurely.
      await logEmail(email);
      setSignInRequestCookie(res, requestToken);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ ok: true, maskedEmail: maskEmail(email), codeLength: CODE_LENGTH });
    } catch (error) {
      if (!phoneError(res, error)) next(error);
    }
  }
);

router.post(
  '/api/me/identities/phone/start',
  requireOrganizer,
  requireIdentityStepUp,
  async (req, res, next) => {
    if (!sameOriginPost(req)) return res.status(403).json({ error: 'forbidden' });
    const startedAt = Date.now();
    let phone;
    try {
      if (req.organizer.is_admin) {
        return res.status(403).json({
          error: 'email_sign_in_required',
          message: 'Administrators use email sign-in.'
        });
      }
      phone = sms.normalizeE164(req.body?.phone);
      const userId = Number(req.organizer.user_id || req.organizer.id);
      const own = await pool.query(
        `SELECT id FROM user_identities
          WHERE user_id=$1 AND identity_type='phone' AND normalized_value=$2
            AND revoked_at IS NULL AND verification_scope='account' AND verified_at IS NOT NULL`,
        [userId, phone]
      );
      if (own.rows[0]) {
        return res.status(409).json({
          error: 'identity_already_connected',
          message: 'That phone is already connected to your account.'
        });
      }
      const rate = phoneRequestLimiter.consume({ phone, ip: clientIp(req) });
      if (!rate.allowed) {
        res.setHeader('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)));
        return res.status(429).json({
          error: 'too_many_phone_requests',
          message: 'Too many requests. Wait a few minutes and try again.'
        });
      }
      const verification = await phoneVerification.startVerification(phone);
      const challenge = await createPhoneChallenge(pool, {
        phone,
        purpose: 'add_phone',
        organizerId: userId,
        providerSid: verification.verificationSid,
        returnPath: '/settings/account'
      });
      setPhoneAuthCookie(res, challenge.requestToken);
      res.setHeader('Cache-Control', 'private, no-store');
      await waitForMinimum(startedAt);
      res.json({ ok: true, codeLength: PHONE_CODE_LENGTH });
    } catch (error) {
      if (phoneStartProviderError(error) || error instanceof CanonicalIdentityError) {
        await waitForMinimum(startedAt);
        return res.status(error.status || 503).json({
          error: error.code || 'phone_code_unavailable',
          message: error instanceof CanonicalIdentityError
            ? error.message
            : 'We couldn’t send a code. Try again.'
        });
      }
      if (!phoneError(res, error)) next(error);
    }
  }
);

router.post(
  '/api/me/identities/phone/verify',
  requireOrganizer,
  requireIdentityStepUp,
  async (req, res, next) => {
    if (!sameOriginPost(req)) return res.status(403).json({ error: 'forbidden' });
    const rate = phoneCodeAttemptLimiter.consume({ ip: clientIp(req) });
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)));
      return res.status(429).json({
        error: 'too_many_attempts',
        message: 'Too many attempts. Wait a few minutes and try again.'
      });
    }

    let challenge;
    let client;
    const userId = Number(req.organizer.user_id || req.organizer.id);
    try {
      challenge = await readPhoneChallenge(pool, req);
      if (!challenge || challenge.purpose !== 'add_phone' ||
          Number(challenge.organizer_id) !== userId) {
        throw new PhoneAuthError('That code has expired. Request a new one.', {
          code: 'phone_verification_expired', status: 400
        });
      }
      const verification = await phoneVerification.checkVerification({
        verificationSid: challenge.provider_sid,
        code: req.body?.code
      });
      if (!verification.phone || verification.phone !== challenge.phone_e164) {
        throw new PhoneAuthError('Phone verification could not be completed.', {
          code: 'phone_verification_mismatch', status: 400
        });
      }

      client = await pool.connect();
      await client.query('BEGIN');
      const locked = await readPhoneChallenge(client, req, { forUpdate: true });
      if (!locked || Number(locked.id) !== Number(challenge.id) ||
          locked.purpose !== 'add_phone' || Number(locked.organizer_id) !== userId ||
          locked.provider_sid !== verification.verificationSid) {
        throw new PhoneAuthError('Phone verification expired. Start again.', {
          code: 'phone_verification_expired', status: 400
        });
      }
      await replaceVerifiedPhone(client, {
        userId,
        phone: locked.phone_e164,
        verifiedAt: new Date(),
        verificationSource: 'account_settings.twilio_verify'
      });
      await client.query(
        `UPDATE phone_auth_challenges
            SET verified_at=COALESCE(verified_at,NOW()),used_at=NOW()
          WHERE id=$1`,
        [locked.id]
      );
      await client.query('COMMIT');
      clearPhoneAuthCookie(res);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ ok: true, ...(await accountIdentityState(req)) });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      if (error instanceof CanonicalIdentityConflictError && challenge) {
        await recordOwnershipConflict(pool, {
          identityType: IDENTITY_TYPES.PHONE,
          normalizedValue: challenge.phone_e164,
          candidateUserId: userId,
          conflictingUserId: error.existingUserId,
          verificationSource: 'account_settings.twilio_verify',
          sourceRecordId: Number(challenge.id)
        }).catch(auditError => console.error('[identity:phone-conflict-audit]', auditError.message));
        await pool.query(
          'UPDATE phone_auth_challenges SET used_at=COALESCE(used_at,NOW()) WHERE id=$1',
          [challenge.id]
        ).catch(() => {});
        clearPhoneAuthCookie(res);
      }
      if (!phoneError(res, error)) next(error);
    } finally {
      client?.release();
    }
  }
);

router.patch(
  '/api/me/identities/:id/primary',
  requireOrganizer,
  requireIdentityStepUp,
  async (req, res, next) => {
    if (!sameOriginPost(req)) return res.status(403).json({ error: 'forbidden' });
    try {
      const userId = Number(req.organizer.user_id || req.organizer.id);
      await makePrimaryEmail(pool, { userId, identityId: req.params.id });
      const { rows } = await pool.query(
        'SELECT email FROM organizers WHERE id=$1',
        [userId]
      );
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ ok: true, primaryEmail: rows[0]?.email || '', ...(await accountIdentityState(req)) });
    } catch (error) {
      if (!phoneError(res, error)) next(error);
    }
  }
);

router.delete(
  '/api/me/identities/:id',
  requireOrganizer,
  requireIdentityStepUp,
  async (req, res, next) => {
    if (!sameOriginPost(req)) return res.status(403).json({ error: 'forbidden' });
    try {
      const userId = Number(req.organizer.user_id || req.organizer.id);
      await removeAccountIdentity(pool, { userId, identityId: req.params.id });
      clearPhoneAuthCookie(res);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ ok: true, ...(await accountIdentityState(req)) });
    } catch (error) {
      if (!phoneError(res, error)) next(error);
    }
  }
);

// Also answers for a photo-only grant, which the Add Photo page needs; `scope`
// tells the page not to render account navigation.
router.get('/api/me', requirePhotoAccess, (req, res) => {
  const { id, email, name, avatar_url } = req.organizer;
  res.json({
    user: { id, email, name, avatarUrl: avatar_url || null },
    scope: req.photoAccessOnly ? 'photo' : 'account'
  });
});

// Profile badges: events you went to (someone else's, already happened) and
// events you hosted (published, already happened).
router.get('/api/me/stats', requireOrganizer, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(DISTINCT r.event_id) FROM rsvps r JOIN events e ON e.id=r.event_id
           WHERE (r.user_id=$2 OR (r.user_id IS NULL AND r.account_id=$1))
             AND r.status='confirmed' AND e.status='published' AND e.organizer_id<>$1
             AND e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE e.timezone)::date)::int AS attended,
         (SELECT COUNT(*) FROM events e
           WHERE e.organizer_id=$1 AND e.status='published'
             AND e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE e.timezone)::date)::int AS hosted`,
      [req.organizer.id, req.organizer.user_id]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
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
  phoneRequestLimiter.reset();
  phoneCodeAttemptLimiter.reset();
  phoneEmailLimiter.reset();
};

module.exports = router;
