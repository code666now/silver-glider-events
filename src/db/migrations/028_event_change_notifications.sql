-- Critical event updates are queued in the same transaction as the event
-- change, then delivered asynchronously with per-RSVP retry tracking.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS calendar_sequence INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS event_notification_batches (
  id              BIGSERIAL PRIMARY KEY,
  event_id        INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('event_updated','event_cancelled')),
  changes         JSONB NOT NULL DEFAULT '[]'::jsonb,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','sent','partial_failed','failed')),
  recipient_count INT NOT NULL DEFAULT 0,
  sent_count      INT NOT NULL DEFAULT 0,
  failed_count    INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS event_notification_batches_pending_idx
  ON event_notification_batches (created_at)
  WHERE status IN ('pending','processing','partial_failed');

ALTER TABLE message_log
  ADD COLUMN IF NOT EXISTS notification_batch_id BIGINT REFERENCES event_notification_batches(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

ALTER TABLE message_log DROP CONSTRAINT IF EXISTS message_log_message_type_check;
ALTER TABLE message_log ADD CONSTRAINT message_log_message_type_check
  CHECK (message_type IN (
    'magic_link','rsvp_confirmation','reminder_day_before','reminder_day_of',
    'announcement','photo_request','event_updated','event_cancelled'
  ));

DROP INDEX IF EXISTS message_log_dedupe_uq;
CREATE UNIQUE INDEX message_log_dedupe_uq
  ON message_log (rsvp_id, message_type, channel)
  WHERE rsvp_id IS NOT NULL AND notification_batch_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS message_log_event_notification_dedupe_uq
  ON message_log (notification_batch_id, rsvp_id, channel)
  WHERE notification_batch_id IS NOT NULL AND rsvp_id IS NOT NULL;
