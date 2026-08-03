ALTER TABLE events
  ADD COLUMN IF NOT EXISTS cover_fit_mode TEXT NOT NULL DEFAULT 'auto';

UPDATE events
   SET cover_fit_mode = 'auto'
 WHERE cover_fit_mode IS NULL
    OR cover_fit_mode NOT IN ('auto', 'contain', 'cover');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'events_cover_fit_mode_check'
  ) THEN
    ALTER TABLE events
      ADD CONSTRAINT events_cover_fit_mode_check
      CHECK (cover_fit_mode IN ('auto', 'contain', 'cover'));
  END IF;
END $$;
