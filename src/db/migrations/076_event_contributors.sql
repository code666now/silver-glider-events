-- Contributor introductions are scoped approvals, never authentication or an
-- import of the original host's guest list. Canonical account ownership is
-- assigned only after the existing verified-email sign-in flow.
CREATE TABLE contributor_profiles (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (email=LOWER(BTRIM(email))),
  slug TEXT NOT NULL UNIQUE,
  owner_user_id INT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  photo_url TEXT,
  instagram_handle TEXT,
  website_url TEXT,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE event_contributors (
  id BIGSERIAL PRIMARY KEY,
  event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  organizer_id INT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  profile_id BIGINT NOT NULL REFERENCES contributor_profiles(id) ON DELETE CASCADE,
  slot SMALLINT NOT NULL CHECK (slot BETWEEN 1 AND 3),
  public_ref TEXT NOT NULL UNIQUE CHECK (public_ref ~ '^[a-f0-9]{24}$'),
  email TEXT NOT NULL CHECK (email=LOWER(BTRIM(email))),
  name TEXT NOT NULL CHECK (CHAR_LENGTH(name) BETWEEN 1 AND 100),
  role TEXT NOT NULL CHECK (CHAR_LENGTH(role) BETWEEN 1 AND 80),
  photo_url TEXT,
  instagram_handle TEXT,
  website_url TEXT,
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','approved','revoked')),
  selected BOOLEAN NOT NULL DEFAULT TRUE,
  approval_version TEXT,
  approval_text TEXT,
  approved_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  token_hash TEXT NOT NULL UNIQUE,
  token_expires_at TIMESTAMPTZ NOT NULL,
  version INT NOT NULL DEFAULT 1,
  invitation_payload TEXT NOT NULL,
  invitation_attempts SMALLINT NOT NULL DEFAULT 0,
  invitation_attempted_at TIMESTAMPTZ,
  invitation_sent_at TIMESTAMPTZ,
  claim_payload TEXT,
  claim_attempts SMALLINT NOT NULL DEFAULT 0,
  claim_attempted_at TIMESTAMPTZ,
  claim_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT event_contributors_approval_complete CHECK
    (status<>'approved' OR (approval_version IS NOT NULL AND approval_text IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE UNIQUE INDEX event_contributors_active_slot_uq
  ON event_contributors(event_id,slot) WHERE status<>'revoked';
CREATE UNIQUE INDEX event_contributors_active_email_uq
  ON event_contributors(event_id,email) WHERE status<>'revoked';
CREATE INDEX event_contributors_profile_idx ON event_contributors(profile_id,status);

CREATE TABLE contributor_follow_intents (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES contributor_profiles(id) ON DELETE CASCADE,
  follower_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_event_id INT REFERENCES events(id) ON DELETE SET NULL,
  email_consent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consent_version TEXT NOT NULL,
  consent_text TEXT NOT NULL,
  withdrawn_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(profile_id,follower_user_id)
);
COMMENT ON TABLE contributor_follow_intents IS
  'Explicit verified-person email follow choices; pending until profile claim. RSVP data is never copied here.';
COMMENT ON COLUMN event_contributors.invitation_payload IS
  'Authenticated encrypted immutable delivery payload; bearer lookup stores only a SHA-256 hash.';
