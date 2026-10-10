-- Recipient approval now publishes a reviewed Done For You draft without a
-- second staff action. Keep every outbound delivery in a durable ledger, and
-- identify the verified recipient as the publication actor without pretending
-- that an administrator clicked Publish.

ALTER TABLE admin_flyer_request_messages
  ALTER COLUMN initiated_by_admin_operator_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

ALTER TABLE admin_flyer_request_messages
  DROP CONSTRAINT IF EXISTS admin_flyer_request_messages_message_kind_check;
ALTER TABLE admin_flyer_request_messages
  DROP CONSTRAINT IF EXISTS admin_flyer_request_messages_status_check;
ALTER TABLE admin_flyer_request_messages
  DROP CONSTRAINT IF EXISTS admin_flyer_request_messages_attempt_count_check;
ALTER TABLE admin_flyer_request_messages
  ADD CONSTRAINT admin_flyer_request_messages_message_kind_check
    CHECK (message_kind IN ('preview','live','pilot_publish')),
  ADD CONSTRAINT admin_flyer_request_messages_status_check
    CHECK (status IN ('pending','sending','sent','failed')),
  ADD CONSTRAINT admin_flyer_request_messages_attempt_count_check
    CHECK (attempt_count>=0);

-- A request should own its event, but older schemas did not enforce that as a
-- uniqueness constraint. Backfill one canonical live ledger per event so an
-- unexpected historical duplicate cannot make this safe additive migration
-- fail when the event-level uniqueness index is created.
WITH ranked AS (
  SELECT message.id,request.event_id,
         ROW_NUMBER() OVER (
           PARTITION BY request.event_id,message.message_kind
           ORDER BY (message.status='sent') DESC,message.revision DESC,message.id DESC
         ) AS delivery_rank
   FROM admin_flyer_request_messages message
    JOIN admin_flyer_requests request ON request.id=message.flyer_request_id
   WHERE message.message_kind IN ('live','pilot_publish')
     AND request.event_id IS NOT NULL
)
UPDATE admin_flyer_request_messages message
   SET event_id=ranked.event_id
  FROM ranked
 WHERE message.id=ranked.id AND message.event_id IS NULL AND ranked.delivery_rank=1;

CREATE INDEX IF NOT EXISTS admin_flyer_request_messages_due_idx
  ON admin_flyer_request_messages (next_attempt_at,id)
  WHERE message_kind IN ('live','pilot_publish') AND status IN ('pending','failed');

CREATE INDEX IF NOT EXISTS admin_flyer_request_messages_lease_idx
  ON admin_flyer_request_messages (last_attempt_at,id)
  WHERE message_kind IN ('live','pilot_publish') AND status='sending';

CREATE UNIQUE INDEX IF NOT EXISTS admin_flyer_request_messages_event_delivery_uq
  ON admin_flyer_request_messages (event_id,message_kind)
  WHERE event_id IS NOT NULL AND message_kind IN ('live','pilot_publish');

COMMENT ON COLUMN admin_flyer_request_messages.initiated_by_admin_operator_id IS
  'Present for staff-sent previews; NULL for publication messages triggered by a verified flyer recipient.';

ALTER TABLE admin_account_audit_log
  ADD COLUMN IF NOT EXISTS actor_system TEXT;
ALTER TABLE admin_account_audit_log
  DROP CONSTRAINT IF EXISTS admin_account_audit_actor_check;
ALTER TABLE admin_account_audit_log
  DROP CONSTRAINT IF EXISTS admin_account_audit_actor_system_check;
ALTER TABLE admin_account_audit_log
  ADD CONSTRAINT admin_account_audit_actor_system_check
    CHECK (actor_system IS NULL OR actor_system IN ('verified_flyer_recipient')),
  ADD CONSTRAINT admin_account_audit_actor_check
    CHECK (NUM_NONNULLS(actor_user_id,actor_admin_operator_id,actor_system)=1);

ALTER TABLE admin_flyer_requests
  DROP CONSTRAINT IF EXISTS admin_flyer_requests_claim_invitation_status_check;
ALTER TABLE admin_flyer_requests
  ADD CONSTRAINT admin_flyer_requests_claim_invitation_status_check
    CHECK (claim_invitation_status IS NULL OR claim_invitation_status IN (
      'pending','sending','sent','not_needed','failed'
    ));

-- One row per canonical owner makes the first-event welcome a durable, global
-- once-only operation rather than a per-flyer-request side effect.
CREATE TABLE IF NOT EXISTS admin_done_for_you_welcome_deliveries (
  target_user_id                 INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  flyer_request_id               BIGINT NOT NULL UNIQUE
                                   REFERENCES admin_flyer_requests(id) ON DELETE CASCADE,
  authorizing_admin_operator_id  BIGINT NOT NULL REFERENCES admin_operators(id),
  status                         TEXT NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending','sending','sent','failed')),
  attempt_count                  INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count>=0),
  last_attempt_at                TIMESTAMPTZ,
  next_attempt_at                TIMESTAMPTZ,
  invitation_id                  BIGINT REFERENCES admin_account_invitations(id),
  error                          TEXT,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at                        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS admin_done_for_you_welcome_due_idx
  ON admin_done_for_you_welcome_deliveries (next_attempt_at,target_user_id)
  WHERE status IN ('pending','failed');

CREATE INDEX IF NOT EXISTS admin_done_for_you_welcome_lease_idx
  ON admin_done_for_you_welcome_deliveries (last_attempt_at,target_user_id)
  WHERE status='sending';

COMMENT ON TABLE admin_done_for_you_welcome_deliveries IS
  'Durable once-per-owner welcome/Home Base delivery created by the first Done For You publication.';

-- Preserve successful deliveries from releases that stored the once-only fact
-- only on the flyer request. Without this backfill, reopening an older live
-- preview could create and send a second welcome after this migration.
INSERT INTO admin_done_for_you_welcome_deliveries
  (target_user_id,flyer_request_id,authorizing_admin_operator_id,status,
   invitation_id,created_at,sent_at)
SELECT DISTINCT ON (marker.target_user_id)
       marker.target_user_id,request.id,
       COALESCE(request.assigned_admin_operator_id,marker.created_by_admin_operator_id),
       'sent',request.claim_invitation_id,
       COALESCE(request.published_at,request.created_at),
       COALESCE(request.claim_invitation_sent_at,request.published_at,request.updated_at)
  FROM admin_flyer_requests request
  JOIN admin_done_for_you_clients marker ON marker.id=request.done_for_you_client_id
 WHERE request.status='published'
   AND request.claim_invitation_status='sent'
 ORDER BY marker.target_user_id,
          COALESCE(request.claim_invitation_sent_at,request.published_at,request.created_at),
          request.id
ON CONFLICT (target_user_id) DO NOTHING;

-- Request-a-fix is the only review action that notifies staff. Keep approved in
-- the constraint solely so historical rows remain readable; new code never
-- enqueues it and the worker skips any undelivered legacy approval notice.
ALTER TABLE admin_flyer_request_notifications
  ADD COLUMN IF NOT EXISTS notification_revision INTEGER NOT NULL DEFAULT 1,
  DROP CONSTRAINT IF EXISTS admin_flyer_request_notifications_notification_kind_check;

DO $$
DECLARE
  old_unique_name TEXT;
BEGIN
  SELECT constraint_name INTO old_unique_name
    FROM information_schema.table_constraints
   WHERE table_schema=current_schema()
     AND table_name='admin_flyer_request_notifications'
     AND constraint_type='UNIQUE'
     AND constraint_name<> 'admin_flyer_request_notifications_idempotency_key_key'
   ORDER BY constraint_name
   LIMIT 1;
  IF old_unique_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE admin_flyer_request_notifications DROP CONSTRAINT %I',
      old_unique_name
    );
  END IF;
END $$;

ALTER TABLE admin_flyer_request_notifications
  ADD CONSTRAINT admin_flyer_request_notifications_notification_kind_check
    CHECK (notification_kind IN ('submitted','approved','fix_requested')),
  ADD CONSTRAINT admin_flyer_request_notifications_revision_check
    CHECK (notification_revision>0),
  ADD CONSTRAINT admin_flyer_request_notifications_request_kind_revision_recipient_key
    UNIQUE (flyer_request_id,notification_kind,notification_revision,recipient);
