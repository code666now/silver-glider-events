-- Per-organizer unsubscribe list for follower announcements
CREATE TABLE IF NOT EXISTS follower_optouts (
  id           SERIAL PRIMARY KEY,
  organizer_id INT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS follower_optouts_uq ON follower_optouts (organizer_id, LOWER(email));

-- Track that an event was announced to followers (one-shot, with a count)
ALTER TABLE events ADD COLUMN IF NOT EXISTS announced_at    TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS announced_count INT NOT NULL DEFAULT 0;

-- Allow 'announcement' as a logged message type
ALTER TABLE message_log DROP CONSTRAINT IF EXISTS message_log_message_type_check;
ALTER TABLE message_log ADD CONSTRAINT message_log_message_type_check
  CHECK (message_type IN ('magic_link','rsvp_confirmation','reminder_day_before','reminder_day_of','announcement'));
