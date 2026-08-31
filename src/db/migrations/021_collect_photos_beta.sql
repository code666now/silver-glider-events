-- Collect Photos Beta is enabled per event by Super Admin. Existing events are
-- unaffected until the flag is explicitly turned on.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS collect_photos_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS photo_upload_token TEXT,
  ADD COLUMN IF NOT EXISTS photo_request_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS photo_request_sent_count INT NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS events_photo_upload_token_uq
  ON events (photo_upload_token) WHERE photo_upload_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_photos (
  id               BIGSERIAL PRIMARY KEY,
  event_id         INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  cloudinary_id    TEXT NOT NULL,
  image_url        TEXT NOT NULL,
  contributor_name TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS event_photos_cloudinary_uq ON event_photos (cloudinary_id);
CREATE INDEX IF NOT EXISTS event_photos_event_idx ON event_photos (event_id, created_at DESC);

ALTER TABLE message_log DROP CONSTRAINT IF EXISTS message_log_message_type_check;
ALTER TABLE message_log ADD CONSTRAINT message_log_message_type_check
  CHECK (message_type IN (
    'magic_link','rsvp_confirmation','reminder_day_before','reminder_day_of',
    'announcement','photo_request'
  ));
