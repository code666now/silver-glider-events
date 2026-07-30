ALTER TABLE events
  ADD COLUMN IF NOT EXISTS presentation_mode TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS flyer_image_url TEXT;

UPDATE events
   SET presentation_mode = 'standard'
 WHERE presentation_mode IS NULL
    OR presentation_mode NOT IN ('standard', 'flyer');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'events_presentation_mode_check'
  ) THEN
    ALTER TABLE events
      ADD CONSTRAINT events_presentation_mode_check
      CHECK (presentation_mode IN ('standard', 'flyer'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'events_flyer_image_required_check'
  ) THEN
    ALTER TABLE events
      ADD CONSTRAINT events_flyer_image_required_check
      CHECK (
        presentation_mode <> 'flyer'
        OR (flyer_image_url IS NOT NULL AND LENGTH(BTRIM(flyer_image_url)) > 0)
      );
  END IF;
END $$;
