-- Hosts can invite eligible primary RSVPs from one past event to one upcoming
-- event. Recipient details are snapshotted so a past event may later be deleted
-- without interrupting already-queued delivery.
CREATE TABLE IF NOT EXISTS previous_guest_invitation_batches (
  id                 BIGSERIAL PRIMARY KEY,
  target_event_id    INT NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  source_event_id    INT REFERENCES events(id) ON DELETE SET NULL,
  source_event_title TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','processing','sent','partial_failed','failed')),
  recipient_count    INT NOT NULL DEFAULT 0,
  sent_count         INT NOT NULL DEFAULT 0,
  failed_count       INT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS previous_guest_invitation_batches_pending_idx
  ON previous_guest_invitation_batches (created_at)
  WHERE status IN ('pending','processing','partial_failed');

ALTER TABLE message_log
  ADD COLUMN IF NOT EXISTS previous_guest_invitation_batch_id BIGINT
    REFERENCES previous_guest_invitation_batches(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS recipient_name TEXT;

ALTER TABLE message_log DROP CONSTRAINT IF EXISTS message_log_message_type_check;
ALTER TABLE message_log ADD CONSTRAINT message_log_message_type_check
  CHECK (message_type IN (
    'magic_link','rsvp_confirmation','reminder_day_before','reminder_day_of',
    'announcement','photo_request','event_updated','event_cancelled','previous_guest_invite'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS message_log_previous_guest_invitation_dedupe_uq
  ON message_log (previous_guest_invitation_batch_id, LOWER(recipient))
  WHERE previous_guest_invitation_batch_id IS NOT NULL;
