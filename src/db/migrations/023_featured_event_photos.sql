-- Public event recaps are opt-in at upload time and curated by the event host.
-- Existing photos remain private and cannot be featured retroactively.
ALTER TABLE event_photos
  ADD COLUMN IF NOT EXISTS public_feature_consent BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS featured_at TIMESTAMPTZ;

ALTER TABLE event_photos DROP CONSTRAINT IF EXISTS event_photos_feature_consent_check;
ALTER TABLE event_photos ADD CONSTRAINT event_photos_feature_consent_check
  CHECK (is_featured=FALSE OR public_feature_consent=TRUE);

CREATE INDEX IF NOT EXISTS event_photos_featured_idx
  ON event_photos (event_id, featured_at DESC)
  WHERE is_featured=TRUE AND public_feature_consent=TRUE;
