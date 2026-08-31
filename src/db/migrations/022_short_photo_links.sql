-- Keep legacy photo links valid while issuing shorter, equally unguessable links.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS photo_short_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS events_photo_short_token_uq
  ON events (photo_short_token) WHERE photo_short_token IS NOT NULL;
