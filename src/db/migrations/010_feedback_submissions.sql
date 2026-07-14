CREATE TABLE IF NOT EXISTS feedback_submissions (
  id                        BIGSERIAL PRIMARY KEY,
  type                      TEXT NOT NULL CHECK (type IN ('bug', 'suggestion', 'other')),
  message                   TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewing', 'resolved')),
  submitted_by_organizer_id INT REFERENCES organizers(id) ON DELETE SET NULL,
  organizer_id              INT REFERENCES organizers(id) ON DELETE SET NULL,
  user_name                 TEXT,
  user_email                TEXT NOT NULL,
  page_url                  TEXT NOT NULL,
  route                     TEXT NOT NULL,
  event_id                  INT REFERENCES events(id) ON DELETE SET NULL,
  user_agent                TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS feedback_created_idx ON feedback_submissions (created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_status_idx ON feedback_submissions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_type_idx ON feedback_submissions (type, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_organizer_idx ON feedback_submissions (organizer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_event_idx ON feedback_submissions (event_id) WHERE event_id IS NOT NULL;
