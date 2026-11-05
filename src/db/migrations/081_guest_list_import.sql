-- Explicitly reviewed, event-only imported invitations. Existing past-guest
-- batches keep their renderer and delivery path; migration queues nothing.
ALTER TABLE previous_guest_invitation_batches
  ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'past_guest'
    CHECK (source_kind IN ('past_guest','import')),
  ADD COLUMN IF NOT EXISTS import_approval_key TEXT,
  ADD COLUMN IF NOT EXISTS import_context_hash TEXT,
  ADD COLUMN IF NOT EXISTS import_contacts_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS import_skipped_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS import_permission_version TEXT,
  ADD COLUMN IF NOT EXISTS import_permission_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS previous_guest_import_approval_uq
  ON previous_guest_invitation_batches(import_approval_key)
  WHERE import_approval_key IS NOT NULL;
-- Old workers only select pending/processing/partial_failed. Keep imported
-- pending work outside those statuses during rolling releases and rollbacks.
ALTER TABLE previous_guest_invitation_batches DROP CONSTRAINT IF EXISTS previous_guest_invitation_batches_status_check;
ALTER TABLE previous_guest_invitation_batches ADD CONSTRAINT previous_guest_invitation_batches_status_check
  CHECK (status IN ('pending','processing','sent','partial_failed','failed','import_pending'));

ALTER TABLE message_log
  ADD COLUMN IF NOT EXISTS import_render_payload JSONB,
  ADD COLUMN IF NOT EXISTS import_delivery_state TEXT
    CHECK (import_delivery_state IN ('pending','accepted','skipped','failed')),
  ADD COLUMN IF NOT EXISTS import_first_attempt_at TIMESTAMPTZ;

-- Non-contact HMAC budget facts intentionally survive event/account deletion.
-- A stable database-held secret prevents resetting a quota by rotating sessions.
CREATE TABLE IF NOT EXISTS guest_import_budget_config (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  identity_hmac_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guest_import_budget (
  id BIGSERIAL PRIMARY KEY,
  approval_key TEXT NOT NULL UNIQUE,
  account_key TEXT NOT NULL,
  email_keys TEXT[] NOT NULL,
  recipient_count INTEGER NOT NULL CHECK (recipient_count BETWEEN 1 AND 100),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS guest_import_budget_time_idx ON guest_import_budget(approved_at);
CREATE INDEX IF NOT EXISTS guest_import_budget_account_idx ON guest_import_budget(account_key,approved_at);

-- Host-owned address-book associations, never a second global guest identity.
-- Account removal cascades these private contacts; event removal does not.
CREATE TABLE IF NOT EXISTS host_invitation_contacts (
  id BIGSERIAL PRIMARY KEY,
  organizer_id INTEGER NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  email TEXT NOT NULL CHECK (email=LOWER(BTRIM(email))),
  name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organizer_id,email)
);
CREATE INDEX IF NOT EXISTS host_invitation_contacts_host_idx ON host_invitation_contacts(organizer_id,id);
