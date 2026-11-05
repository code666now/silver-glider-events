-- Cosmetic event preferences only. This migration creates no RSVPs or messages.
CREATE TABLE IF NOT EXISTS event_guest_avatar_overrides (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL
    CHECK (recipient_email = LOWER(BTRIM(recipient_email)) AND LENGTH(recipient_email) BETWEEN 3 AND 254),
  emoji TEXT NOT NULL CHECK (emoji IN ('🙂','😎','😊','🤠','😁','😄','🐳','👽','🐟','🥷','🐬','👨‍🎤','🦭','🦀','👰')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, recipient_email)
);
