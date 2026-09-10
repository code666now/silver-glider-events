-- Paid, host-controlled lifecycle SMS batches. Credits are reserved atomically
-- before any delivery work starts; provider callbacks update the recipient rows.
CREATE TABLE IF NOT EXISTS sms_notification_batches (
  id               BIGSERIAL PRIMARY KEY,
  event_id         INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  organizer_id     INT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('event_tomorrow')),
  message_body     TEXT NOT NULL,
  segment_count    INT NOT NULL CHECK (segment_count > 0),
  recipient_count  INT NOT NULL CHECK (recipient_count > 0),
  credit_cost      INT NOT NULL CHECK (credit_cost > 0),
  refunded_credits INT NOT NULL DEFAULT 0 CHECK (refunded_credits >= 0),
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','processing','sent','partial_failed','failed')),
  accepted_count   INT NOT NULL DEFAULT 0,
  delivered_count  INT NOT NULL DEFAULT 0,
  failed_count     INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  UNIQUE (event_id, kind)
);

CREATE INDEX IF NOT EXISTS sms_notification_batches_pending_idx
  ON sms_notification_batches (created_at)
  WHERE status IN ('pending','processing','partial_failed');

CREATE TABLE IF NOT EXISTS sms_notification_recipients (
  id                 BIGSERIAL PRIMARY KEY,
  batch_id           BIGINT NOT NULL REFERENCES sms_notification_batches(id) ON DELETE CASCADE,
  rsvp_id            INT REFERENCES rsvps(id) ON DELETE SET NULL,
  recipient          TEXT NOT NULL,
  recipient_name     TEXT,
  segment_count      INT NOT NULL CHECK (segment_count > 0),
  status_token       UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','processing','accepted','queued','sending','sent','delivered','undelivered','failed')),
  provider_status    TEXT,
  provider_message_sid TEXT UNIQUE,
  provider_error_code TEXT,
  attempt_count      INT NOT NULL DEFAULT 0,
  last_attempt_at    TIMESTAMPTZ,
  accepted_at        TIMESTAMPTZ,
  delivered_at       TIMESTAMPTZ,
  failed_at          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (batch_id, recipient)
);

CREATE INDEX IF NOT EXISTS sms_notification_recipients_retry_idx
  ON sms_notification_recipients (batch_id, last_attempt_at)
  WHERE status IN ('pending','failed');
