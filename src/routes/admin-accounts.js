const express = require('express');
const pool = require('../config/db');
const requireAdmin = require('../middleware/requireAdmin');
const { actorIds, isDedicatedSuperAdmin } = require('../middleware/requireAdmin');
const { createSignInChallenge } = require('../lib/sign-in-challenges');
const { sendAccountClaimInvitation } = require('../lib/mailer');
const { clientIp, createRateLimiter } = require('../lib/rate-limit');
const { tokenHash } = require('../lib/guest-session');
const { isManagedPublicId, managedPublicIdFromUrl } = require('../lib/cloudinary');
const { queueManagedMediaDeletionJobs } = require('../jobs/managed-media-deletions');
const { outboundDeliveryLockKey } = require('../lib/outbound-account-status');
const { listIdentityChangeRequests } = require('../lib/admin-identity-changes');
const {
  clearAdminActionProofCookie,
  consumeAdminActionProof
} = require('./admin-auth');

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
  const actor = actorIds(req);
  await client.query(
    `INSERT INTO admin_account_audit_log
       (actor_user_id,actor_admin_operator_id,target_user_id,action_type,reason,
        before_state,after_state,metadata,request_ip,user_agent)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10)`,
    [
      actor.actorUserId,
      actor.actorAdminOperatorId,
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
            o.id AS organizer_id,o.email,o.is_admin,o.plan,o.sms_credits,
            o.sessions_valid_after,o.org_name,o.public_slug,o.avatar_url,
            o.logo_url,o.header_image_url
       FROM users u
       JOIN organizers o ON o.user_id=u.id
      WHERE u.id=$1 AND u.account_status<>'deleted'
      FOR UPDATE OF u,o`,
    [userId]
  );
  return rows[0] || null;
}

async function invalidateAccountAccess(client, userId, organizerId) {
  const now = new Date();
  await client.query(
    'UPDATE organizers SET sessions_valid_after=$2 WHERE user_id=$1',
    [userId, now]
  );
  const identities = await client.query(
    `SELECT identity_type,value
       FROM user_identities
      WHERE user_id=$1 AND revoked_at IS NULL
        AND verification_scope='account' AND verified_at IS NOT NULL`,
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
    [organizerId, phones]
  );
  const identityChanges = await client.query(
    `UPDATE admin_account_identity_change_requests
        SET status='cancelled',cancelled_at=NOW(),updated_at=NOW()
      WHERE target_user_id=$1 AND status='pending'
      RETURNING id`,
    [userId]
  );
  const claimInvitations = await client.query(
    `UPDATE admin_account_invitations
        SET revoked_at=COALESCE(revoked_at,NOW())
      WHERE target_user_id=$1 AND claimed_at IS NULL
        AND revoked_at IS NULL AND delivery_failed_at IS NULL
      RETURNING id,magic_link_token_id`,
    [userId]
  );
  if (claimInvitations.rows.length) {
    await client.query(
      `UPDATE magic_link_tokens
          SET used_at=COALESCE(used_at,NOW())
        WHERE id=ANY($1::int[])`,
      [claimInvitations.rows.map(row => Number(row.magic_link_token_id))]
    );
  }
  const guestSessions = await client.query(
    `UPDATE guest_sessions
        SET revoked_at=COALESCE(revoked_at,NOW())
      WHERE revoked_at IS NULL
        AND (user_id=$1 OR identity_id=$2)
      RETURNING id`,
    [userId, organizerId]
  );
  return {
    public: {
      invalidatedAt: now.toISOString(),
      guestSessionsRevoked: guestSessions.rowCount || 0,
      identityChangesCancelled: identityChanges.rowCount || 0,
      claimInvitationsRevoked: claimInvitations.rowCount || 0
    },
    verifiedEmails: [...new Set(emails)],
    verifiedPhones: [...new Set(phones)]
  };
}

function deletionNotice(code, message, count = 0) {
  return { code, message, count: Number(count || 0) };
}

async function forfeitSmsCreditBalance(client, { organizerId, userId, balance }) {
  const credits = Number(balance || 0);
  if (!Number.isInteger(credits) || credits === 0) return;
  await client.query(
    `INSERT INTO sms_credit_transactions
       (organizer_id,kind,credits_delta,balance_after,external_key,metadata)
     VALUES ($1,'adjustment',$2,0,$3,$4::jsonb)
     ON CONFLICT (external_key) DO NOTHING`,
    [
      organizerId,
      -credits,
      `account-deletion:${userId}:sms-credit-forfeiture`,
      JSON.stringify({ reason: 'account_deletion', userId })
    ]
  );
  await client.query(
    'UPDATE organizers SET sms_credits=0,updated_at=NOW() WHERE id=$1',
    [organizerId]
  );
}

async function getAccountDeletionState(client, {
  userId,
  actorUserId,
  account,
  canDelete = true
}) {
  const organizerId = Number(account.organizer_id || userId);
  const { rows } = await client.query(
    `WITH owned_events AS (
       SELECT id FROM events WHERE organizer_id=$2
     ), owned_rsvps AS (
       SELECT id FROM rsvps WHERE event_id IN (SELECT id FROM owned_events)
     ), owned_notification_batches AS (
       SELECT id FROM event_notification_batches
        WHERE event_id IN (SELECT id FROM owned_events)
     ), owned_previous_invitation_batches AS (
       SELECT id FROM previous_guest_invitation_batches
        WHERE target_event_id IN (SELECT id FROM owned_events)
     ), owned_messages AS (
       SELECT id FROM message_log message
        WHERE message.event_id IN (SELECT id FROM owned_events)
           OR message.rsvp_id IN (SELECT id FROM owned_rsvps)
           OR message.notification_batch_id IN (SELECT id FROM owned_notification_batches)
           OR message.previous_guest_invitation_batch_id IN (
                SELECT id FROM owned_previous_invitation_batches
              )
     )
     SELECT
       (SELECT COUNT(*) FROM owned_events)::int AS events,
       (SELECT COUNT(*) FROM rsvps r
         WHERE r.user_id=$1 OR r.account_id=$2)::int AS rsvps,
       (SELECT COUNT(*) FROM owned_rsvps)::int AS owned_event_rsvps,
       (SELECT COUNT(*) FROM guest_sessions session
         WHERE session.verified_event_id IN (SELECT id FROM owned_events))::int
         AS owned_event_guest_sessions,
       (SELECT COUNT(*) FROM guest_invitation_tokens invitation
         WHERE invitation.target_event_id IN (SELECT id FROM owned_events)
            OR invitation.message_log_id IN (SELECT id FROM owned_messages))::int
         AS owned_event_invitations,
       (SELECT COUNT(*) FROM event_comments comment
         WHERE comment.event_id IN (SELECT id FROM owned_events))::int
         AS owned_event_comments,
       (SELECT COUNT(*) FROM owned_messages)::int AS owned_event_messages,
       (SELECT COUNT(*) FROM event_photos photo
         WHERE photo.event_id IN (SELECT id FROM owned_events))::int
         AS owned_event_photos,
       (SELECT COUNT(*) FROM sms_notification_recipients recipient
         WHERE recipient.batch_id IN (
           SELECT batch.id FROM sms_notification_batches batch
            WHERE batch.event_id IN (SELECT id FROM owned_events)
         ))::int AS owned_event_recipients,
       (SELECT COUNT(*) FROM host_follows f
         WHERE f.follower_user_id=$1 OR f.follower_organizer_id=$2)::int AS following,
       (SELECT COUNT(*) FROM host_follows f
         WHERE f.host_organizer_id=$2)::int AS followers,
       (SELECT COUNT(*) FROM user_identities i WHERE i.user_id=$1)::int AS identities,
       (SELECT COUNT(*) FROM sms_credit_purchases p WHERE p.organizer_id=$2)::int AS purchases,
       (SELECT COUNT(*) FROM events e
         WHERE e.organizer_id=$2 AND e.commerce_event_id IS NOT NULL)::int AS commerce_events,
       (SELECT COUNT(*) FROM admin_account_support_notes n
         WHERE n.target_user_id=$1)::int AS support_notes,
       (SELECT COUNT(*) FROM admin_account_audit_log audit
         WHERE audit.target_user_id=$1)::int AS support_audit_history,
       (SELECT COUNT(*) FROM event_photos photo
        WHERE photo.uploader_user_id=$1)::int AS uploaded_photos,
       (SELECT COUNT(*) FROM message_log message
        WHERE message.recipient_user_id=$1)::int AS messages`,
    [userId, organizerId]
  );
  const counts = rows[0];
  const blockers = [];
  if (!canDelete) {
    blockers.push(deletionNotice(
      'dedicated_super_admin_session',
      'Sign in through the dedicated admin login as a Super Admin to delete accounts.'
    ));
  }
  if (Number(userId) === Number(actorUserId)) {
    blockers.push(deletionNotice('self_account', 'You cannot delete the account you are using.'));
  }
  if (account.is_admin) {
    blockers.push(deletionNotice('administrator_account', 'Administrator accounts cannot be deleted.'));
  }

  const warnings = [];
  if (counts.events) warnings.push(deletionNotice('owned_events', 'Owned events and their dependent guest data will be removed.', counts.events));
  if (counts.owned_event_rsvps) warnings.push(deletionNotice('owned_event_rsvps', 'RSVPs on owned events will be removed.', counts.owned_event_rsvps));
  if (counts.owned_event_guest_sessions) warnings.push(deletionNotice('owned_event_guest_sessions', 'Guest sessions scoped to owned events will be removed.', counts.owned_event_guest_sessions));
  if (counts.owned_event_invitations) warnings.push(deletionNotice('owned_event_invitations', 'Guest invitations for owned events will be removed.', counts.owned_event_invitations));
  if (counts.owned_event_comments) warnings.push(deletionNotice('owned_event_comments', 'Comments on owned events will be removed.', counts.owned_event_comments));
  if (counts.owned_event_messages) warnings.push(deletionNotice('owned_event_messages', 'Queued and historical messages attached to owned events will be removed.', counts.owned_event_messages));
  if (counts.owned_event_photos) warnings.push(deletionNotice('owned_event_photos', 'Photos attached to owned events will be removed.', counts.owned_event_photos));
  if (counts.owned_event_recipients) warnings.push(deletionNotice('owned_event_recipients', 'Text recipients attached to owned events will be removed.', counts.owned_event_recipients));
  if (counts.rsvps) warnings.push(deletionNotice('linked_rsvps', 'RSVP records linked to this account will be removed.', counts.rsvps));
  if (counts.following) warnings.push(deletionNotice('following', 'Host follows created by this account will be removed.', counts.following));
  if (counts.followers) warnings.push(deletionNotice('followers', 'Followers of this Host Page will be disconnected.', counts.followers));
  if (counts.uploaded_photos) warnings.push(deletionNotice('uploaded_photos', 'Uploaded managed photos will be removed when no surviving record uses them.', counts.uploaded_photos));
  if (counts.messages) warnings.push(deletionNotice('delivery_history', 'Delivery records will be anonymized or removed with owned content.', counts.messages));
  if (Number(account.sms_credits || 0)) warnings.push(deletionNotice('sms_credit_balance', 'Unused text credits will be forfeited.', account.sms_credits));
  if (counts.purchases) warnings.push(deletionNotice('financial_history_retained', 'Anonymized purchase and ledger history will be retained.', counts.purchases));
  if (counts.support_notes || counts.support_audit_history) {
    warnings.push(deletionNotice(
      'support_history_retained',
      'Operator-authored support notes and administrator audit history are retained and may still contain information staff entered.',
      Number(counts.support_notes || 0) + Number(counts.support_audit_history || 0)
    ));
  }
  if (counts.commerce_events) warnings.push(deletionNotice('commerce_links', 'Owned Commerce-linked event records will be removed from Events.', counts.commerce_events));

  return {
    public: {
      allowed: blockers.length === 0,
      blockers,
      warnings,
      confirmationText: `DELETE USER ${userId}`,
      requiresFreshVerification: true,
      summary: {
        events: Number(counts.events || 0),
        rsvps: Number(counts.rsvps || 0),
        ownedEventRsvps: Number(counts.owned_event_rsvps || 0),
        ownedEventGuestSessions: Number(counts.owned_event_guest_sessions || 0),
        ownedEventInvitations: Number(counts.owned_event_invitations || 0),
        ownedEventComments: Number(counts.owned_event_comments || 0),
        ownedEventMessages: Number(counts.owned_event_messages || 0),
        ownedEventPhotos: Number(counts.owned_event_photos || 0),
        ownedEventRecipients: Number(counts.owned_event_recipients || 0),
        following: Number(counts.following || 0),
        followers: Number(counts.followers || 0),
        identities: Number(counts.identities || 0),
        uploadedPhotos: Number(counts.uploaded_photos || 0),
        messages: Number(counts.messages || 0),
        purchases: Number(counts.purchases || 0),
        smsCredits: Number(account.sms_credits || 0)
      }
    },
    private: { organizerId }
  };
}

const accountListSelect = `
  SELECT u.id,u.name,u.account_status,u.suspended_at,u.suspension_reason,
         u.created_at,u.updated_at,
         o.id AS organizer_id,o.email,o.is_admin,o.plan,o.last_login_at,o.org_name,o.public_slug,
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
           ORDER BY i.is_primary DESC,i.id ASC LIMIT 1) AS verified_phone,
         (SELECT r.email FROM rsvps r
           WHERE r.user_id=u.id OR (r.user_id IS NULL AND r.account_id=o.id)
           ORDER BY r.created_at DESC,r.id DESC LIMIT 1) AS rsvp_email,
         (SELECT r.phone FROM rsvps r
           WHERE (r.user_id=u.id OR (r.user_id IS NULL AND r.account_id=o.id))
             AND NULLIF(BTRIM(r.phone),'') IS NOT NULL
           ORDER BY r.created_at DESC,r.id DESC LIMIT 1) AS rsvp_phone
    FROM users u
    LEFT JOIN organizers o ON o.user_id=u.id`;

function preferredAccountContacts(row) {
  const verifiedEmail = String(row.verified_email || '').trim() || null;
  const verifiedPhone = String(row.verified_phone || '').trim() || null;
  const contactEmail = [row.contact_email, row.email, row.rsvp_email]
    .map(value => String(value || '').trim())
    .find(value => value && value.toLowerCase() !== String(verifiedEmail || '').toLowerCase()) || null;
  const rsvpPhone = String(row.rsvp_phone || '').trim();
  const contactPhone = rsvpPhone && rsvpPhone !== verifiedPhone ? rsvpPhone : null;
  const email = verifiedEmail || contactEmail;
  const phone = verifiedPhone || contactPhone;
  const emailLabel = verifiedEmail
    ? 'Verified sign-in email'
    : (contactEmail
      ? (String(row.rsvp_email || '').trim().toLowerCase() === contactEmail.toLowerCase() &&
          ![row.contact_email, row.email].some(value => String(value || '').trim().toLowerCase() === contactEmail.toLowerCase())
        ? 'RSVP email (not verified for sign-in)'
        : 'Contact email (not verified for sign-in)')
      : 'No email on file');
  const phoneLabel = verifiedPhone
    ? 'Verified sign-in phone'
    : (contactPhone ? 'RSVP phone (not verified for sign-in)' : 'No phone on file');
  return { verifiedEmail, verifiedPhone, contactEmail, contactPhone, email, phone, emailLabel, phoneLabel };
}

function accountContactMethods(row, identities, rsvpContacts) {
  const verified = new Set(identities.map(identity => (
    `${identity.identity_type}:${String(identity.value || '').trim().toLowerCase()}`
  )));
  const seen = new Set();
  const methods = [];
  const add = (type, value, source, label) => {
    const cleaned = String(value || '').trim();
    if (!cleaned) return;
    const key = `${type}:${cleaned.toLowerCase()}`;
    if (verified.has(key) || seen.has(key)) return;
    seen.add(key);
    methods.push({ type, value: cleaned, label, source, verifiedForSignIn: false });
  };
  add('email', row.contact_email, 'host_contact', 'Contact email (not verified for sign-in)');
  add('email', row.email, 'legacy_contact', 'Contact email (not verified for sign-in)');
  for (const contact of rsvpContacts) {
    add('email', contact.email, 'rsvp', 'RSVP email (not verified for sign-in)');
    add('phone', contact.phone, 'rsvp', 'RSVP phone (not verified for sign-in)');
  }
  return methods;
}

function accountListItem(row) {
  const kind = row.is_admin ? 'admin' : (row.public_slug || row.org_name || row.event_count > 0 ? 'host' : 'guest');
  const contacts = preferredAccountContacts(row);
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
    email: contacts.email,
    phone: contacts.phone,
    emailLabel: contacts.emailLabel,
    phoneLabel: contacts.phoneLabel,
    verifiedEmail: contacts.verifiedEmail,
    verifiedPhone: contacts.verifiedPhone,
    contactEmail: contacts.contactEmail,
    contactPhone: contacts.contactPhone,
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

// All canonical users, including guest-only accounts. Authorized administrators
// receive complete contact values with explicit verification labels.
router.get('/api/admin/accounts', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    const q = cleanText(req.query.q, 120).toLowerCase();
    const status = ['active', 'suspended'].includes(req.query.status) ? req.query.status : '';
    const type = ['admin', 'host', 'guest'].includes(req.query.type) ? req.query.type : '';
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 100);
    const offset = Math.max(Number.parseInt(req.query.cursor ?? req.query.offset, 10) || 0, 0);
    const params = [];
    const conditions = [`u.account_status<>'deleted'`];
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
        OR LOWER(COALESCE(o.email,'')) LIKE $${n}
        OR LOWER(COALESCE(o.contact_email,'')) LIKE $${n}
        OR EXISTS (
          SELECT 1 FROM user_identities search_identity
           WHERE search_identity.user_id=u.id AND search_identity.revoked_at IS NULL
             AND LOWER(search_identity.normalized_value) LIKE $${n}
        )
        OR EXISTS (
          SELECT 1 FROM rsvps search_rsvp
           WHERE (search_rsvp.user_id=u.id
                  OR (search_rsvp.user_id IS NULL AND search_rsvp.account_id=o.id))
             AND (LOWER(search_rsvp.email) LIKE $${n}
                  OR LOWER(COALESCE(search_rsvp.phone,'')) LIKE $${n})
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
         FROM users
        WHERE account_status<>'deleted'`
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
              COALESCE(creator.name,operator.email,'Administrator') AS created_by_name
         FROM admin_account_invitations invitation
         LEFT JOIN users creator ON creator.id=invitation.created_by_user_id
         LEFT JOIN admin_operators operator
           ON operator.id=invitation.created_by_admin_operator_id
        ORDER BY invitation.created_at DESC
        LIMIT 100`
    );
    res.json({
      invitations: rows.map(row => ({
        id: Number(row.id),
        name: row.name,
        email: row.email,
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
    const accountResult = await pool.query(
      `${accountListSelect} WHERE u.id=$1 AND u.account_status<>'deleted'`,
      [userId]
    );
    const row = accountResult.rows[0];
    if (!row) return res.status(404).json({ error: 'Account not found' });

    const { actorUserId } = actorIds(req);
    const [identityResult, contactResult, ownershipResult, eventResult, notesResult, auditResult,
      conflictResult, deletionState, identityChangeRequests] = await Promise.all([
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
        `SELECT DISTINCT email,phone
           FROM rsvps
          WHERE user_id=$1 OR account_id=$1
          ORDER BY email,phone`,
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
                operator.id AS author_admin_operator_id,
                COALESCE(author.name,operator.email,'Administrator') AS actor_name
           FROM admin_account_support_notes note
           LEFT JOIN users author ON author.id=note.author_user_id
           LEFT JOIN admin_operators operator
             ON operator.id=note.author_admin_operator_id
          WHERE note.target_user_id=$1
          ORDER BY note.created_at DESC,note.id DESC LIMIT 100`,
        [userId]
      ),
      pool.query(
        `SELECT audit.id,audit.action_type,audit.action_type AS action,audit.reason,audit.before_state,
                audit.after_state,audit.metadata,audit.created_at,
                actor.id AS actor_user_id,operator.id AS actor_admin_operator_id,
                COALESCE(actor.name,operator.email,'Administrator') AS actor_name
           FROM admin_account_audit_log audit
           LEFT JOIN users actor ON actor.id=audit.actor_user_id
           LEFT JOIN admin_operators operator
             ON operator.id=audit.actor_admin_operator_id
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
      ),
      getAccountDeletionState(pool, {
        userId,
        actorUserId,
        account: row,
        canDelete: isDedicatedSuperAdmin(req)
      }),
      req.adminOperator ? listIdentityChangeRequests(pool, userId) : Promise.resolve([])
    ]);

    const preferredContacts = preferredAccountContacts(row);
    const contactMethods = accountContactMethods(row, identityResult.rows, contactResult.rows);
    const primaryEmailIdentity = identityResult.rows.find(identity => identity.identity_type === 'email') || null;
    const primaryPhoneIdentity = identityResult.rows.find(identity => identity.identity_type === 'phone') || null;
    const fallbackEmail = contactMethods.find(method => method.type === 'email') || null;
    const fallbackPhone = contactMethods.find(method => method.type === 'phone') || null;
    const account = {
      ...accountListItem(row),
      // Detail sign-in methods must reflect only proved account identities.
      // `organizers.email` is a legacy/contact compatibility field and may
      // belong to an RSVP-only shell that has never claimed an account.
      email: preferredContacts.verifiedEmail,
      phone: preferredContacts.verifiedPhone,
      contactEmail: fallbackEmail?.value || null,
      contactPhone: fallbackPhone?.value || null,
      emailLabel: primaryEmailIdentity ? 'Verified sign-in email' : (fallbackEmail?.label || 'No email on file'),
      phoneLabel: primaryPhoneIdentity ? 'Verified sign-in phone' : (fallbackPhone?.label || 'No phone on file'),
      smsCredits: Number(row.sms_credits || 0),
      suspensionReason: row.suspension_reason || null,
      can_suspend: actorUserId !== userId,
      can_sign_out: actorUserId !== userId
    };
    res.json({
      account,
      identities: identityResult.rows.map(identity => ({
        id: Number(identity.id),
        type: identity.identity_type,
        value: identity.value,
        label: identity.identity_type === 'email' ? 'Verified sign-in email' : 'Verified sign-in phone',
        verifiedAt: identity.verified_at,
        verificationScope: identity.verification_scope,
        isPrimary: identity.is_primary,
        revokedAt: identity.revoked_at,
        createdAt: identity.created_at
      })),
      contactMethods,
      contactSummary: {
        email: primaryEmailIdentity
          ? { value: primaryEmailIdentity.value, label: 'Verified sign-in email', verifiedForSignIn: true }
          : (fallbackEmail || { value: null, label: 'No email on file', verifiedForSignIn: false }),
        phone: primaryPhoneIdentity
          ? { value: primaryPhoneIdentity.value, label: 'Verified sign-in phone', verifiedForSignIn: true }
          : (fallbackPhone || { value: null, label: 'No phone on file', verifiedForSignIn: false })
      },
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
      identityChangeRequests,
      deletion: deletionState.public,
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
  const { actorUserId } = actorIds(req);
  const reason = cleanReason(req.body?.reason);
  if (!userId) return res.status(404).json({ error: 'Account not found' });
  if (userId === actorUserId) {
    return res.status(400).json({ error: 'Use your Account settings to sign yourself out everywhere' });
  }
  if (!reason) return res.status(400).json({ error: 'Add a reason for signing this account out' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [outboundDeliveryLockKey(userId)]
    );
    const account = await lockAccount(client, userId);
    if (!account) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found' });
    }
    const result = await invalidateAccountAccess(client, userId, account.organizer_id);
    await writeAudit(client, req, {
      targetUserId: userId,
      actionType: 'sessions_revoked',
      reason,
      beforeState: { sessionsValidAfter: account.sessions_valid_after || null },
      afterState: result.public
    });
    await client.query('COMMIT');
    res.json({ ok: true, sessions: { validAfter: result.public.invalidatedAt, individuallyTracked: false } });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

router.post('/api/admin/accounts/:id/suspend', async (req, res, next) => {
  const userId = positiveId(req.params.id);
  const actor = actorIds(req);
  const { actorUserId, actorAdminOperatorId } = actor;
  const reason = cleanReason(req.body?.reason);
  if (!userId) return res.status(404).json({ error: 'Account not found' });
  if (userId === actorUserId) return res.status(400).json({ error: 'You cannot suspend your own account' });
  if (!reason) return res.status(400).json({ error: 'Add a reason for suspending this account' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('silver-glider-admin-suspension'))");
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [outboundDeliveryLockKey(userId)]
    );
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
              suspended_by_user_id=$3,suspended_by_admin_operator_id=$4,
              suspension_reason=$5,updated_at=NOW()
        WHERE id=$1`,
      [userId, suspendedAt, actorUserId, actorAdminOperatorId, reason]
    );
    const access = await invalidateAccountAccess(client, userId, account.organizer_id);
    await writeAudit(client, req, {
      targetUserId: userId,
      actionType: 'account_suspended',
      reason,
      beforeState: { status: 'active' },
      afterState: { status: 'suspended', suspendedAt: suspendedAt.toISOString(), ...access.public }
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
              suspended_by_admin_operator_id=NULL,
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

// Permanent deletion requires an independent Super Admin session plus a fresh
// target/action-bound proof. The proof is consumed inside the same serializable
// transaction, so a rollback preserves it and a committed deletion cannot
// reuse it. Ordinary history remains an impact warning rather than a blocker.
router.post('/api/admin/accounts/:id/delete-account', async (req, res, next) => {
  const userId = positiveId(req.params.id);
  const actor = actorIds(req);
  const { actorUserId, actorAdminOperatorId } = actor;
  const reason = cleanReason(req.body?.reason);
  const confirmation = String(req.body?.confirmation || '').trim();
  if (!isDedicatedSuperAdmin(req)) {
    return res.status(403).json({
      error: 'dedicated_super_admin_required',
      message: 'Sign in through the dedicated admin login as a Super Admin to delete accounts.'
    });
  }
  if (!userId) return res.status(404).json({ error: 'Account not found' });
  if (!reason || reason.length < 8) {
    return res.status(400).json({
      error: 'deletion_reason_required',
      message: 'Add a reason of at least 8 characters.'
    });
  }
  if (confirmation !== `DELETE USER ${userId}`) {
    return res.status(400).json({
      error: 'deletion_confirmation_mismatch',
      message: `Type DELETE USER ${userId} exactly.`
    });
  }
  const client = await pool.connect();
  let mediaJobIds = [];
  let mediaCleanupQueued = 0;
  let responseSummary = null;
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [outboundDeliveryLockKey(userId)]
    );
    const account = await lockAccount(client, userId);
    if (!account) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found' });
    }
    // Lock every owned event before the impact snapshot. This prevents new
    // dependent records appearing between review and deletion.
    await client.query(
      'SELECT id FROM events WHERE organizer_id=$1 FOR UPDATE',
      [account.organizer_id]
    );
    const deletionState = await getAccountDeletionState(client, {
      userId,
      actorUserId,
      account,
      canDelete: true
    });
    if (!deletionState.public.allowed) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'account_not_deletable',
        message: deletionState.public.blockers[0]?.message || 'This account cannot be deleted.',
        deletion: deletionState.public
      });
    }
    const actionProofAccepted = await consumeAdminActionProof(client, req, {
      operatorId: actorAdminOperatorId,
      action: 'account_delete',
      targetUserId: userId
    });
    if (!actionProofAccepted) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'admin_step_up_required',
        message: 'Enter a fresh administrator passcode for this account deletion.'
      });
    }

    const { organizerId } = deletionState.private;
    responseSummary = deletionState.public.summary;
    const eventMedia = await client.query(
      `SELECT cover_image_url,flyer_image_url,event_vibe_image_url,
              event_vibe_image_url_2,event_vibe_image_url_3
         FROM events
        WHERE organizer_id=$1`,
      [organizerId]
    );
    const eventPhotoMedia = await client.query(
      `SELECT photo.cloudinary_id
         FROM event_photos photo
         JOIN events event ON event.id=photo.event_id
        WHERE event.organizer_id=$1 OR photo.uploader_user_id=$2`,
      [organizerId, userId]
    );
    const candidateMediaPublicIds = [...new Set([
      ...eventPhotoMedia.rows.map(row => String(row.cloudinary_id || '').trim()).filter(isManagedPublicId),
      ...[
        account.avatar_url,
        account.logo_url,
        account.header_image_url,
        ...eventMedia.rows.flatMap(row => [
          row.cover_image_url,
          row.flyer_image_url,
          row.event_vibe_image_url,
          row.event_vibe_image_url_2,
          row.event_vibe_image_url_3
        ])
      ].map(managedPublicIdFromUrl).filter(Boolean)
    ])];
    const survivingOrganizerMedia = await client.query(
      `SELECT avatar_url,logo_url,header_image_url
         FROM organizers
        WHERE id<>$1`,
      [organizerId]
    );
    const survivingEventMedia = await client.query(
      `SELECT cover_image_url,flyer_image_url,event_vibe_image_url,
              event_vibe_image_url_2,event_vibe_image_url_3
         FROM events
        WHERE organizer_id<>$1`,
      [organizerId]
    );
    const survivingPhotoMedia = await client.query(
      `SELECT photo.cloudinary_id
         FROM event_photos photo
         JOIN events event ON event.id=photo.event_id
        WHERE event.organizer_id<>$1
          AND photo.uploader_user_id IS DISTINCT FROM $2`,
      [organizerId, userId]
    );
    const survivingPublicIds = new Set([
      ...survivingOrganizerMedia.rows.flatMap(row => [
        row.avatar_url, row.logo_url, row.header_image_url
      ]).map(managedPublicIdFromUrl).filter(Boolean),
      ...survivingEventMedia.rows.flatMap(row => [
        row.cover_image_url,
        row.flyer_image_url,
        row.event_vibe_image_url,
        row.event_vibe_image_url_2,
        row.event_vibe_image_url_3
      ]).map(managedPublicIdFromUrl).filter(Boolean),
      ...survivingPhotoMedia.rows
        .map(row => String(row.cloudinary_id || '').trim())
        .filter(isManagedPublicId)
    ]);
    const mediaPublicIds = candidateMediaPublicIds.filter(publicId => !survivingPublicIds.has(publicId));
    if (mediaPublicIds.length) {
      const queuedMedia = await client.query(
        `WITH inserted AS (
           INSERT INTO managed_media_deletion_jobs
             (public_id,source_kind,source_user_id)
           SELECT public_id,'account_deletion',$2
             FROM UNNEST($1::text[]) AS public_id
           ON CONFLICT (source_kind,source_user_id,public_id) DO NOTHING
           RETURNING id
         )
         SELECT id FROM inserted
         UNION
         SELECT id FROM managed_media_deletion_jobs
          WHERE source_kind='account_deletion'
            AND source_user_id=$2
            AND public_id=ANY($1::text[])
            AND status IN ('pending','processing')`,
        [mediaPublicIds, userId]
      );
      mediaJobIds = queuedMedia.rows.map(row => Number(row.id));
      mediaCleanupQueued = mediaPublicIds.length;
    }

    const deletedPlaceholder = `deleted+${userId}@example.invalid`;

    const access = await invalidateAccountAccess(client, userId, organizerId);
    await forfeitSmsCreditBalance(client, {
      organizerId,
      userId,
      balance: account.sms_credits
    });
    await writeAudit(client, req, {
      targetUserId: userId,
      actionType: 'account_deleted',
      reason,
      beforeState: {
        status: account.account_status,
        plan: account.plan || 'free',
        hadHostPage: Boolean(account.public_slug)
      },
      afterState: { status: 'deleted' },
      metadata: {
        deletionMode: 'super_admin',
        deletedUserId: userId,
        ...responseSummary,
        guestSessionsRevoked: access.public.guestSessionsRevoked
      }
    });

    // Break references from events duplicated by another account; their copies
    // remain usable after the source account's events are removed.
    await client.query(
      `UPDATE events
          SET duplicated_from_id=NULL
        WHERE duplicated_from_id IN (SELECT id FROM events WHERE organizer_id=$1)`,
      [organizerId]
    );

    // Only canonical ownership/link fields select records here. Contact and RSVP
    // snapshots are display/delivery data and must never become destructive keys.
    await client.query(
      `UPDATE message_log
          SET recipient='deleted+' || $1::text || '+message-' || id::text || '@example.invalid',
              recipient_name=NULL,recipient_user_id=NULL
        WHERE recipient_user_id=$1`,
      [userId]
    );
    await client.query(
      `UPDATE sms_notification_recipients recipient
          SET recipient='deleted-' || $1::text || '-sms-' || recipient.id::text,
              recipient_name=NULL,access_token=NULL
        WHERE recipient.rsvp_id IN (
                SELECT id FROM rsvps
                 WHERE user_id=$1 OR account_id=$2
              )
           OR recipient.host_follow_id IN (
                SELECT id FROM host_follows
                 WHERE follower_user_id=$1 OR follower_organizer_id=$2 OR host_organizer_id=$2
              )`,
      [userId, organizerId]
    );
    await client.query(
      `UPDATE feedback_submissions
          SET submitted_by_organizer_id=CASE WHEN submitted_by_organizer_id=$2 THEN NULL ELSE submitted_by_organizer_id END,
              organizer_id=CASE WHEN organizer_id=$2 THEN NULL ELSE organizer_id END,
              user_name=NULL,
              user_email='deleted+' || $1::text || '+feedback-' || id::text || '@example.invalid'
        WHERE submitted_by_organizer_id=$2 OR organizer_id=$2
           OR event_id IN (SELECT id FROM events WHERE organizer_id=$2)`,
      [userId, organizerId]
    );
    const deletedClaimInvitations = await client.query(
      `DELETE FROM admin_account_invitations
        WHERE target_user_id=$1 OR claimed_user_id=$1
        RETURNING magic_link_token_id`,
      [userId]
    );
    if (deletedClaimInvitations.rows.length) {
      await client.query(
        'DELETE FROM magic_link_tokens WHERE id=ANY($1::int[])',
        [deletedClaimInvitations.rows.map(row => Number(row.magic_link_token_id))]
      );
    }
    await client.query(
      'DELETE FROM admin_done_for_you_clients WHERE target_user_id=$1',
      [userId]
    );
    await client.query(
      `DELETE FROM guest_invitation_tokens
        WHERE user_id=$1 OR identity_id=$2`,
      [userId, organizerId]
    );
    await client.query(
      `DELETE FROM guest_sessions
        WHERE user_id=$1 OR identity_id=$2`,
      [userId, organizerId]
    );
    await client.query(
      `DELETE FROM event_photos
        WHERE uploader_user_id=$1`,
      [userId]
    );
    await client.query(
      `DELETE FROM rsvps
        WHERE user_id=$1 OR account_id=$2`,
      [userId, organizerId]
    );
    await client.query(
      `DELETE FROM host_follows
        WHERE follower_user_id=$1 OR follower_organizer_id=$2 OR host_organizer_id=$2`,
      [userId, organizerId]
    );
    await client.query('DELETE FROM follower_optouts WHERE organizer_id=$1', [organizerId]);
    await client.query(
      `DELETE FROM phone_auth_challenges
        WHERE organizer_id=$1 OR phone_e164=ANY($2::text[])`,
      [organizerId, access.verifiedPhones]
    );
    await client.query('DELETE FROM account_phone_credentials WHERE organizer_id=$1', [organizerId]);
    await client.query(
      `DELETE FROM magic_link_tokens
        WHERE (requested_user_id=$1 OR target_organizer_id=$2
               OR LOWER(BTRIM(email))=ANY($3::text[]))`,
      [userId, organizerId, access.verifiedEmails]
    );
    await client.query(
      `DELETE FROM user_identity_conflicts
        WHERE candidate_user_id=$1 OR conflicting_user_id=$1`,
      [userId]
    );
    await client.query(
      `DELETE FROM canonical_user_link_conflicts
        WHERE first_candidate_user_id=$1 OR second_candidate_user_id=$1`,
      [userId]
    );
    // The canonical user remains as a tombstone, so the FK cannot remove this
    // PII for us. Delete all proposed email/phone changes explicitly.
    await client.query(
      'DELETE FROM admin_account_identity_change_requests WHERE target_user_id=$1',
      [userId]
    );
    await client.query(
      `DELETE FROM host_invitations
        WHERE created_by_organizer_id=$1 OR joined_organizer_id=$1`,
      [organizerId]
    );
    await client.query('DELETE FROM commerce_feature_interests WHERE organizer_id=$1', [organizerId]);
    await client.query('DELETE FROM line_submissions WHERE organizer_id=$1', [organizerId]);
    await client.query('DELETE FROM events WHERE organizer_id=$1', [organizerId]);
    await client.query('DELETE FROM user_identities WHERE user_id=$1', [userId]);
    await client.query(
      `UPDATE organizers
          SET email=$3,name=NULL,org_name=NULL,public_slug=NULL,plan='free',sms_credits=0,
              is_admin=FALSE,last_login_at=NULL,logo_url=NULL,header_image_url=NULL,bio=NULL,
              website_url=NULL,instagram_url=NULL,instagram_handle=NULL,contact_email=NULL,
              avatar_url=NULL,sessions_valid_after=NOW(),updated_at=NOW()
        WHERE id=$1 AND user_id=$2`,
      [organizerId, userId, deletedPlaceholder]
    );
    await client.query(
      `UPDATE users
          SET name=NULL,account_status='deleted',
              suspended_at=NULL,suspended_by_user_id=NULL,
              suspended_by_admin_operator_id=NULL,suspension_reason=NULL,
              deleted_at=NOW(),deleted_by_user_id=$2,
              deleted_by_admin_operator_id=$3,deletion_reason=$4,updated_at=NOW()
        WHERE id=$1`,
      [userId, actorUserId, actorAdminOperatorId, reason]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '40001') {
      return res.status(409).json({
        error: 'account_changed_retry',
        message: 'The account changed during deletion. Reload it and try again.'
      });
    }
    return next(error);
  } finally { client.release(); }

  queueManagedMediaDeletionJobs(mediaJobIds);
  clearAdminActionProofCookie(res);
  res.json({
    ok: true,
    deletedUserId: userId,
    summary: responseSummary,
    mediaCleanupQueued
  });
});

router.post('/api/admin/accounts/:id/notes', async (req, res, next) => {
  const userId = positiveId(req.params.id);
  const note = String(req.body?.note || '').trim().replace(/\r\n?/g, '\n').slice(0, 2000);
  if (!userId) return res.status(404).json({ error: 'Account not found' });
  if (note.length < 2) return res.status(400).json({ error: 'Enter a support note' });
  const actor = actorIds(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = await lockAccount(client, userId);
    if (!account) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found' });
    }
    const { rows } = await client.query(
      `INSERT INTO admin_account_support_notes
         (target_user_id,author_user_id,author_admin_operator_id,note)
       VALUES ($1,$2,$3,$4)
       RETURNING id,target_user_id,author_user_id,author_admin_operator_id,note,created_at`,
      [userId, actor.actorUserId, actor.actorAdminOperatorId, note]
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
    adminId: `${req.adminActor.type}:${req.adminActor.operatorId || req.adminActor.userId}`,
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
         (email,name,prepare_host_page,magic_link_token_id,created_by_user_id,
          created_by_admin_operator_id,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW() + INTERVAL '7 days')
       RETURNING id,email,name,prepare_host_page,created_at,expires_at`,
      [email, name, prepareHostPage, tokenId,
       actorIds(req).actorUserId, actorIds(req).actorAdminOperatorId]
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
      email: invitation.email,
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
router.resetRateLimitsForTests = () => {
  inviteLimiter.reset();
};

module.exports = router;
