-- Archive: hide events from the list without losing RSVPs/guest data
ALTER TABLE events ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
