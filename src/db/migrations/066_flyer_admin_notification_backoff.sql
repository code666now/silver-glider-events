-- Some development environments applied the initial operational-email outbox
-- while this release was still under review. Keep the retry upgrade additive so
-- those ledgers resume delivery instead of requiring a schema reset.
ALTER TABLE admin_flyer_request_notifications
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

DROP INDEX IF EXISTS admin_flyer_request_notifications_retry_idx;

CREATE INDEX IF NOT EXISTS admin_flyer_request_notifications_due_idx
  ON admin_flyer_request_notifications (next_attempt_at,id)
  WHERE status IN ('pending','failed');

CREATE INDEX IF NOT EXISTS admin_flyer_request_notifications_lease_idx
  ON admin_flyer_request_notifications (last_attempt_at,id)
  WHERE status='sending';
