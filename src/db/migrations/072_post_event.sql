-- Private post-event records. Hosts may save an estimated turnout and prepare
-- one reviewed thank-you delivery per event. Neither table is used by public
-- event queries.
CREATE TABLE IF NOT EXISTS event_turnout_estimates (
  event_id              INT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  estimated_turnout     INT NOT NULL CHECK (estimated_turnout BETWEEN 0 AND 100000),
  submitted_by_user_id  INT REFERENCES users(id) ON DELETE SET NULL,
  submitted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE event_turnout_estimates IS
  'Private, unverified host estimate for an ended event; never public attendance data.';

CREATE TABLE IF NOT EXISTS post_event_thank_you_batches (
  id                   BIGSERIAL PRIMARY KEY,
  event_id             INT NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  organizer_id         INT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  subject              TEXT NOT NULL,
  message              TEXT NOT NULL,
  include_follow       BOOLEAN NOT NULL DEFAULT FALSE,
  render_snapshot      JSONB,
  render_snapshot_hash TEXT,
  status               TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','pending','processing','sent','partial_failed','failed')),
  recipient_count      INT NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
  sent_count           INT NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  failed_count         INT NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  skipped_count        INT NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  approved_by_user_id  INT REFERENCES users(id) ON DELETE SET NULL,
  approved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ,
  CONSTRAINT post_event_thank_you_subject_check
    CHECK (CHAR_LENGTH(BTRIM(subject)) BETWEEN 1 AND 160),
  CONSTRAINT post_event_thank_you_message_check
    CHECK (CHAR_LENGTH(BTRIM(message)) BETWEEN 1 AND 4000),
  CONSTRAINT post_event_thank_you_snapshot_check CHECK (
    (render_snapshot IS NULL AND render_snapshot_hash IS NULL)
    OR
    (render_snapshot IS NOT NULL
      AND render_snapshot_hash ~ '^[a-f0-9]{64}$')
  )
);

CREATE INDEX IF NOT EXISTS post_event_thank_you_batches_pending_idx
  ON post_event_thank_you_batches (created_at)
  WHERE status IN ('pending','processing','partial_failed');

ALTER TABLE message_log
  ADD COLUMN IF NOT EXISTS post_event_thank_you_batch_id BIGINT
    REFERENCES post_event_thank_you_batches(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS post_event_already_following BOOLEAN;

ALTER TABLE message_log DROP CONSTRAINT IF EXISTS message_log_message_type_check;
ALTER TABLE message_log ADD CONSTRAINT message_log_message_type_check
  CHECK (message_type IN (
    'magic_link','rsvp_confirmation','reminder_day_before','reminder_day_of',
    'announcement','photo_request','event_updated','event_cancelled',
    'previous_guest_invite','post_event_thank_you'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS message_log_post_event_thank_you_dedupe_uq
  ON message_log (post_event_thank_you_batch_id, rsvp_id, channel)
  WHERE post_event_thank_you_batch_id IS NOT NULL AND rsvp_id IS NOT NULL;

COMMENT ON COLUMN message_log.post_event_already_following IS
  'Recipient-specific Host Page follow state snapshotted when a post-event batch is approved.';
