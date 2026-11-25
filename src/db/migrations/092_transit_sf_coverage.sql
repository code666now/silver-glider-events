-- Server-only venue preparation for public, Places-selected San Francisco events.
-- No venue addresses, guest data, provider responses, or credentials enter these tables.
CREATE TABLE transit_sf_venue_coverage (
  venue_key TEXT PRIMARY KEY CHECK (venue_key ~ '^[a-f0-9]{64}$'),
  walks JSONB NOT NULL CHECK (jsonb_typeof(walks) = 'array' AND jsonb_array_length(walks) <= 40),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX transit_sf_venue_coverage_expiry_idx ON transit_sf_venue_coverage(expires_at);

CREATE TABLE transit_sf_event_coverage (
  event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  venue_key TEXT CHECK (venue_key ~ '^[a-f0-9]{64}$'),
  input_version TEXT CHECK (input_version ~ '^[a-f0-9]{64}$'),
  source_updated_at TIMESTAMPTZ,
  retry_at TIMESTAMPTZ NOT NULL,
  ready_until TIMESTAMPTZ,
  CHECK (ready_until IS NULL OR (venue_key IS NOT NULL AND input_version IS NOT NULL))
);

-- Reservations (not just successes) count against a rolling provider budget.
CREATE TABLE transit_sf_walk_reservations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  credits INTEGER NOT NULL CHECK (credits BETWEEN 1 AND 40)
);

CREATE INDEX transit_sf_walk_reservations_time_idx ON transit_sf_walk_reservations(reserved_at);
