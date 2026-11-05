-- Prospectively enroll only meaningful customer-authored draft saves. Migration
-- never treats an old updated_at timestamp as activity or queues historical mail.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS draft_host_activity_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_published_at TIMESTAMPTZ;

UPDATE events SET first_published_at=created_at
 WHERE status='published' AND first_published_at IS NULL;

CREATE OR REPLACE FUNCTION preserve_event_first_publication()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.first_published_at IS NOT NULL THEN
    NEW.first_published_at := OLD.first_published_at;
  ELSIF NEW.status='published' THEN
    NEW.first_published_at := COALESCE(NEW.first_published_at,NOW());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS events_preserve_first_publication ON events;
CREATE TRIGGER events_preserve_first_publication
  BEFORE INSERT OR UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION preserve_event_first_publication();

-- These host-level markers deliberately survive deletion of a draft, keeping
-- the frequency limit and first-event supersession intact.
ALTER TABLE organizers
  ADD COLUMN IF NOT EXISTS first_draft_reminder_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_draft_reminder_attempt_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS event_draft_reminders (
  event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  organizer_id INTEGER NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL,
  activity_at TIMESTAMPTZ NOT NULL,
  render_snapshot JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','suppressed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  first_attempt_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  provider_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (recipient=LOWER(BTRIM(recipient)))
);

CREATE INDEX IF NOT EXISTS events_draft_host_activity_idx
  ON events (organizer_id,draft_host_activity_at DESC,id DESC)
  WHERE status='draft' AND archived_at IS NULL AND draft_host_activity_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS event_draft_reminders_retry_idx
  ON event_draft_reminders (first_attempt_at,last_attempt_at)
  WHERE status IN ('pending','failed');

ALTER TABLE email_optouts DROP CONSTRAINT IF EXISTS email_optouts_scope_check;
ALTER TABLE email_optouts ADD CONSTRAINT email_optouts_scope_check
  CHECK (scope IN ('host_recaps','product_updates','host_onboarding','host_followups','host_drafts'));
ALTER TABLE email_optins DROP CONSTRAINT IF EXISTS email_optins_scope_check;
ALTER TABLE email_optins ADD CONSTRAINT email_optins_scope_check
  CHECK (scope IN ('host_followups','host_drafts'));
