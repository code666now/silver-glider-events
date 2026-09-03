-- Expand the event-facing admission model without moving Commerce truth into
-- Silver Glider Events. Legacy `paid` rows remain valid during the rollout and
-- are normalized by application code as external ticket events.
ALTER TABLE events ADD COLUMN IF NOT EXISTS commerce_event_id TEXT;

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_admission_type_check;
ALTER TABLE events ADD CONSTRAINT events_admission_type_check
  CHECK (admission_type IN (
    'free_rsvp', 'paid', 'donation', 'door', 'vip',
    'external_tickets', 'silver_glider_tickets'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS events_commerce_event_id_uq
  ON events (commerce_event_id)
  WHERE commerce_event_id IS NOT NULL;

COMMENT ON COLUMN events.commerce_event_id IS
  'Opaque reference to the Commerce service event. Price, inventory, availability, orders, and tickets remain authoritative in Commerce.';
