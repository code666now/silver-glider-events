const crypto = require('crypto');
const { ensureGuestIdentity } = require('./guest-identity');
const { tokenHash } = require('./guest-session');
const { withCanonicalIdentityTransaction } = require('./canonical-identity');

const INVITATION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// Personal Familiar Faces links are durable bookmarks. They remain revocable,
// but they do not expire: the opaque token is the event-scoped authorization.
function invitationExpiry() {
  return null;
}

async function createGuestInvitation(db, { messageLogId, eventId, eventDate, email, recipientName }) {
  return withCanonicalIdentityTransaction(db, async client => {
    const identity = await ensureGuestIdentity(client, { email, displayName: recipientName });
    const token = crypto.randomBytes(32).toString('base64url');
    await client.query(
      `INSERT INTO guest_invitation_tokens
         (message_log_id,target_event_id,identity_id,user_id,token_hash,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (message_log_id) DO UPDATE
         SET identity_id=EXCLUDED.identity_id,user_id=EXCLUDED.user_id,token_hash=EXCLUDED.token_hash,
             expires_at=EXCLUDED.expires_at,revoked_at=NULL`,
      [messageLogId, eventId, identity.id, identity.user_id, tokenHash(token), invitationExpiry(eventDate)]
    );
    await client.query(
      `INSERT INTO canonical_user_link_conflicts
         (relationship_type,source_record_id,first_candidate_user_id,second_candidate_user_id,reason)
       SELECT 'message_log',message.id,message.recipient_user_id,$2,'legacy_owner_mismatch'
         FROM message_log message
        WHERE message.id=$1
          AND message.recipient_user_id IS NOT NULL
          AND message.recipient_user_id<>$2
       ON CONFLICT DO NOTHING`,
      [messageLogId, identity.user_id]
    );
    await client.query(
      `UPDATE message_log
          SET recipient_user_id=CASE
                WHEN EXISTS (
                  SELECT 1
                    FROM canonical_user_link_conflicts conflict
                   WHERE conflict.relationship_type='message_log'
                     AND conflict.source_record_id=message_log.id
                     AND conflict.reason='legacy_owner_mismatch'
                     AND conflict.resolved_at IS NULL
                ) THEN NULL
                ELSE COALESCE(recipient_user_id,$2)
              END
        WHERE id=$1`,
      [messageLogId, identity.user_id]
    );
    return { token, identity };
  });
}

async function resolveGuestInvitation(db, rawToken, { eventId = null, publishedOnly = true } = {}) {
  const token = String(rawToken || '').trim();
  if (!INVITATION_TOKEN_RE.test(token)) return null;

  const values = [tokenHash(token)];
  const conditions = [
    'invitation.token_hash=$1',
    'invitation.revoked_at IS NULL'
  ];
  if (eventId != null) {
    values.push(Number(eventId));
    conditions.push(`invitation.target_event_id=$${values.length}`);
  }
  if (publishedOnly) conditions.push("e.status='published'");

  const { rows } = await db.query(
    `SELECT invitation.id,invitation.identity_id,invitation.user_id,invitation.target_event_id,
            invitation.rsvp_id,invitation.response,invitation.responded_at,
            ml.recipient,ml.recipient_name,e.slug,e.status AS event_status
       FROM guest_invitation_tokens invitation
       JOIN message_log ml ON ml.id=invitation.message_log_id
       JOIN events e ON e.id=invitation.target_event_id
      WHERE ${conditions.join(' AND ')}
      LIMIT 1`,
    values
  );
  if (!rows.length) return null;

  const invitation = rows[0];
  const rsvpRows = (await db.query(
    `SELECT *
       FROM rsvps
      WHERE event_id=$1
        AND (
          id=$2
          OR ($3::int IS NOT NULL AND user_id=$3)
          OR ($3::int IS NULL AND account_id=$4)
          OR (($3::int IS NULL OR user_id IS NULL) AND LOWER(email)=LOWER($5))
        )
      ORDER BY CASE
        WHEN id=$2 THEN 0
        WHEN $3::int IS NOT NULL AND user_id=$3 THEN 1
        WHEN $3::int IS NULL AND account_id=$4 THEN 2
        ELSE 3
      END, id DESC
      LIMIT 1`,
    [invitation.target_event_id, invitation.rsvp_id, invitation.user_id,
     invitation.identity_id, invitation.recipient]
  )).rows;

  return { token, invitation, rsvp: rsvpRows[0] || null };
}

module.exports = {
  createGuestInvitation,
  invitationExpiry,
  INVITATION_TOKEN_RE,
  resolveGuestInvitation
};
