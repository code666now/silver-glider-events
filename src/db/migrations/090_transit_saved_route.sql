-- One optional transit choice per canonical guest, not per host or event.
-- Store exact feed identifiers only: never a home address, contact detail,
-- itinerary, event association, or reminder consent.
CREATE TABLE transit_saved_routes (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  selection_kind TEXT NOT NULL,
  stop_id TEXT,
  route_id TEXT,
  direction TEXT,
  headsign TEXT,
  station_id TEXT,
  destination_station_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (stop_id IS NULL OR CHAR_LENGTH(BTRIM(stop_id)) BETWEEN 1 AND 256),
  CHECK (route_id IS NULL OR CHAR_LENGTH(BTRIM(route_id)) BETWEEN 1 AND 256),
  CHECK (station_id IS NULL OR CHAR_LENGTH(BTRIM(station_id)) BETWEEN 1 AND 256),
  CHECK (destination_station_id IS NULL OR CHAR_LENGTH(BTRIM(destination_station_id)) BETWEEN 1 AND 256),
  CHECK (headsign IS NULL OR CHAR_LENGTH(headsign) <= 256),
  CHECK (
    (selection_kind = 'stop' AND stop_id IS NOT NULL AND route_id IS NOT NULL
      AND direction IS NOT NULL AND direction IN ('', '0', '1') AND headsign IS NOT NULL
      AND station_id IS NULL AND destination_station_id IS NULL)
    OR
    (selection_kind = 'rail' AND station_id IS NOT NULL AND destination_station_id IS NOT NULL
      AND station_id <> destination_station_id AND stop_id IS NULL AND route_id IS NULL
      AND direction IS NULL AND headsign IS NULL)
  )
);

-- Account erasure retains a canonical user tombstone. A cascade on hard delete
-- alone would leave the guest's route preference behind.
CREATE FUNCTION erase_transit_saved_route() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM transit_saved_routes WHERE user_id = NEW.id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER erase_transit_saved_route_on_account_deletion
  AFTER UPDATE OF account_status ON users
  FOR EACH ROW
  WHEN (OLD.account_status IS DISTINCT FROM NEW.account_status AND NEW.account_status = 'deleted')
  EXECUTE FUNCTION erase_transit_saved_route();
