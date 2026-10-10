-- A Done For You flyer request is durable intake/audit history, while the
-- generated event belongs to the host and may be permanently deleted from
-- Home Base. Detach that historical request instead of blocking the owner's
-- event deletion or erasing the original submission record.
ALTER TABLE admin_flyer_requests
  DROP CONSTRAINT IF EXISTS admin_flyer_requests_event_id_fkey;

ALTER TABLE admin_flyer_requests
  ADD CONSTRAINT admin_flyer_requests_event_id_fkey
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL;

COMMENT ON COLUMN admin_flyer_requests.event_id IS
  'Generated Done For You event; cleared if the owner permanently deletes that event.';
