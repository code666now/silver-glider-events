-- Host Page onboarding begins only for pages created after this migration.
-- Existing pages intentionally keep host_page_created_at NULL so a release
-- never turns into a surprise onboarding campaign for established hosts.
ALTER TABLE organizers
  ADD COLUMN IF NOT EXISTS host_page_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS host_page_success_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS host_profile_nudge_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_event_nudge_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_event_published_at TIMESTAMPTZ;

-- Publication is a one-way activation milestone. Keeping it on the organizer
-- prevents a cancelled or later-deleted first event from triggering copy that
-- incorrectly says the host has never published.
CREATE OR REPLACE FUNCTION mark_organizer_first_event_published()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'published' THEN
    UPDATE organizers
       SET first_event_published_at=COALESCE(first_event_published_at,NOW())
     WHERE id=NEW.organizer_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_mark_first_publication ON events;
CREATE TRIGGER events_mark_first_publication
  AFTER INSERT OR UPDATE OF status ON events
  FOR EACH ROW
  WHEN (NEW.status = 'published')
  EXECUTE FUNCTION mark_organizer_first_event_published();

CREATE INDEX IF NOT EXISTS organizers_host_onboarding_profile_idx
  ON organizers (host_page_created_at, id)
  WHERE host_page_created_at IS NOT NULL
    AND host_profile_nudge_sent_at IS NULL;

CREATE INDEX IF NOT EXISTS organizers_host_onboarding_event_idx
  ON organizers (host_page_created_at, id)
  WHERE host_page_created_at IS NOT NULL
    AND first_event_nudge_sent_at IS NULL;

-- Creator onboarding is optional and independently reversible. Essential
-- security, RSVP, and event-change messages remain outside this preference.
ALTER TABLE email_optouts
  DROP CONSTRAINT IF EXISTS email_optouts_scope_check;

ALTER TABLE email_optouts
  ADD CONSTRAINT email_optouts_scope_check
  CHECK (scope IN ('host_recaps', 'product_updates', 'host_onboarding'));
