-- SMS permission is separate from email reminders and host-email opt-in.
-- Store the exact disclosure snapshot and its source/version so future sends
-- can prove which affirmative consent made an RSVP eligible.
ALTER TABLE rsvps
  ADD COLUMN IF NOT EXISTS sms_optin BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sms_consent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sms_consent_source TEXT,
  ADD COLUMN IF NOT EXISTS sms_consent_version TEXT,
  ADD COLUMN IF NOT EXISTS sms_consent_text TEXT,
  ADD COLUMN IF NOT EXISTS sms_opted_out_at TIMESTAMPTZ;

DO $$
BEGIN
  ALTER TABLE rsvps
    ADD CONSTRAINT rsvps_sms_consent_complete_chk CHECK (
      sms_optin = FALSE OR (
        phone IS NOT NULL AND
        sms_consent_at IS NOT NULL AND
        sms_consent_source IS NOT NULL AND
        sms_consent_version IS NOT NULL AND
        sms_consent_text IS NOT NULL AND
        sms_opted_out_at IS NULL
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS rsvps_event_sms_eligible_idx
  ON rsvps (event_id)
  WHERE status='confirmed' AND sms_optin=TRUE AND sms_opted_out_at IS NULL;
