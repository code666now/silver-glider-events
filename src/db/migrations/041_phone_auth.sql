-- A verified account phone is an authentication credential. It is deliberately
-- separate from RSVP and Follow Host phone fields, which remain consent records
-- for event messaging and must never grant account access.
CREATE TABLE IF NOT EXISTS account_phone_credentials (
  id            BIGSERIAL PRIMARY KEY,
  organizer_id  INT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  phone_e164    TEXT NOT NULL,
  verified_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT account_phone_credentials_phone_e164_check
    CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT account_phone_credentials_revocation_order_check
    CHECK (revoked_at IS NULL OR revoked_at >= verified_at)
);

-- A phone may prove only one active identity, and an identity may have only one
-- active authentication phone. Revoked history is retained for auditability.
CREATE UNIQUE INDEX IF NOT EXISTS account_phone_credentials_active_phone_uq
  ON account_phone_credentials (phone_e164)
  WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS account_phone_credentials_active_organizer_uq
  ON account_phone_credentials (organizer_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS account_phone_credentials_organizer_idx
  ON account_phone_credentials (organizer_id, created_at DESC);

-- Browser-bound phone challenges support two intentionally different paths:
-- initial enrollment uses Twilio Verify; later sign-in uses an application code
-- sent through the normal Messaging Service. Plain codes and browser tokens are
-- never stored; only keyed/token hashes are persisted.
CREATE TABLE IF NOT EXISTS phone_auth_challenges (
  id             BIGSERIAL PRIMARY KEY,
  purpose        TEXT NOT NULL,
  request_hash   TEXT NOT NULL,
  code_hash      TEXT,
  provider_sid   TEXT,
  organizer_id   INT REFERENCES organizers(id) ON DELETE CASCADE,
  phone_e164     TEXT NOT NULL,
  return_path    TEXT,
  code_attempts  INT NOT NULL DEFAULT 0,
  verified_at    TIMESTAMPTZ,
  used_at        TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT phone_auth_challenges_purpose_check
    CHECK (purpose IN ('enroll', 'sign_in')),
  CONSTRAINT phone_auth_challenges_phone_e164_check
    CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT phone_auth_challenges_attempts_check
    CHECK (code_attempts >= 0),
  CONSTRAINT phone_auth_challenges_method_check CHECK (
    (purpose = 'enroll' AND provider_sid IS NOT NULL AND code_hash IS NULL AND organizer_id IS NULL)
    OR
    (purpose = 'sign_in' AND provider_sid IS NULL AND code_hash IS NOT NULL AND organizer_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS phone_auth_challenges_request_uq
  ON phone_auth_challenges (request_hash);

-- Twilio may reuse one pending Verification SID when a person requests a
-- resend. Multiple browser-bound requests may therefore reference the same
-- provider challenge; each still needs its own cookie and the later email
-- proof before it can create a session.
CREATE INDEX IF NOT EXISTS phone_auth_challenges_provider_idx
  ON phone_auth_challenges (provider_sid)
  WHERE provider_sid IS NOT NULL;

CREATE INDEX IF NOT EXISTS phone_auth_challenges_phone_created_idx
  ON phone_auth_challenges (phone_e164, created_at DESC);

CREATE INDEX IF NOT EXISTS phone_auth_challenges_organizer_created_idx
  ON phone_auth_challenges (organizer_id, created_at DESC)
  WHERE organizer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS phone_auth_challenges_expiry_idx
  ON phone_auth_challenges (expires_at)
  WHERE used_at IS NULL;

-- Email proof completes a phone enrollment. Keeping the relationship explicit
-- lets verification atomically bind exactly the phone challenge the user began.
ALTER TABLE magic_link_tokens
  ADD COLUMN IF NOT EXISTS phone_auth_challenge_id BIGINT
    REFERENCES phone_auth_challenges(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS magic_link_tokens_phone_auth_challenge_idx
  ON magic_link_tokens (phone_auth_challenge_id)
  WHERE phone_auth_challenge_id IS NOT NULL;

ALTER TABLE magic_link_tokens DROP CONSTRAINT IF EXISTS magic_link_tokens_intent_check;
ALTER TABLE magic_link_tokens ADD CONSTRAINT magic_link_tokens_intent_check
  CHECK (intent IN ('sign_in', 'follow_host', 'add_photo', 'verify_guest', 'bind_phone'));

ALTER TABLE magic_link_tokens
  DROP CONSTRAINT IF EXISTS magic_link_tokens_phone_auth_challenge_check;
ALTER TABLE magic_link_tokens
  ADD CONSTRAINT magic_link_tokens_phone_auth_challenge_check CHECK (
    (intent = 'bind_phone') = (phone_auth_challenge_id IS NOT NULL)
  );
