const crypto = require('crypto');
const express = require('express');
const pool = require('../config/db');
const requireAdmin = require('../middleware/requireAdmin');
const { isDedicatedSuperAdmin, sameOriginMutation } = require('../middleware/requireAdmin');
const { clientIp, createRateLimiter } = require('../lib/rate-limit');
const { tokenHash } = require('../lib/guest-session');
const { readCookie } = require('../lib/private-events');
const {
  clearAdminSessionCookie,
  loadAdminOperator,
  setAdminSessionCookie
} = require('../lib/admin-session');
const {
  clearAdminEditorCookie,
  revokeAdminEditorWorkspacesForOperator
} = require('../lib/admin-editor-workspace');
const { sendAdminPasscode } = require('../lib/mailer');
const { canonicalOperatorTargetKey } = require('../lib/admin-operators');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_LENGTH = 6;
const MAX_ATTEMPTS = 5;
const CHALLENGE_TTL_MINUTES = 10;
const PROOF_TTL_MINUTES = 10;
const LOGIN_REQUEST_COOKIE = 'sge_admin_sign_in';
const STEP_UP_REQUEST_COOKIE = 'sge_admin_step_up';
const ACTION_PROOF_COOKIE = 'sge_admin_action';
const backgroundWork = new Set();
let deliverAdminPasscode = sendAdminPasscode;

const startLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  rules: [
    { name: 'email', max: 5, key: context => context.email },
    { name: 'ip', max: 20, key: context => context.ip }
  ]
});
const verifyLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  rules: [{ name: 'ip', max: 30, key: context => context.ip }]
});
const limiterTimer = setInterval(() => {
  startLimiter.prune();
  verifyLimiter.prune();
}, 15 * 60 * 1000);
limiterTimer.unref();

function runInBackground(task) {
  const work = Promise.resolve().then(task)
    .catch(() => {})
    .finally(() => backgroundWork.delete(work));
  backgroundWork.add(work);
  return work;
}

function secret() {
  const value = String(process.env.SESSION_SECRET || '').trim();
  if (!value) throw new Error('SESSION_SECRET is required');
  return value;
}

function codeHash(requestHash, code) {
  return crypto.createHmac('sha256', secret())
    .update(`admin-code:${requestHash}:${code}`)
    .digest('hex');
}

function newCode() {
  return String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

function normalizedCode(value) {
  return String(value || '').replace(/\D/g, '').slice(0, CODE_LENGTH);
}

function cookieAttributes(maxAgeSeconds) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

function setOpaqueCookie(res, name, value, maxAgeSeconds) {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; ${cookieAttributes(maxAgeSeconds)}`);
}

function clearOpaqueCookie(res, name) {
  res.append('Set-Cookie', `${name}=; ${cookieAttributes(0)}`);
}

function maskEmail(value) {
  const [local = '', domain = ''] = String(value || '').split('@');
  return domain ? `${local.slice(0, 1)}${local.length > 1 ? '•••' : ''}@${domain}` : '';
}

function waitForMinimum(startedAt, minimumMs = 650) {
  const remaining = minimumMs - (Date.now() - startedAt);
  return remaining > 0 ? new Promise(resolve => setTimeout(resolve, remaining)) : Promise.resolve();
}

async function createChallenge(db, {
  operatorId,
  purpose,
  action = null,
  targetUserId = null,
  targetKey = null
}) {
  const requestToken = crypto.randomBytes(24).toString('base64url');
  const requestHash = tokenHash(requestToken);
  const code = newCode();
  await db.query(
    `INSERT INTO admin_auth_challenges
       (operator_id,purpose,action,target_user_id,target_key,request_hash,code_hash,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW() + make_interval(mins => $8))`,
    [operatorId, purpose, action, targetUserId, targetKey, requestHash, codeHash(requestHash, code),
     CHALLENGE_TTL_MINUTES]
  );
  return { requestToken, code };
}

async function consumeChallenge(client, {
  requestToken,
  code,
  purpose,
  operatorId = null
}) {
  if (!requestToken || requestToken.length > 100) return { error: 'expired' };
  const params = [tokenHash(requestToken), purpose];
  const operatorClause = operatorId ? `AND challenge.operator_id=$${params.push(operatorId)}` : '';
  const { rows } = await client.query(
    `SELECT challenge.id,challenge.operator_id,challenge.action,
            challenge.target_user_id,challenge.target_key,
            challenge.request_hash,challenge.code_hash,challenge.code_attempts,
            operator.email,operator.role
       FROM admin_auth_challenges challenge
       JOIN admin_operators operator ON operator.id=challenge.operator_id
      WHERE challenge.request_hash=$1 AND challenge.purpose=$2 ${operatorClause}
        AND challenge.used_at IS NULL AND challenge.expires_at>NOW()
        AND operator.status='active'
      ORDER BY challenge.id DESC LIMIT 1
      FOR UPDATE OF challenge`,
    params
  );
  const challenge = rows[0];
  if (!challenge) return { error: 'expired' };
  if (challenge.code_attempts >= MAX_ATTEMPTS) return { error: 'locked' };
  const submitted = normalizedCode(code);
  const expected = Buffer.from(challenge.code_hash);
  const actual = Buffer.from(codeHash(challenge.request_hash, submitted));
  const matches = submitted.length === CODE_LENGTH && expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual);
  if (!matches) {
    const attempts = Number(challenge.code_attempts) + 1;
    await client.query('UPDATE admin_auth_challenges SET code_attempts=$2 WHERE id=$1', [challenge.id, attempts]);
    return attempts >= MAX_ATTEMPTS
      ? { error: 'locked' }
      : { error: 'invalid', remaining: MAX_ATTEMPTS - attempts };
  }
  await client.query('UPDATE admin_auth_challenges SET used_at=NOW() WHERE id=$1', [challenge.id]);
  return { challenge };
}

function challengeError(result) {
  // A fake browser token issued for an unknown/disabled address must be
  // indistinguishable from a real challenge with an incorrect code.
  return {
    error: 'invalid_or_expired_code',
    message: 'That code is invalid or expired. Request a new one.'
  };
}

router.post('/api/admin/auth/start', async (req, res, next) => {
  if (!sameOriginMutation(req)) return res.status(403).json({ error: 'forbidden' });
  const startedAt = Date.now();
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 320) {
    return res.status(400).json({ error: 'Enter a valid email' });
  }
  const limit = startLimiter.consume({ email, ip: clientIp(req) });
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
    return res.status(429).json({ error: 'Too many requests. Wait a few minutes and try again.' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id,email FROM admin_operators
        WHERE email=$1 AND status='active'
        LIMIT 1`,
      [email]
    );
    // Always set a same-shaped browser token. For an unknown or disabled
    // address it intentionally points to no database row.
    let requestToken = crypto.randomBytes(24).toString('base64url');
    if (rows[0]) {
      const challenge = await createChallenge(pool, {
        operatorId: rows[0].id,
        purpose: 'login'
      });
      requestToken = challenge.requestToken;
      runInBackground(async () => {
        try {
          await deliverAdminPasscode({
            to: rows[0].email,
            code: challenge.code,
            purpose: 'login'
          });
        } catch (_) {
          console.error('[admin-auth] passcode delivery failed', {
            operatorId: Number(rows[0].id)
          });
        }
      });
    }
    setOpaqueCookie(res, LOGIN_REQUEST_COOKIE, requestToken, CHALLENGE_TTL_MINUTES * 60);
    await waitForMinimum(startedAt);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, codeLength: CODE_LENGTH });
  } catch (error) { next(error); }
});

router.post('/api/admin/auth/verify', async (req, res, next) => {
  if (!sameOriginMutation(req)) return res.status(403).json({ error: 'forbidden' });
  const limit = verifyLimiter.consume({ ip: clientIp(req) });
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
    return res.status(429).json({ error: 'too_many_attempts', message: 'Too many attempts. Wait a few minutes and try again.' });
  }
  const authenticatedAt = Date.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await consumeChallenge(client, {
      requestToken: readCookie(req, LOGIN_REQUEST_COOKIE),
      code: req.body?.code,
      purpose: 'login'
    });
    if (result.error) {
      await client.query('COMMIT');
      return res.status(400).json(challengeError(result));
    }
    await client.query('COMMIT');
    // The challenge lock is released before touching the operator row. This
    // preserves the trigger's operator -> credential lock order during a
    // concurrent disable, while last-login telemetry remains best effort.
    await client.query(
      `UPDATE admin_operators SET last_login_at=NOW(),updated_at=NOW()
        WHERE id=$1 AND status='active'`,
      [result.challenge.operator_id]
    ).catch(() => {
      console.error('[admin-auth] last-login update failed', {
        operatorId: Number(result.challenge.operator_id)
      });
    });
    setAdminSessionCookie(res, result.challenge.operator_id, authenticatedAt);
    clearOpaqueCookie(res, LOGIN_REQUEST_COOKIE);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, redirect: '/admin' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

router.get('/api/admin/auth/me', requireAdmin, (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  const dedicatedSuperAdmin = isDedicatedSuperAdmin(req);
  const capabilities = {
    manageAccounts: true,
    manageIdentities: Boolean(req.adminOperator),
    manageDoneForYou: Boolean(req.adminOperator),
    suspendAccounts: true,
    deleteAccounts: dedicatedSuperAdmin,
    manageOperators: dedicatedSuperAdmin
  };
  if (req.adminOperator) {
    return res.json({
      operator: {
        id: Number(req.adminOperator.id),
        email: req.adminOperator.email,
        role: req.adminOperator.role,
        status: req.adminOperator.status,
        legacy: false
      },
      capabilities
    });
  }
  res.json({
    operator: {
      id: null,
      email: req.adminActor.email,
      role: req.adminActor.role,
      status: 'active',
      legacy: true
    },
    capabilities
  });
});

router.post('/api/admin/auth/logout', async (req, res, next) => {
  if (!sameOriginMutation(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    // The editor cookie is scoped to /admin-editor and is therefore not sent
    // here. Resolve the independent admin session before clearing it, then
    // revoke every active workspace owned by that exact operator.
    const dedicated = await loadAdminOperator(pool, req);
    if (dedicated.operator) {
      await revokeAdminEditorWorkspacesForOperator(pool, {
        actorAdminOperatorId: dedicated.operator.id,
        sessionIssuedAt: dedicated.session.issuedAt,
        requestIp: String(clientIp(req) || '').slice(0, 100) || null,
        userAgent: String(req.get('user-agent') || '').slice(0, 1000) || null
      });
    }
  } catch (error) {
    console.error('[admin-auth] failed to revoke editor workspaces on logout', {
      error: error.message
    });
    clearAdminSessionCookie(res);
    clearOpaqueCookie(res, LOGIN_REQUEST_COOKIE);
    clearOpaqueCookie(res, STEP_UP_REQUEST_COOKIE);
    clearOpaqueCookie(res, ACTION_PROOF_COOKIE);
    clearAdminEditorCookie(res);
    return next(error);
  }
  clearAdminSessionCookie(res);
  clearOpaqueCookie(res, LOGIN_REQUEST_COOKIE);
  clearOpaqueCookie(res, STEP_UP_REQUEST_COOKIE);
  clearOpaqueCookie(res, ACTION_PROOF_COOKIE);
  clearAdminEditorCookie(res);
  res.json({ ok: true });
});

router.post('/api/admin/auth/step-up/start', requireAdmin, async (req, res, next) => {
  if (!isDedicatedSuperAdmin(req)) {
    return res.status(403).json({
      error: 'dedicated_super_admin_required',
      message: 'Sign in through the dedicated admin login as a Super Admin.'
    });
  }
  const limit = startLimiter.consume({ email: req.adminOperator.email, ip: clientIp(req) });
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
    return res.status(429).json({ error: 'Too many requests. Wait a few minutes and try again.' });
  }
  const action = String(req.body?.action || '').trim();
  let targetUserId = null;
  let targetKey = null;
  try {
    if (action === 'account_delete') {
      targetUserId = Number(req.body?.targetUserId);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        return res.status(400).json({ error: 'invalid_admin_action' });
      }
      const target = await pool.query(
        `SELECT id FROM users WHERE id=$1 AND account_status<>'deleted'`,
        [targetUserId]
      );
      if (!target.rows[0]) return res.status(404).json({ error: 'Account not found' });
    } else if (action === 'operator_manage') {
      targetKey = canonicalOperatorTargetKey(req.body?.targetKey);
      if (!targetKey) return res.status(400).json({ error: 'invalid_admin_action' });
      if (targetKey.startsWith('operator:')) {
        const target = await pool.query(
          'SELECT id FROM admin_operators WHERE id=$1',
          [Number(targetKey.slice('operator:'.length))]
        );
        if (!target.rows[0]) {
          return res.status(404).json({ error: 'operator_not_found', message: 'Operator not found.' });
        }
      } else {
        const email = targetKey.slice('new:'.length);
        const existing = await pool.query(
          'SELECT id FROM admin_operators WHERE email=$1',
          [email]
        );
        if (existing.rows[0]) {
          return res.status(409).json({
            error: 'operator_already_exists',
            message: 'An operator with that email already exists.'
          });
        }
      }
    } else {
      return res.status(400).json({ error: 'invalid_admin_action' });
    }
    const challenge = await createChallenge(pool, {
      operatorId: req.adminOperator.id,
      purpose: 'step_up',
      action,
      targetUserId,
      targetKey
    });
    await deliverAdminPasscode({
      to: req.adminOperator.email,
      code: challenge.code,
      purpose: action
    });
    setOpaqueCookie(res, STEP_UP_REQUEST_COOKIE, challenge.requestToken, CHALLENGE_TTL_MINUTES * 60);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      action,
      targetUserId,
      targetKey,
      maskedEmail: maskEmail(req.adminOperator.email),
      codeLength: CODE_LENGTH
    });
  } catch (error) { next(error); }
});

router.post('/api/admin/auth/step-up/complete', requireAdmin, async (req, res, next) => {
  if (!isDedicatedSuperAdmin(req)) {
    return res.status(403).json({ error: 'dedicated_super_admin_required' });
  }
  const limit = verifyLimiter.consume({ ip: clientIp(req) });
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
    return res.status(429).json({
      error: 'too_many_attempts',
      message: 'Too many attempts. Wait a few minutes and try again.'
    });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await consumeChallenge(client, {
      requestToken: readCookie(req, STEP_UP_REQUEST_COOKIE),
      code: req.body?.code,
      purpose: 'step_up',
      operatorId: req.adminOperator.id
    });
    if (result.error) {
      await client.query('COMMIT');
      return res.status(400).json(challengeError(result));
    }
    const proofToken = crypto.randomBytes(32).toString('base64url');
    await client.query(
      `INSERT INTO admin_action_proofs
         (operator_id,action,target_user_id,target_key,token_hash,expires_at)
       VALUES ($1,$2,$3,$4,$5,NOW() + make_interval(mins => $6))`,
      [req.adminOperator.id, result.challenge.action, result.challenge.target_user_id,
       result.challenge.target_key, tokenHash(proofToken), PROOF_TTL_MINUTES]
    );
    await client.query('COMMIT');
    setOpaqueCookie(res, ACTION_PROOF_COOKIE, proofToken, PROOF_TTL_MINUTES * 60);
    clearOpaqueCookie(res, STEP_UP_REQUEST_COOKIE);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      kind: 'admin_action_proof',
      action: result.challenge.action,
      targetUserId: result.challenge.target_user_id === null
        ? null
        : Number(result.challenge.target_user_id),
      targetKey: result.challenge.target_key
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

async function consumeAdminActionProof(client, req, {
  operatorId,
  action,
  targetUserId = null,
  targetKey = null
}) {
  const token = readCookie(req, ACTION_PROOF_COOKIE);
  if (!token || token.length > 200) return false;
  const { rows } = await client.query(
    `UPDATE admin_action_proofs
        SET consumed_at=NOW()
      WHERE token_hash=$1 AND operator_id=$2 AND action=$3
        AND target_user_id IS NOT DISTINCT FROM $4
        AND target_key IS NOT DISTINCT FROM $5
        AND consumed_at IS NULL AND expires_at>NOW()
      RETURNING id`,
    [tokenHash(token), operatorId, action, targetUserId, targetKey]
  );
  return Boolean(rows[0]);
}

function clearAdminActionProofCookie(res) {
  clearOpaqueCookie(res, ACTION_PROOF_COOKIE);
}

function resetRateLimitsForTests() {
  startLimiter.reset();
  verifyLimiter.reset();
  deliverAdminPasscode = sendAdminPasscode;
}

async function settleBackgroundWork() {
  while (backgroundWork.size) await Promise.allSettled([...backgroundWork]);
}

function setAdminPasscodeSenderForTests(sender = sendAdminPasscode) {
  deliverAdminPasscode = sender;
}

module.exports = router;
module.exports.ACTION_PROOF_COOKIE = ACTION_PROOF_COOKIE;
module.exports.clearAdminActionProofCookie = clearAdminActionProofCookie;
module.exports.consumeAdminActionProof = consumeAdminActionProof;
module.exports.resetRateLimitsForTests = resetRateLimitsForTests;
module.exports.setAdminPasscodeSenderForTests = setAdminPasscodeSenderForTests;
module.exports.settleBackgroundWork = settleBackgroundWork;
