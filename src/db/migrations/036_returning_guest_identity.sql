-- A remembered RSVP browser is intentionally lower privilege than an account
-- session. It can answer invitations and manage only the RSVPs it created.
CREATE TABLE IF NOT EXISTS guest_sessions (
  id                 BIGSERIAL PRIMARY KEY,
  identity_id        INT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  token_hash         TEXT UNIQUE NOT NULL,
  display_first_name TEXT NOT NULL,
  display_name       TEXT NOT NULL,
  verified_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS guest_sessions_identity_idx
  ON guest_sessions (identity_id, expires_at DESC);

ALTER TABLE rsvps
  ADD COLUMN IF NOT EXISTS guest_session_id BIGINT
    REFERENCES guest_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS rsvps_guest_session_idx
  ON rsvps (guest_session_id, event_id);

-- Each Familiar Faces email receives an opaque, event-specific invitation.
-- Only a hash is stored; opening the link proves control of the destination
-- inbox without granting organizer/admin access.
CREATE TABLE IF NOT EXISTS guest_invitation_tokens (
  id             BIGSERIAL PRIMARY KEY,
  message_log_id INT NOT NULL UNIQUE REFERENCES message_log(id) ON DELETE CASCADE,
  target_event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  identity_id    INT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  token_hash     TEXT UNIQUE NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  opened_at      TIMESTAMPTZ,
  responded_at   TIMESTAMPTZ,
  response       TEXT CHECK (response IN ('going','not_going')),
  rsvp_id        INT REFERENCES rsvps(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS guest_invitation_tokens_identity_event_idx
  ON guest_invitation_tokens (identity_id, target_event_id, expires_at DESC);
