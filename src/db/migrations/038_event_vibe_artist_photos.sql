ALTER TABLE events
  ADD COLUMN IF NOT EXISTS event_vibe_image_url TEXT,
  ADD COLUMN IF NOT EXISTS event_vibe_image_url_2 TEXT,
  ADD COLUMN IF NOT EXISTS event_vibe_url_3 TEXT,
  ADD COLUMN IF NOT EXISTS event_vibe_label_3 TEXT,
  ADD COLUMN IF NOT EXISTS event_vibe_image_url_3 TEXT;

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_event_vibe_label_3_length_check;
ALTER TABLE events
  ADD CONSTRAINT events_event_vibe_label_3_length_check
  CHECK (event_vibe_label_3 IS NULL OR char_length(event_vibe_label_3) <= 80);
