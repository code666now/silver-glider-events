-- The morning after an event, its host gets one recap: how the night went, how
-- many guests had been before, and a way straight into the next event. Claimed
-- on the event row so concurrent passes can never send it twice.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS host_recap_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS events_host_recap_pending_idx
  ON events (event_date)
  WHERE host_recap_sent_at IS NULL AND status = 'published';

COMMENT ON COLUMN events.host_recap_sent_at IS
  'When the post-event recap was sent to the host. NULL means it is still owed.';
