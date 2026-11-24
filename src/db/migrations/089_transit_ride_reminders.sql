-- Event-specific, complimentary ride reminders. This queue never changes
-- RSVP marketing consent or organizer balances. One durable row per user and
-- event; a claimed attempt is never reissued if provider acceptance is unclear.
CREATE TABLE transit_ride_reminders (
  id BIGSERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rsvp_id INTEGER NOT NULL REFERENCES rsvps(id) ON DELETE CASCADE,
  phone_identity_id BIGINT REFERENCES user_identities(id) ON DELETE SET NULL,
  event_phone_proof_id BIGINT REFERENCES sms_notification_recipients(id) ON DELETE SET NULL,
  request_id UUID NOT NULL DEFAULT gen_random_uuid(),
  selection JSONB,
  reminder_at TIMESTAMPTZ NOT NULL,
  leave_by_at TIMESTAMPTZ NOT NULL,
  consent_version TEXT NOT NULL,
  consented_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed','cancelled','unknown')),
  outcome TEXT,
  attempted_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  provider_message_sid TEXT UNIQUE,
  CONSTRAINT transit_ride_reminders_one_user_event UNIQUE (event_id, user_id),
  CONSTRAINT transit_ride_reminders_one_phone_identity_event UNIQUE (event_id, phone_identity_id),
  CONSTRAINT transit_ride_reminders_one_phone_proof_event UNIQUE (event_id, event_phone_proof_id),
  CHECK (phone_identity_id IS NULL OR event_phone_proof_id IS NULL),
  CHECK (leave_by_at = reminder_at + INTERVAL '30 minutes'),
  CHECK ((status = 'pending') = (selection IS NOT NULL)),
  CHECK (selection IS NULL OR jsonb_typeof(selection) = 'object'),
  CHECK (status NOT IN ('sending','sent','unknown') OR attempted_at IS NOT NULL),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL AND provider_message_sid IS NOT NULL))
);

CREATE INDEX transit_ride_reminders_due_idx
  ON transit_ride_reminders (reminder_at, id) WHERE status='pending';

-- Keep a non-personal count independent of queue rows and account deletions.
-- Unknown submissions count against both caps and are never sent again.
CREATE TABLE transit_ride_sms_usage (
  usage_day DATE PRIMARY KEY,
  attempted_segments INTEGER NOT NULL CHECK (attempted_segments > 0)
);

-- Durable, app-side source of STOP suppression, regardless of rollout state.
-- No route, event, user, or message details are associated with the number.
CREATE TABLE transit_ride_sms_optouts (
  phone_e164 TEXT PRIMARY KEY CHECK (phone_e164 ~ '^\+1[0-9]{10}$'),
  opted_out_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
