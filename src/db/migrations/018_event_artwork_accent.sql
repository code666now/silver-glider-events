ALTER TABLE events
  ADD COLUMN IF NOT EXISTS artwork_accent_color TEXT;

UPDATE events
   SET artwork_accent_color = NULL
 WHERE artwork_accent_color IS NOT NULL
   AND artwork_accent_color !~ '^#[0-9A-F]{6}$';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'events_artwork_accent_color_check'
  ) THEN
    ALTER TABLE events
      ADD CONSTRAINT events_artwork_accent_color_check
      CHECK (artwork_accent_color IS NULL OR artwork_accent_color ~ '^#[0-9A-F]{6}$');
  END IF;
END $$;
