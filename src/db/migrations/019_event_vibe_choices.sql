ALTER TABLE events
  ADD COLUMN IF NOT EXISTS event_vibe_label TEXT,
  ADD COLUMN IF NOT EXISTS event_vibe_url_2 TEXT,
  ADD COLUMN IF NOT EXISTS event_vibe_label_2 TEXT;

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_event_vibe_label_length_check;
ALTER TABLE events
  ADD CONSTRAINT events_event_vibe_label_length_check
  CHECK (event_vibe_label IS NULL OR char_length(event_vibe_label) <= 80);

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_event_vibe_label_2_length_check;
ALTER TABLE events
  ADD CONSTRAINT events_event_vibe_label_2_length_check
  CHECK (event_vibe_label_2 IS NULL OR char_length(event_vibe_label_2) <= 80);
