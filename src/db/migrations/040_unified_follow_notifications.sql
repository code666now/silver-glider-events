-- A Host follow is one relationship with two separately recorded channels.
-- Existing rows are intentionally not backfilled: no prior follower is silently
-- enrolled in email or SMS without a new explicit action.
ALTER TABLE host_follows
  ADD COLUMN IF NOT EXISTS email_opted_in_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_consent_source TEXT,
  ADD COLUMN IF NOT EXISTS email_consent_version TEXT,
  ADD COLUMN IF NOT EXISTS email_consent_text TEXT,
  ADD COLUMN IF NOT EXISTS sms_phone TEXT,
  ADD COLUMN IF NOT EXISTS sms_opted_in_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sms_opted_out_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sms_consent_source TEXT,
  ADD COLUMN IF NOT EXISTS sms_consent_version TEXT,
  ADD COLUMN IF NOT EXISTS sms_consent_text TEXT;

ALTER TABLE host_follows DROP CONSTRAINT IF EXISTS host_follows_sms_phone_e164;
ALTER TABLE host_follows ADD CONSTRAINT host_follows_sms_phone_e164
  CHECK (sms_phone IS NULL OR sms_phone ~ '^\+[1-9][0-9]{7,14}$');

ALTER TABLE host_follows DROP CONSTRAINT IF EXISTS host_follows_email_consent_complete;
ALTER TABLE host_follows ADD CONSTRAINT host_follows_email_consent_complete CHECK (
  email_opted_in_at IS NULL OR
  (email_consent_source IS NOT NULL AND email_consent_version IS NOT NULL AND email_consent_text IS NOT NULL)
);

ALTER TABLE host_follows DROP CONSTRAINT IF EXISTS host_follows_sms_consent_complete;
ALTER TABLE host_follows ADD CONSTRAINT host_follows_sms_consent_complete CHECK (
  sms_opted_in_at IS NULL OR
  (sms_phone IS NOT NULL AND sms_consent_source IS NOT NULL AND sms_consent_version IS NOT NULL AND sms_consent_text IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS host_follows_active_email_idx
  ON host_follows (host_organizer_id, follower_organizer_id)
  WHERE unsubscribed_at IS NULL AND email_opted_in_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS host_follows_active_sms_idx
  ON host_follows (host_organizer_id, sms_phone)
  WHERE unsubscribed_at IS NULL AND sms_opted_in_at IS NOT NULL
    AND sms_opted_out_at IS NULL;

-- Reuse the paid SMS fulfillment pipeline for host-approved new-event texts.
ALTER TABLE sms_notification_batches DROP CONSTRAINT IF EXISTS sms_notification_batches_kind_check;
ALTER TABLE sms_notification_batches ADD CONSTRAINT sms_notification_batches_kind_check
  CHECK (kind IN ('event_tomorrow','follower_announcement'));

ALTER TABLE sms_notification_recipients
  ADD COLUMN IF NOT EXISTS host_follow_id BIGINT REFERENCES host_follows(id) ON DELETE SET NULL;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS announced_text_count INT NOT NULL DEFAULT 0;
