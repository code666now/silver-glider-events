-- Personal attendee identity is separate from public Host Page artwork.
ALTER TABLE organizers
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- RSVP remains valid without an account. Links are created only when a
-- verified signed-in account RSVPs with its own email address.
ALTER TABLE rsvps
  ADD COLUMN IF NOT EXISTS account_id INT REFERENCES organizers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS rsvps_account_idx ON rsvps (account_id);
