-- Event-scoped, host-funded day-before text reminders. Existing events remain
-- unchanged because automation is opt-in and defaults off.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS sms_reminder_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Each recipient gets a private, short-lived access link. Opening it restores
-- the existing event attendee cookie; it does not create a user account.
ALTER TABLE sms_notification_recipients
  ADD COLUMN IF NOT EXISTS message_body TEXT,
  ADD COLUMN IF NOT EXISTS access_token TEXT,
  ADD COLUMN IF NOT EXISTS access_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS accessed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS sms_notification_recipients_access_token_idx
  ON sms_notification_recipients (access_token)
  WHERE access_token IS NOT NULL;

ALTER TABLE rsvps
  ADD COLUMN IF NOT EXISTS sms_phone_verified_at TIMESTAMPTZ;
