-- Optional designer attribution belongs to Flyer presentation only. Existing
-- events remain unchanged because both fields are nullable.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS flyer_designer_name TEXT,
  ADD COLUMN IF NOT EXISTS flyer_designer_instagram_handle TEXT;

ALTER TABLE events
  DROP CONSTRAINT IF EXISTS events_flyer_designer_name_length_check,
  DROP CONSTRAINT IF EXISTS events_flyer_designer_instagram_handle_check;

ALTER TABLE events
  ADD CONSTRAINT events_flyer_designer_name_length_check
    CHECK (flyer_designer_name IS NULL OR LENGTH(flyer_designer_name) <= 120),
  ADD CONSTRAINT events_flyer_designer_instagram_handle_check
    CHECK (
      flyer_designer_instagram_handle IS NULL OR (
        LENGTH(flyer_designer_instagram_handle) BETWEEN 1 AND 30
        AND flyer_designer_instagram_handle ~ '^[a-z0-9._]+$'
        AND LEFT(flyer_designer_instagram_handle, 1) <> '.'
        AND RIGHT(flyer_designer_instagram_handle, 1) <> '.'
        AND POSITION('..' IN flyer_designer_instagram_handle) = 0
      )
    );
