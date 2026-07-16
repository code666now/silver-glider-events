CREATE TABLE IF NOT EXISTS host_invitations (
  id                         BIGSERIAL PRIMARY KEY,
  token                      TEXT NOT NULL UNIQUE,
  host_name                  VARCHAR(160) NOT NULL,
  personal_note              VARCHAR(500) NOT NULL,
  created_by_organizer_id    INT REFERENCES organizers(id) ON DELETE SET NULL,
  joined_organizer_id        INT REFERENCES organizers(id) ON DELETE SET NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  joined_at                  TIMESTAMPTZ,
  revoked_at                 TIMESTAMPTZ,
  CHECK (LENGTH(TRIM(host_name)) BETWEEN 2 AND 160),
  CHECK (LENGTH(TRIM(personal_note)) BETWEEN 8 AND 500)
);

CREATE INDEX IF NOT EXISTS host_invitations_created_idx
  ON host_invitations (created_at DESC);
CREATE INDEX IF NOT EXISTS host_invitations_joined_idx
  ON host_invitations (joined_organizer_id) WHERE joined_organizer_id IS NOT NULL;
