-- Historical source_event_id can be populated on a later preference save.
-- Keep it for existing workflows and measure only provable first follows.
ALTER TABLE host_follows
  ADD COLUMN first_follow_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL;

CREATE INDEX host_follows_first_follow_event_idx ON host_follows (first_follow_event_id)
  WHERE first_follow_event_id IS NOT NULL;
