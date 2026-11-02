-- Prospective, event-specific consent. Historical reminder selections retain
-- their existing behavior and never acquire post-event permission implicitly.
ALTER TABLE rsvps
  ADD COLUMN IF NOT EXISTS event_email_optin BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS event_email_consent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS event_email_consent_source TEXT,
  ADD COLUMN IF NOT EXISTS event_email_consent_version TEXT,
  ADD COLUMN IF NOT EXISTS event_email_consent_text TEXT;

ALTER TABLE rsvps ADD CONSTRAINT rsvps_event_email_consent_check CHECK (
  NOT event_email_optin OR (
    event_email_consent_at IS NOT NULL
    AND event_email_consent_source IS NOT NULL
    AND event_email_consent_version IS NOT NULL
    AND event_email_consent_text IS NOT NULL
  )
);

COMMENT ON COLUMN rsvps.event_email_optin IS
  'Explicit permission for optional messages about this event; wants_reminders=false always suppresses it.';

ALTER TABLE message_log
  ADD COLUMN IF NOT EXISTS post_event_consent_scope TEXT
    CHECK (post_event_consent_scope IN ('host','event'));

COMMENT ON COLUMN message_log.post_event_consent_scope IS
  'Consent/render scope fixed when a post-event batch is approved; NULL is the legacy host scope.';
