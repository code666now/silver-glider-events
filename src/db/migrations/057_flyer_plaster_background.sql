-- Flyer pages previously rendered Midnight as a fixed plaster wall. Preserve
-- their published appearance now that Midnight and Plaster are distinct.
UPDATE events
   SET background_theme = 'plaster'
 WHERE presentation_mode = 'flyer'
   AND background_theme = 'midnight';
