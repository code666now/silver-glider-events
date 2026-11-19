-- One aggregate per event; store no IP, user agent, ticket URL, or individual
-- visitor key. An anonymous browser is mapped into one slot, so repeats reuse
-- a bit. Collisions make unique clicks an approximate, conservative count.
CREATE TABLE external_ticket_clicks (
  event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  total_clicks BIGINT NOT NULL CHECK (total_clicks > 0),
  unique_clicks INTEGER NOT NULL CHECK (unique_clicks > 0 AND unique_clicks <= total_clicks),
  visitor_slots BIT(65536) NOT NULL
);
