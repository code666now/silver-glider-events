-- Simple event-local acknowledgements on an unsent thank-you. NULL means the
-- host has not saved credits yet, so the owner editor may suggest this event's
-- Event Vibe names. An explicit empty array is a deliberate removal.
ALTER TABLE post_event_thank_you_batches
  ADD COLUMN credits JSONB;

ALTER TABLE post_event_thank_you_batches
  ADD CONSTRAINT post_event_thank_you_credits_check CHECK (
    credits IS NULL OR CASE WHEN jsonb_typeof(credits)='array'
      THEN jsonb_array_length(credits) <= 3 ELSE FALSE END
  );

COMMENT ON COLUMN post_event_thank_you_batches.credits IS
  'Owner-authored event-local name/role/Instagram credits; not invitations, profiles, identity proof, or messaging consent. Approved v4 deliveries freeze a separate immutable render snapshot.';
