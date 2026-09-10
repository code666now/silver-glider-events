-- Familiar Faces can send separate, reviewed groups from old events to the
-- same upcoming event. Recipient-level deduplication keeps each person from
-- receiving the same event invitation twice.
ALTER TABLE previous_guest_invitation_batches
  DROP CONSTRAINT IF EXISTS previous_guest_invitation_batches_target_event_id_key;

CREATE INDEX IF NOT EXISTS previous_guest_invitation_batches_target_idx
  ON previous_guest_invitation_batches (target_event_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS message_log_previous_guest_target_recipient_uq
  ON message_log (event_id, LOWER(recipient))
  WHERE message_type='previous_guest_invite';
