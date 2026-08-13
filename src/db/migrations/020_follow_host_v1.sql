-- Follow Host V1. `organizers` remains the shared authenticated identity table;
-- rows without public host-profile fields are valid follower-only identities.
ALTER TABLE magic_link_tokens
  ADD COLUMN IF NOT EXISTS intent TEXT NOT NULL DEFAULT 'sign_in',
  ADD COLUMN IF NOT EXISTS target_organizer_id INT REFERENCES organizers(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS return_path TEXT;

ALTER TABLE magic_link_tokens DROP CONSTRAINT IF EXISTS magic_link_tokens_intent_check;
ALTER TABLE magic_link_tokens ADD CONSTRAINT magic_link_tokens_intent_check
  CHECK (intent IN ('sign_in', 'follow_host'));

CREATE TABLE IF NOT EXISTS host_follows (
  id                    BIGSERIAL PRIMARY KEY,
  follower_organizer_id INT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  host_organizer_id     INT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  source_event_id       INT REFERENCES events(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unsubscribed_at       TIMESTAMPTZ,
  CONSTRAINT host_follows_not_self CHECK (follower_organizer_id <> host_organizer_id),
  CONSTRAINT host_follows_identity_host_uq UNIQUE (follower_organizer_id, host_organizer_id)
);

CREATE INDEX IF NOT EXISTS host_follows_active_follower_idx
  ON host_follows (follower_organizer_id, created_at DESC)
  WHERE unsubscribed_at IS NULL;

CREATE INDEX IF NOT EXISTS host_follows_active_host_idx
  ON host_follows (host_organizer_id)
  WHERE unsubscribed_at IS NULL;
