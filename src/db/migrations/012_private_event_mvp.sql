-- Tight private-event MVP: opt-in social settings, one named guest, and comments.
-- Defaults preserve every existing event's current public-page behavior.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS show_guest_list BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS allow_guests BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS comments_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE rsvps
  ADD COLUMN IF NOT EXISTS guest_first_name TEXT,
  ADD COLUMN IF NOT EXISTS guest_last_name TEXT,
  ADD COLUMN IF NOT EXISTS guest_email TEXT;

CREATE TABLE IF NOT EXISTS event_comments (
  id         BIGSERIAL PRIMARY KEY,
  event_id   INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  rsvp_id    INT NOT NULL REFERENCES rsvps(id) ON DELETE CASCADE,
  message    VARCHAR(300) NOT NULL CHECK (LENGTH(BTRIM(message)) BETWEEN 1 AND 300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS event_comments_event_created_idx
  ON event_comments (event_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS event_comments_rsvp_idx
  ON event_comments (rsvp_id);
