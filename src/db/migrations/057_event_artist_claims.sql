-- A host can credit the artists playing their night (the Event Vibe slots).
-- When the host supplies an email, that artist is invited to claim the slot:
-- claiming links the slot to their account, "not me" takes the name off the
-- public page. A claim never grants any access to the host's guest list.
CREATE TABLE IF NOT EXISTS event_artist_claims (
  id SERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  slot SMALLINT NOT NULL CHECK (slot BETWEEN 1 AND 3),
  artist_name TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'claimed', 'declined')),
  organizer_id INTEGER REFERENCES organizers(id) ON DELETE SET NULL,
  invited_at TIMESTAMPTZ DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT event_artist_claims_event_slot_uq UNIQUE (event_id, slot),
  CONSTRAINT event_artist_claims_claimed_has_account CHECK (status <> 'claimed' OR organizer_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS event_artist_claims_email_idx ON event_artist_claims (LOWER(email));
CREATE INDEX IF NOT EXISTS event_artist_claims_organizer_idx ON event_artist_claims (organizer_id) WHERE status = 'claimed';

COMMENT ON TABLE event_artist_claims IS
  'Links an Event Vibe artist slot to the artist''s own account once they claim it. Credit and followers only: never access to the host''s guests.';
