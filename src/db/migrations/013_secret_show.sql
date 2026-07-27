-- Optional access-code gate for existing Private — Link Only events.
-- Credentials live outside events so SELECT e.* can never expose a hash.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS secret_show_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS secret_show_version INT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'events_secret_show_private_check'
  ) THEN
    ALTER TABLE events
      ADD CONSTRAINT events_secret_show_private_check
      CHECK (secret_show_enabled = FALSE OR visibility = 'private');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS event_secret_codes (
  event_id    INT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
