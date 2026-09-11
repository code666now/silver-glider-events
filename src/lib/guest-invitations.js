const crypto = require('crypto');
const { ensureGuestIdentity } = require('./guest-identity');
const { tokenHash } = require('./guest-session');

function invitationExpiry(eventDate) {
  const ninetyDays = Date.now() + 90 * 24 * 3600 * 1000;
  const eventWindow = new Date(`${String(eventDate).slice(0, 10)}T23:59:59Z`).getTime() + 7 * 24 * 3600 * 1000;
  return new Date(Math.max(ninetyDays, Number.isFinite(eventWindow) ? eventWindow : 0));
}

async function createGuestInvitation(db, { messageLogId, eventId, eventDate, email, recipientName }) {
  const identity = await ensureGuestIdentity(db, { email, displayName: recipientName });
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO guest_invitation_tokens
       (message_log_id,target_event_id,identity_id,token_hash,expires_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (message_log_id) DO UPDATE
       SET identity_id=EXCLUDED.identity_id,token_hash=EXCLUDED.token_hash,
           expires_at=EXCLUDED.expires_at,revoked_at=NULL`,
    [messageLogId, eventId, identity.id, tokenHash(token), invitationExpiry(eventDate)]
  );
  return { token, identity };
}

module.exports = { createGuestInvitation, invitationExpiry };
