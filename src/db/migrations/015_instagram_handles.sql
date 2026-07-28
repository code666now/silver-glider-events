-- Store the simple Instagram identity hosts actually enter. Keep instagram_url
-- untouched temporarily for rollback compatibility while the app moves to handles.
ALTER TABLE organizers
  ADD COLUMN IF NOT EXISTS instagram_handle TEXT;

WITH candidates AS (
  SELECT id,
         LOWER(TRIM(BOTH '/' FROM REGEXP_REPLACE(
           REGEXP_REPLACE(TRIM(instagram_url), '^https?://(www\.)?instagram\.com/', '', 'i'),
           '[?#].*$', '', 'g'
         ))) AS handle
    FROM organizers
   WHERE instagram_url IS NOT NULL
     AND instagram_handle IS NULL
)
UPDATE organizers AS o
   SET instagram_handle=c.handle
  FROM candidates AS c
 WHERE o.id=c.id
   AND c.handle ~ '^[a-z0-9._]{1,30}$'
   AND c.handle NOT LIKE '.%'
   AND c.handle NOT LIKE '%.'
   AND c.handle NOT LIKE '%..%';
