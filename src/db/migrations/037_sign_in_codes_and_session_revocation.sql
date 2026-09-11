-- Account sessions are signed cookies. A cookie issued before this instant is
-- rejected, which is how "Sign out of all devices" reaches other browsers.
ALTER TABLE organizers
  ADD COLUMN IF NOT EXISTS sessions_valid_after TIMESTAMPTZ;

-- Every emailed link now also carries a 6-digit code that the requesting
-- browser can type instead of opening the link. `request_hash` binds the code
-- to the browser that asked for it; `code_attempts` caps guessing.
ALTER TABLE magic_link_tokens
  ADD COLUMN IF NOT EXISTS code_hash TEXT,
  ADD COLUMN IF NOT EXISTS request_hash TEXT,
  ADD COLUMN IF NOT EXISTS code_attempts INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS magic_link_tokens_request_idx
  ON magic_link_tokens (request_hash) WHERE request_hash IS NOT NULL;

-- Store only a SHA-256 of each link token, matching guest_sessions and
-- guest_invitation_tokens. Outstanding links keep working because lookups
-- hash the presented token the same way.
UPDATE magic_link_tokens
   SET token = encode(sha256(convert_to(token, 'UTF8')), 'hex');

-- add_photo: a photo-only grant instead of a full account session.
-- verify_guest: a code-only proof of email for the public RSVP flow.
ALTER TABLE magic_link_tokens DROP CONSTRAINT IF EXISTS magic_link_tokens_intent_check;
ALTER TABLE magic_link_tokens ADD CONSTRAINT magic_link_tokens_intent_check
  CHECK (intent IN ('sign_in', 'follow_host', 'add_photo', 'verify_guest'));

-- "Add your photo" links already sitting in inboxes were issued as full
-- 7-day sign-ins. Downgrade the unused ones to the photo-only grant.
UPDATE magic_link_tokens
   SET intent = 'add_photo'
 WHERE intent = 'sign_in' AND used_at IS NULL AND return_path LIKE '/add-photo%';

-- A personal invitation link proves the mailbox for its own event only, so a
-- forwarded invitation cannot act as the original guest anywhere else.
-- NULL means the email was proven directly (code or account sign-in).
ALTER TABLE guest_sessions
  ADD COLUMN IF NOT EXISTS verified_event_id INT REFERENCES events(id) ON DELETE CASCADE;

-- Every verified guest session before this release came from an invitation
-- link. Scope each one to the latest invitation that identity opened.
UPDATE guest_sessions gs
   SET verified_event_id = (
     SELECT invitation.target_event_id
       FROM guest_invitation_tokens invitation
      WHERE invitation.identity_id = gs.identity_id
        AND invitation.opened_at IS NOT NULL
      ORDER BY invitation.opened_at DESC
      LIMIT 1
   )
 WHERE gs.verified_at IS NOT NULL AND gs.verified_event_id IS NULL;

-- A verified session that cannot be tied to an invitation loses verification
-- rather than keeping cross-event power.
UPDATE guest_sessions
   SET verified_at = NULL
 WHERE verified_at IS NOT NULL AND verified_event_id IS NULL;
