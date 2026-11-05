const crypto = require('crypto');

// An opaque UI deduplication key, never an authorization or identity claim.
// Names and addresses remain private to their existing host-scoped sources.
function invitationSelectionKey(organizerId, email, trustedUserId = null) {
  const secret = String(process.env.SESSION_SECRET || '').trim();
  if (!secret) throw new Error('SESSION_SECRET is required');
  return crypto.createHmac('sha256', secret)
    .update(`invitation-selection:v1:${organizerId}:${trustedUserId ? `user:${trustedUserId}` : `email:${String(email || '').trim().toLowerCase()}`}`)
    .digest('hex');
}

module.exports = { invitationSelectionKey };
