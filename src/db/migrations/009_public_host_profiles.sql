ALTER TABLE organizers
  ADD COLUMN IF NOT EXISTS public_slug TEXT,
  ADD COLUMN IF NOT EXISTS logo_url TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS organizers_public_slug_unique
  ON organizers (LOWER(public_slug))
  WHERE public_slug IS NOT NULL;
