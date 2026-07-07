-- Optional ticketing metadata for events that have paid admission elsewhere.
-- Silver Glider Events still handles RSVP as the primary action.
ALTER TABLE events ADD COLUMN IF NOT EXISTS ticket_price NUMERIC(10,2);
ALTER TABLE events ADD COLUMN IF NOT EXISTS ticket_url TEXT;
