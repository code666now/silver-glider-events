const express = require('express');
const pool = require('../config/db');
const requireAdmin = require('../middleware/requireAdmin');
const { createSignInChallenge } = require('../lib/sign-in-challenges');
const { sendAccountClaimInvitation } = require('../lib/mailer');
const { clientIp, createRateLimiter } = require('../lib/rate-limit');
const { tokenHash } = require('../lib/guest-session');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCOUNT_INVITE_TTL_MINUTES = 7 * 24 * 60;
const ACCOUNT_INVITE_STALE_MINUTES = 5;
let deliverAccountClaimInvitation = sendAccountClaimInvitation;

router.use('/api/admin/accounts', requireAdmin);

const inviteLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  rules: [
    { name: 'admin', max: 15, key: context => context.adminId },
    { name: 'ip', max: 25, key: context => context.ip }
  ]
});

function positiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function cleanText(value, max = 500) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function cleanName(value) {
  return cleanText(value, 160);
}

function cleanReason(value, fallback = '') {
  const reason = cleanText(value, 500) || fallback;
  return reason.length >= 3 ? reason : '';
}

function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.length <= 320 && EMAIL_RE.test(email) ? email : '';
}

function maskEmail(value) {
  const [local = '', domain = ''] = String(value || '').split('@');
  if (!domain) return '';
  return `${local.slice(0, 1)}${local.length > 1 ? '•••' : ''}@${domain}`;
}

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 4 ? `••• ••• ${digits.slice(-4)}` : '••••';
}

function maskIdentity(type, value) {
  return type === 'email' ? maskEmail(value) : (type === 'phone' ? maskPhone(value) : 'Connected');
}

function sameOriginMutation(req, res, next) {
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (!site) {
    const origin = req.get('origin');
    if (origin && origin !== 'null') {
      let originHost;
      try { originHost = new URL(origin).host; } catch (_) {
        return res.status(403).json({ error: 'forbidden' });
      }
      const allowed = [req.get('host'), req.get('x-forwarded-host')];
      try { allowed.push(new URL(process.env.APP_URL).host); } catch (_) {}
      if (!allowed.filter(Boolean).includes(originHost)) {
        return res.status(403).json({ error: 'forbidden' });
      }
    }
  }
  next();
}

router.use('/api/admin/accounts', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return sameOriginMutation(req, res, next);
  }
  next();
});

function auditContext(req) {
  return {
    requestIp: String(clientIp(req) || '').slice(0, 100) || null,
    userAgent: String(req.get('user-agent') || '').slice(0, 1000) || null
  };
}

async function writeAudit(client, req, {
  targetUserId = null,
  actionType,
  reason,
  beforeState = {},
  afterState = {},
  metadata = {}
}) {
  const context = auditContext(req);
  await client.query(
    `INSERT INTO admin_account_audit_log
       (actor_user_id,target_user_id,action_type,reason,before_state,after_state,
        metadata,request_ip,user_agent)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)`,
    [
      Number(req.organizer.user_id || req.organizer.id),
      targetUserId,
      actionType,
      reason,
      JSON.stringify(beforeState || {}),
      JSON.stringify(afterState || {}),
      JSON.stringify(metadata || {}),
      context.requestIp,
      context.userAgent
    ]
  );
}

async function lockInvitationEmail(client, email) {
  // The recipient is the concurrency key: two admins must not mint two live
  // claim links for the same normalized inbox.
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    [`admin-account-invitation:${email}`]
  );
}

async function revokeStaleUnsentInvitations(client, req, email) {
  const stale = await client.query(
    `SELECT id,magic_link_token_id,created_at
       FROM admin_account_invitations
      WHERE email=$1 AND claimed_at IS NULL AND sent_at IS NULL
        AND revoked_at IS NULL AND delivery_failed_at IS NULL
        AND expires_at>NOW()
        AND created_at <= NOW() - make_interval(mins => $2)
      ORDER BY id
      FOR UPDATE`,
    [email, ACCOUNT_INVITE_STALE_MINUTES]
  );
  if (!stale.rows.length) return;

  const invitationIds = stale.rows.map(row => Number(row.id));
  const tokenIds = stale.rows.map(row => Number(row.magic_link_token_id));
  await client.query(
    `UPDATE admin_account_invitations
        SET revoked_at=COALESCE(revoked_at,NOW())
      WHERE id=ANY($1::bigint[])`,
    [invitationIds]
  );
  await client.query(
    `UPDATE magic_link_tokens
        SET used_at=COALESCE(used_at,NOW())
      WHERE id=ANY($1::int[])`,
    [tokenIds]
  );
  for (const row of stale.rows) {
    await writeAudit(client, req, {
      actionType: 'account_invitation_stale_revoked',
      reason: 'Replace stale undelivered account invitation',
      beforeState: { invitationStatus: 'creating', createdAt: row.created_at },
      afterState: { invitationStatus: 'revoked' },
      metadata: { invitationId: Number(row.id) }
    });
  }
}

async function appendInvitationAuditBestEffort(req, details) {
  try {
    await writeAudit(pool, req, details);
  } catch (error) {
    // Delivery state is authoritative. Audit telemetry must never roll back a
    // successfully delivered link or resurrect a failed one.
    console.error('[account-invitation] audit write failed', {
      actionType: details.actionType,
      invitationId: details.metadata?.invitationId || null
    });
  }
}

async function logInvitationDeliveryBestEffort(email, status, error = null) {
  try {
    await pool.query(
      `INSERT INTO message_log (recipient,message_type,channel,status,sent_at,error)
       VALUES ($1,'magic_link','email',$2,
               CASE WHEN $2='sent' THEN NOW() ELSE NULL END,$3)`,
      [email, status, error ? String(error.message || 'Delivery failed').slice(0, 500) : null]
    );
  } catch (_) {
    console.error('[account-invitation] message telemetry write failed', { status });
  }
}

async function markInvitationSent(invitation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockInvitationEmail(client, invitation.email);
    const { rows } = await client.query(
      `UPDATE admin_account_invitations
          SET sent_at=COALESCE(sent_at,NOW())
        WHERE id=$1 AND claimed_at IS NULL AND revoked_at IS NULL
          AND delivery_failed_at IS NULL AND expires_at>NOW()
        RETURNING sent_at`,
      [invitation.id]
    );
    if (!rows[0]) throw new Error('Account invitation is no longer deliverable');
    await client.query('COMMIT');
    return rows[0].sent_at;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function markInvitationDeliveryFailed(invitation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockInvitationEmail(client, invitation.email);
    const { rows } = await client.query(
      `UPDATE admin_account_invitations
          SET delivery_failed_at=COALESCE(delivery_failed_at,NOW())
        WHERE id=$1 AND claimed_at IS NULL AND sent_at IS NULL
          AND revoked_at IS NULL
        RETURNING delivery_failed_at,magic_link_token_id`,
      [invitation.id]
    );
    if (rows[0]) {
      await client.query(
        `UPDATE magic_link_tokens
            SET used_at=COALESCE(used_at,NOW())
          WHERE id=$1`,
        [rows[0].magic_link_token_id]
      );
    }
    await client.query('COMMIT');
    return rows[0]?.delivery_failed_at || null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function lockAccount(client, userId) {
  const { rows } = await client.query(
    `SELECT u.id,u.name,u.account_status,u.suspended_at,u.suspension_reason,
            o.email,o.is_admin,o.sessions_valid_after,o.org_name,o.public_slug
       FROM users u
       JOIN organizers o ON o.user_id=u.id
      WHERE u.id=$1
      FOR UPDATE OF u,o`,
    [userId]
  );
  return rows[0] || null;
}

async function invalidateAccountAccess(client, userId) {
  const now = new Date();
  await client.query(
    'UPDATE organizers SET sessions_valid_after=$2 WHERE user_id=$1',
    [userId, now]
  );
  const identities = await client.query(
    `SELECT identity_type,value
       FROM user_identities
      WHERE user_id=$1 AND revoked_at IS NULL`,
    [userId]
  );
  const emails = identities.rows
    .filter(row => row.identity_type === 'email')
    .map(row => String(row.value || '').trim().toLowerCase());
  const phones = identities.rows
    .filter(row => row.identity_type === 'phone')
    .map(row => String(row.value || '').trim());
  await client.query(
    `UPDATE magic_link_tokens
        SET used_at=COALESCE(used_at,NOW())
      WHERE used_at IS NULL
        AND (requested_user_id=$1 OR LOWER(BTRIM(email))=ANY($2::text[]))`,
    [userId, emails]
  );
  await client.query(
    `UPDATE phone_auth_challenges
        SET used_at=COALESCE(used_at,NOW())
      WHERE used_at IS NULL
        AND (organizer_id=$1 OR phone_e164=ANY($2::text[]))`,
    [userId, phones]
  );
  const guestSessions = await client.query(
    `UPDATE guest_sessions
        SET revoked_at=COALESCE(revoked_at,NOW())
      WHERE revoked_at IS NULL
        AND (user_id=$1 OR identity_id=$1)
      RETURNING id`,
    [userId]
  );
  return { invalidatedAt: now.toISOString(), guestSessionsRevoked: guestSessions.rowCount || 0 };
}

const accountListSelect = `
  SELECT u.id,u.name,u.account_status,u.suspended_at,u.suspension_reason,
         u.created_at,u.updated_at,
         o.email,o.is_admin,o.plan,o.last_login_at,o.org_name,o.public_slug,
         o.bio,o.website_url,o.instagram_handle,o.contact_email,
         o.sms_credits,o.sessions_valid_after,
         COALESCE((SELECT COUNT(*) FROM events e WHERE e.organizer_id=o.id),0)::int AS event_count,
         COALESCE((SELECT COUNT(*) FROM rsvps r WHERE r.user_id=u.id OR (r.user_id IS NULL AND r.account_id=o.id)),0)::int AS rsvp_count,
         COALESCE((SELECT COUNT(*) FROM host_follows f WHERE f.follower_user_id=u.id AND f.unsubscribed_at IS NULL),0)::int AS following_count,
         (SELECT value FROM user_identities i
           WHERE i.user_id=u.id AND i.identity_type='email' AND i.revoked_at IS NULL
             AND i.verification_scope='account' AND i.verified_at IS NOT NULL
           ORDER BY i.is_primary DESC,i.id ASC LIMIT 1) AS verified_email,
         (SELECT value FROM user_identities i
           WHERE i.user_id=u.id AND i.identity_type='phone' AND i.revoked_at IS NULL
             AND i.verification_scope='account' AND i.verified_at IS NOT NULL
           ORDER BY i.is_primary DESC,i.id ASC LIMIT 1) AS verified_phone
    FROM users u
    LEFT JOIN organizers o ON o.user_id=u.id`;

function accountListItem(row) {
  const kind = row.is_admin ? 'admin' : (row.public_slug || row.org_name || row.event_count > 0 ? 'host' : 'guest');
  return {
    id: Number(row.id),
    user_id: Number(row.id),
    name: row.name || 'Unnamed account',
    status: row.account_status,
    account_status: row.account_status,
    kind,
    isAdmin: Boolean(row.is_admin),
    is_admin: Boolean(row.is_admin),
    plan: row.plan || 'free',
    email: maskEmail(row.verified_email || row.email),
    primary_email_masked: maskEmail(row.verified_email || row.email),
    phone: row.verified_phone ? maskPhone(row.verified_phone) : null,
    primary_phone_masked: row.verified_phone ? maskPhone(row.verified_phone) : null,
    hostPage: row.public_slug ? { name: row.org_name || row.name, slug: row.public_slug } : null,
    org_name: row.org_name || null,
    public_slug: row.public_slug || null,
    eventCount: Number(row.event_count || 0),
    event_count: Number(row.event_count || 0),
    rsvpCount: Number(row.rsvp_count || 0),
    rsvp_count: Number(row.rsvp_count || 0),
    followingCount: Number(row.following_count || 0),
    following_count: Number(row.following_count || 0),
    createdAt: row.created_at,
    created_at: row.created_at,
    lastLoginAt: row.last_login_at,
    last_login_at: row.last_login_at,
    suspendedAt: row.suspended_at
  };
}

// All canonical users, including guest-only accounts. Search accepts exact or
// partial identity input but returns only masked list identifiers.
router.get('/api/admin/accounts', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    const q = cleanText(req.query.q, 120).toLowerCase();
    const status = ['active', 'suspended'].includes(req.query.status) ? req.query.status : '';
    const type = ['admin', 'host', 'guest'].includes(req.query.type) ? req.query.type : '';
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 100);
    const offset = Math.max(Number.parseInt(req.query.cursor ?? req.query.offset, 10) || 0, 0);
    const params = [];
    const conditions = [];
    if (status) {
      params.push(status);
      conditions.push(`u.account_status=$${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      const n = params.length;
      conditions.push(`(
        LOWER(COALESCE(u.name,'')) LIKE $${n}
        OR CAST(u.id AS TEXT) LIKE $${n}
        OR LOWER(COALESCE(o.org_name,'')) LIKE $${n}
        OR EXISTS (
          SELECT 1 FROM user_identities search_identity
           WHERE search_identity.user_id=u.id AND search_identity.revoked_at IS NULL
             AND LOWER(search_identity.normalized_value) LIKE $${n}
        )
      )`);
    }
    if (type === 'admin') conditions.push('o.is_admin=TRUE');
    if (type === 'host') conditions.push(`o.is_admin=FALSE AND (
      o.public_slug IS NOT NULL OR o.org_name IS NOT NULL
      OR EXISTS (SELECT 1 FROM events kind_event WHERE kind_event.organizer_id=o.id)
    )`);
    if (type === 'guest') conditions.push(`o.is_admin=FALSE
      AND o.public_slug IS NULL AND o.org_name IS NULL
      AND NOT EXISTS (SELECT 1 FROM events kind_event WHERE kind_event.organizer_id=o.id)`);
    params.push(limit, offset);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `${accountListSelect} ${where}
       ORDER BY COALESCE(o.last_login_at,u.created_at) DESC,u.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const summary = (await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE account_status='active')::int AS active,
              COUNT(*) FILTER (WHERE account_status='active' AND EXISTS (
                SELECT 1 FROM organizers o WHERE o.user_id=users.id
                  AND o.last_login_at >= NOW() - INTERVAL '30 days'
              ))::int AS active_30_days,
              COUNT(*) FILTER (WHERE account_status='suspended')::int AS suspended,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM organizers o WHERE o.user_id=users.id AND o.is_admin
              ))::int AS admins,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM organizers o WHERE o.user_id=users.id
                  AND o.public_slug IS NOT NULL
              ))::int AS host_pages
         FROM users`
    )).rows[0];
    res.json({
      accounts: rows.map(accountListItem),
      summary,
      limit,
      offset,
      nextCursor: rows.length === limit ? String(offset + limit) : null
    });
  } catch (error) { next(error); }
});

router.get('/api/admin/accounts/invitations', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    const { rows } = await pool.query(
      `SELECT invitation.id,invitation.email,invitation.name,invitation.prepare_host_page,
              invitation.created_at,invitation.expires_at,invitation.sent_at,invitation.claimed_at,
              invitation.revoked_at,invitation.delivery_failed_at,invitation.claimed_user_id,
              creator.name AS created_by_name
         FROM admin_account_invitations invitation
         JOIN users creator ON creator.id=invitation.created_by_user_id
        ORDER BY invitation.created_at DESC
        LIMIT 100`
    );
    res.json({
      invitations: rows.map(row => ({
        id: Number(row.id),
        name: row.name,
        email: maskEmail(row.email),
        prepareHostPage: row.prepare_host_page,
        status: row.claimed_at ? 'claimed'
          : (row.revoked_at ? 'revoked'
            : (row.delivery_failed_at ? 'delivery_failed'
              : (new Date(row.expires_at) <= new Date() ? 'expired'
                : (row.sent_at ? 'sent' : 'creating')))),
        claimedUserId: row.claimed_user_id ? Number(row.claimed_user_id) : null,
        createdByName: row.created_by_name,
        createdAt: row.created_at,
        sentAt: row.sent_at,
        expiresAt: row.expires_at,
        claimedAt: row.claimed_at
      }))
    });
  } catch (error) { next(error); }
});

router.get('/api/admin/accounts/:id', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    const userId = positiveId(req.params.id);
    if (!userId) return res.status(404).json({ error: 'Account not found' });
    const accountResult = await pool.query(`${accountListSelect} WHERE u.id=$1`, [userId]);
    const row = accountResult.rows[0];
    if (!row) return res.status(404).json({ error: 'Account not found' });

    const [identityResult, ownershipResult, eventResult, notesResult, auditResult, conflictResult] = await Promise.all([
      pool.query(
        `SELECT id,identity_type,value,verified_at,verification_scope,is_primary,
                revoked_at,created_at
           FROM user_identities
          WHERE user_id=$1 AND revoked_at IS NULL
            AND verification_scope='account' AND verified_at IS NOT NULL
          ORDER BY identity_type,is_primary DESC,id`,
        [userId]
      ),
      pool.query(
        `SELECT
          (SELECT COUNT(*) FROM events e WHERE e.organizer_id=$1)::int AS events,
          (SELECT COUNT(*) FROM rsvps r WHERE r.user_id=$1 OR (r.user_id IS NULL AND r.account_id=$1))::int AS rsvps,
          (SELECT COUNT(*) FROM host_follows f WHERE f.follower_user_id=$1 AND f.unsubscribed_at IS NULL)::int AS following,
          (SELECT COUNT(*) FROM host_follows f WHERE f.host_organizer_id=$1 AND f.unsubscribed_at IS NULL)::int AS followers,
          (SELECT COUNT(*) FROM event_photos p WHERE p.uploader_user_id=$1)::int AS uploaded_photos,
          (SELECT COUNT(*) FROM message_log m WHERE m.recipient_user_id=$1)::int AS messages`,
        [userId]
      ),
      pool.query(
        `SELECT id,title,slug,event_date,status,visibility,created_at
           FROM events WHERE organizer_id=$1
          ORDER BY event_date DESC,id DESC LIMIT 50`,
        [userId]
      ),
      pool.query(
        `SELECT note.id,note.note,note.created_at,author.id AS author_user_id,
                author.name AS actor_name
           FROM admin_account_support_notes note
           JOIN users author ON author.id=note.author_user_id
          WHERE note.target_user_id=$1
          ORDER BY note.created_at DESC,note.id DESC LIMIT 100`,
        [userId]
      ),
      pool.query(
        `SELECT audit.id,audit.action_type,audit.action_type AS action,audit.reason,audit.before_state,
                audit.after_state,audit.metadata,audit.created_at,
                actor.id AS actor_user_id,actor.name AS actor_name
           FROM admin_account_audit_log audit
           JOIN users actor ON actor.id=audit.actor_user_id
          WHERE audit.target_user_id=$1
          ORDER BY audit.created_at DESC,audit.id DESC LIMIT 100`,
        [userId]
      ),
      pool.query(
        `SELECT
          (SELECT COUNT(*) FROM user_identity_conflicts c
            WHERE c.resolved_at IS NULL
              AND (c.candidate_user_id=$1 OR c.conflicting_user_id=$1))::int AS identity_conflicts,
          (SELECT COUNT(*) FROM canonical_user_link_conflicts c
            WHERE c.resolved_at IS NULL
              AND (c.first_candidate_user_id=$1 OR c.second_candidate_user_id=$1))::int AS relationship_conflicts`,
        [userId]
      )
    ]);

    const account = {
      ...accountListItem(row),
      // Detail sign-in methods must reflect only proved account identities.
      // `organizers.email` is a legacy/contact compatibility field and may
      // belong to an RSVP-only shell that has never claimed an account.
      email: row.verified_email ? maskEmail(row.verified_email) : null,
      primary_email_masked: row.verified_email ? maskEmail(row.verified_email) : null,
      phone: row.verified_phone ? maskPhone(row.verified_phone) : null,
      primary_phone_masked: row.verified_phone ? maskPhone(row.verified_phone) : null,
      smsCredits: Number(row.sms_credits || 0),
      suspensionReason: row.suspension_reason || null,
      can_suspend: Number(req.organizer.user_id || req.organizer.id) !== userId,
      can_sign_out: Number(req.organizer.user_id || req.organizer.id) !== userId
    };
    res.json({
      account,
      identities: identityResult.rows.map(identity => ({
        id: Number(identity.id),
        type: identity.identity_type,
        maskedValue: maskIdentity(identity.identity_type, identity.value),
        verifiedAt: identity.verified_at,
        verificationScope: identity.verification_scope,
        isPrimary: identity.is_primary,
        revokedAt: identity.revoked_at,
        createdAt: identity.created_at
      })),
      ownership: {
        event_count: Number(ownershipResult.rows[0].events || 0),
        rsvp_count: Number(ownershipResult.rows[0].rsvps || 0),
        following_count: Number(ownershipResult.rows[0].following || 0),
        follower_count: Number(ownershipResult.rows[0].followers || 0),
        photo_count: Number(ownershipResult.rows[0].uploaded_photos || 0),
        message_count: Number(ownershipResult.rows[0].messages || 0),
        active_session_count: null,
        identity_conflict_count: Number(conflictResult.rows[0].identity_conflicts || 0) +
          Number(conflictResult.rows[0].relationship_conflicts || 0),
        host_page: row.public_slug ? {
          organizer_id: Number(row.id),
          name: row.org_name || row.name,
          org_name: row.org_name || row.name,
          public_slug: row.public_slug,
          bio: row.bio || null,
          website_url: row.website_url || null,
          instagram_handle: row.instagram_handle || null,
          has_contact_email: Boolean(row.contact_email)
        } : null,
        events: eventResult.rows
      },
      sessions: {
        validAfter: row.sessions_valid_after || null,
        individuallyTracked: false
      },
      conflicts: conflictResult.rows[0],
      notes: notesResult.rows,
      audit: auditResult.rows
    });
  } catch (error) { next(error); }
});

router.patch('/api/admin/accounts/:id/profile', async (req, res, next) => {
  const userId = positiveId(req.params.id);
  const name = cleanName(req.body?.name);
  const reason = cleanReason(req.body?.reason);
  if (!userId) return res.status(404).json({ error: 'Account not found' });
  if (name.length < 1) return res.status(400).json({ error: 'Enter a display name' });
  if (!reason || reason.length < 8) return res.status(400).json({ error: 'Add a short reason for changing this name' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = await lockAccount(client, userId);
    if (!account) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found' });
    }
    await client.query('UPDATE users SET name=$2,updated_at=NOW() WHERE id=$1', [userId, name]);
    await client.query('UPDATE organizers SET name=$2,updated_at=NOW() WHERE user_id=$1', [userId, name]);
    await writeAudit(client, req, {
      targetUserId: userId,
      actionType: 'profile_name_updated',
      reason,
      beforeState: { name: account.name || null },
      afterState: { name }
    });
    await client.query('COMMIT');
    res.json({ ok: true, account: { id: userId, name } });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

router.post('/api/admin/accounts/:id/sign-out-all', async (req, res, next) => {
  const userId = positiveId(req.params.id);
  const actorUserId = Number(req.organizer.user_id || req.organizer.id);
  const reason = cleanReason(req.body?.reason);
  if (!userId) return res.status(404).json({ error: 'Account not found' });
  if (userId === actorUserId) {
    return res.status(400).json({ error: 'Use your Account settings to sign yourself out everywhere' });
  }
  if (!reason) return res.status(400).json({ error: 'Add a reason for signing this account out' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = await lockAccount(client, userId);
    if (!account) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found' });
    }
    const result = await invalidateAccountAccess(client, userId);
    await writeAudit(client, req, {
      targetUserId: userId,
      actionType: 'sessions_revoked',
      reason,
      beforeState: { sessionsValidAfter: account.sessions_valid_after || null },
      afterState: result
    });
    await client.query('COMMIT');
    res.json({ ok: true, sessions: { validAfter: result.invalidatedAt, individuallyTracked: false } });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

router.post('/api/admin/accounts/:id/suspend', async (req, res, next) => {
  const userId = positiveId(req.params.id);
  const actorUserId = Number(req.organizer.user_id || req.organizer.id);
  const reason = cleanReason(req.body?.reason);
  if (!userId) return res.status(404).json({ error: 'Account not found' });
  if (userId === actorUserId) return res.status(400).json({ error: 'You cannot suspend your own account' });
  if (!reason) return res.status(400).json({ error: 'Add a reason for suspending this account' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('silver-glider-admin-suspension'))");
    const account = await lockAccount(client, userId);
    if (!account) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found' });
    }
    if (account.account_status === 'suspended') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Account is already suspended' });
    }
    if (account.is_admin) {
      const activeAdmins = await client.query(
        `SELECT COUNT(*)::int AS count
           FROM users u JOIN organizers o ON o.user_id=u.id
          WHERE o.is_admin AND u.account_status='active'`
      );
      if (Number(activeAdmins.rows[0].count) <= 1) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'The last active administrator cannot be suspended' });
      }
    }
    const suspendedAt = new Date();
    await client.query(
      `UPDATE users
          SET account_status='suspended',suspended_at=$2,
              suspended_by_user_id=$3,suspension_reason=$4,updated_at=NOW()
        WHERE id=$1`,
      [userId, suspendedAt, actorUserId, reason]
    );
    const access = await invalidateAccountAccess(client, userId);
    await writeAudit(client, req, {
      targetUserId: userId,
      actionType: 'account_suspended',
      reason,
      beforeState: { status: 'active' },
      afterState: { status: 'suspended', suspendedAt: suspendedAt.toISOString(), ...access }
    });
    await client.query('COMMIT');
    res.json({ ok: true, status: 'suspended', suspendedAt });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

router.post('/api/admin/accounts/:id/reactivate', async (req, res, next) => {
  const userId = positiveId(req.params.id);
  const reason = cleanReason(req.body?.reason);
  if (!userId) return res.status(404).json({ error: 'Account not found' });
  if (!reason) return res.status(400).json({ error: 'Add a reason for reactivating this account' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = await lockAccount(client, userId);
    if (!account) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found' });
    }
    if (account.account_status === 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Account is already active' });
    }
    await client.query(
      `UPDATE users
          SET account_status='active',suspended_at=NULL,suspended_by_user_id=NULL,
              suspension_reason=NULL,updated_at=NOW()
        WHERE id=$1`,
      [userId]
    );
    await writeAudit(client, req, {
      targetUserId: userId,
      actionType: 'account_reactivated',
      reason,
      beforeState: {
        status: 'suspended',
        suspendedAt: account.suspended_at,
        suspensionReason: account.suspension_reason
      },
      afterState: { status: 'active' }
    });
    await client.query('COMMIT');
    res.json({ ok: true, status: 'active' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

router.post('/api/admin/accounts/:id/notes', async (req, res, next) => {
  const userId = positiveId(req.params.id);
  const note = String(req.body?.note || '').trim().replace(/\r\n?/g, '\n').slice(0, 2000);
  if (!userId) return res.status(404).json({ error: 'Account not found' });
  if (note.length < 2) return res.status(400).json({ error: 'Enter a support note' });
  const actorUserId = Number(req.organizer.user_id || req.organizer.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = await lockAccount(client, userId);
    if (!account) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found' });
    }
    const { rows } = await client.query(
      `INSERT INTO admin_account_support_notes (target_user_id,author_user_id,note)
       VALUES ($1,$2,$3)
       RETURNING id,target_user_id,author_user_id,note,created_at`,
      [userId, actorUserId, note]
    );
    await writeAudit(client, req, {
      targetUserId: userId,
      actionType: 'support_note_added',
      reason: 'Support note added',
      afterState: { noteId: Number(rows[0].id) }
    });
    await client.query('COMMIT');
    res.status(201).json({ note: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

router.post('/api/admin/accounts/invitations', async (req, res, next) => {
  const name = cleanName(req.body?.name);
  const email = cleanEmail(req.body?.email);
  const prepareHostPage = req.body?.prepareHostPage === true;
  if (name.length < 2) return res.status(400).json({ error: 'Enter the person’s name' });
  if (!email) return res.status(400).json({ error: 'Enter a valid email' });
  const rate = inviteLimiter.consume({
    adminId: String(req.organizer.user_id || req.organizer.id),
    ip: clientIp(req)
  });
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)));
    return res.status(429).json({ error: 'Too many account invitations. Try again later.' });
  }

  const client = await pool.connect();
  let challenge;
  let invitation;
  try {
    await client.query('BEGIN');
    await lockInvitationEmail(client, email);
    await revokeStaleUnsentInvitations(client, req, email);
    const existing = await client.query(
      `SELECT u.id
         FROM users u
         JOIN organizers o ON o.user_id=u.id
        WHERE EXISTS (
                SELECT 1 FROM user_identities identity
                 WHERE identity.user_id=u.id AND identity.identity_type='email'
                   AND identity.normalized_value=$1 AND identity.revoked_at IS NULL
                   AND identity.verification_scope='account'
                   AND identity.verified_at IS NOT NULL
              )
           OR (LOWER(BTRIM(o.email))=$1 AND (
                u.account_status='suspended'
                OR o.is_admin OR o.last_login_at IS NOT NULL
                OR o.public_slug IS NOT NULL OR o.org_name IS NOT NULL
                OR EXISTS (SELECT 1 FROM events event WHERE event.organizer_id=o.id)
                OR EXISTS (
                  SELECT 1 FROM user_identities proof
                   WHERE proof.user_id=u.id AND proof.revoked_at IS NULL
                     AND proof.verification_scope='account'
                     AND proof.verified_at IS NOT NULL
                )
              ))
        LIMIT 1`,
      [email]
    );
    if (existing.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'account_already_exists',
        message: 'That email already belongs to an account. Open the account to help them sign in.'
      });
    }
    const pending = await client.query(
      `SELECT id FROM admin_account_invitations
        WHERE email=$1 AND claimed_at IS NULL AND revoked_at IS NULL
          AND delivery_failed_at IS NULL AND expires_at>NOW()
        FOR UPDATE`,
      [email]
    );
    if (pending.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An active invitation was already sent to that email' });
    }
    challenge = await createSignInChallenge(client, {
      email,
      intent: 'claim_account',
      returnPath: '/dashboard',
      ttlMinutes: ACCOUNT_INVITE_TTL_MINUTES,
      withCode: false
    });
    let tokenId = challenge.id;
    if (!tokenId) {
      tokenId = (await client.query(
        'SELECT id FROM magic_link_tokens WHERE token=$1',
        [tokenHash(challenge.token)]
      )).rows[0]?.id;
    }
    const inserted = await client.query(
      `INSERT INTO admin_account_invitations
         (email,name,prepare_host_page,magic_link_token_id,created_by_user_id,expires_at)
       VALUES ($1,$2,$3,$4,$5,NOW() + INTERVAL '7 days')
       RETURNING id,email,name,prepare_host_page,created_at,expires_at`,
      [email, name, prepareHostPage, tokenId, Number(req.organizer.user_id || req.organizer.id)]
    );
    invitation = inserted.rows[0];
    await writeAudit(client, req, {
      actionType: 'account_invitation_created',
      reason: 'Create account invitation',
      afterState: {
        invitationId: Number(invitation.id),
        email: maskEmail(email),
        name,
        prepareHostPage,
        invitationStatus: 'creating'
      },
      metadata: { invitationId: Number(invitation.id) }
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return next(error);
  } finally { client.release(); }

  const claimUrl = `${String(process.env.APP_URL || '').replace(/\/$/, '')}/auth/verify?token=${challenge.token}`;
  try {
    await deliverAccountClaimInvitation({ to: email, link: claimUrl, name });
  } catch (error) {
    let failedAt = null;
    try {
      failedAt = await markInvitationDeliveryFailed(invitation);
    } catch (_) {
      console.error('[account-invitation] could not persist provider failure', {
        invitationId: Number(invitation.id)
      });
    }
    if (failedAt) {
      await appendInvitationAuditBestEffort(req, {
        actionType: 'account_invitation_delivery_failed',
        reason: 'Account invitation email delivery failed',
        beforeState: { invitationStatus: 'creating' },
        afterState: { invitationStatus: 'delivery_failed', failedAt },
        metadata: { invitationId: Number(invitation.id) }
      });
    }
    await logInvitationDeliveryBestEffort(email, 'failed', error);
    return next(error);
  }

  // Persist delivery before non-authoritative audit/message telemetry. A
  // telemetry outage must not invalidate a bearer link already in the inbox.
  const sentAt = await markInvitationSent(invitation);
  invitation.sent_at = sentAt;
  await appendInvitationAuditBestEffort(req, {
    actionType: 'account_invitation_sent',
    reason: 'Account invitation email sent',
    beforeState: { invitationStatus: 'creating' },
    afterState: { invitationStatus: 'sent', sentAt },
    metadata: { invitationId: Number(invitation.id) }
  });
  await logInvitationDeliveryBestEffort(email, 'sent');

  res.status(201).json({
    invitation: {
      id: Number(invitation.id),
      name: invitation.name,
      email: maskEmail(invitation.email),
      prepareHostPage: invitation.prepare_host_page,
      status: 'sent',
      createdAt: invitation.created_at,
      sentAt: invitation.sent_at,
      expiresAt: invitation.expires_at
    }
  });
});

// Test-only hooks for deterministic provider failures and process-wide limits.
router.setAccountClaimSenderForTests = sender => {
  deliverAccountClaimInvitation = typeof sender === 'function'
    ? sender
    : sendAccountClaimInvitation;
};
router.resetRateLimitsForTests = () => inviteLimiter.reset();

module.exports = router;
