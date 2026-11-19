ALTER TABLE organizers
  ADD COLUMN auto_follower_email BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN auto_follower_email_timezone TEXT,
  ADD COLUMN auto_follower_email_disabled_at TIMESTAMPTZ;

ALTER TABLE events ADD COLUMN skip_follower_email BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE automatic_follower_email_events (
  event_id INT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  organizer_id INT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reserved','complete','skipped')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  available_at TIMESTAMPTZ NOT NULL,
  send_now_at TIMESTAMPTZ,
  skip_reason TEXT
);
CREATE INDEX automatic_follower_email_events_ready_idx
  ON automatic_follower_email_events (available_at, organizer_id) WHERE status='pending';
CREATE INDEX automatic_follower_email_events_host_idx
  ON automatic_follower_email_events (organizer_id, event_id) WHERE status IN ('pending','reserved');

CREATE TABLE automatic_follower_email_deliveries (
  id BIGSERIAL PRIMARY KEY,
  organizer_id INT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL CHECK (recipient=LOWER(BTRIM(recipient))),
  recipient_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  local_day DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','skipped','unknown')),
  payload JSONB,
  attempt_count INT NOT NULL DEFAULT 0,
  first_attempt_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  provider_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX automatic_follower_email_delivery_address_day_uq
  ON automatic_follower_email_deliveries (organizer_id, local_day, recipient)
  WHERE status<>'skipped';
CREATE UNIQUE INDEX automatic_follower_email_delivery_person_day_uq
  ON automatic_follower_email_deliveries (organizer_id, local_day, recipient_user_id)
  WHERE recipient_user_id IS NOT NULL AND status<>'skipped';
CREATE INDEX automatic_follower_email_deliveries_ready_idx
  ON automatic_follower_email_deliveries (next_attempt_at, id) WHERE status IN ('pending','sending');

-- The existing per-event invitation ledger is also the digest membership
-- ledger. A reservation has a due time until it belongs to a delivery.
ALTER TABLE message_log
  ADD COLUMN automatic_follower_email_delivery_id BIGINT REFERENCES automatic_follower_email_deliveries(id) ON DELETE SET NULL,
  ADD COLUMN automatic_follower_email_next_at TIMESTAMPTZ;
CREATE INDEX message_log_automatic_follower_email_due_idx
  ON message_log (automatic_follower_email_next_at, event_id)
  WHERE automatic_follower_email_next_at IS NOT NULL AND status='pending';
CREATE INDEX message_log_automatic_follower_email_delivery_idx
  ON message_log (automatic_follower_email_delivery_id, id) WHERE automatic_follower_email_delivery_id IS NOT NULL;
CREATE INDEX message_log_automatic_follower_email_event_pending_idx
  ON message_log (event_id) WHERE status='pending' AND
  (automatic_follower_email_next_at IS NOT NULL OR automatic_follower_email_delivery_id IS NOT NULL);

-- Disabling is a cutover for existing work, not a pause. A quick off/on may
-- allow new publications but cannot release jobs from before the change.
CREATE FUNCTION mark_automatic_follower_email_disable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.auto_follower_email AND NOT NEW.auto_follower_email THEN
    NEW.auto_follower_email_disabled_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER organizers_mark_automatic_follower_email_disable
  BEFORE UPDATE OF auto_follower_email ON organizers
  FOR EACH ROW EXECUTE FUNCTION mark_automatic_follower_email_disable();

CREATE FUNCTION queue_automatic_follower_email() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  eligible_host INT;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.status<>'published' OR NEW.visibility<>'public' OR NEW.secret_show_enabled
                         OR NEW.archived_at IS NOT NULL OR NEW.skip_follower_email) THEN
    UPDATE automatic_follower_email_events
       SET status='skipped', skip_reason=CASE WHEN NEW.skip_follower_email THEN 'event_opted_out' ELSE 'event_unavailable' END
     WHERE event_id=NEW.id AND status IN ('pending','reserved');
  END IF;

  -- Only approved publisher transactions opt in. No migration backfill, old
  -- running instance, later edit, or status restoration can enroll a job.
  IF current_setting('sge.auto_follower_email', true)='on'
     AND NEW.first_published_at IS NOT NULL AND (TG_OP='INSERT' OR OLD.first_published_at IS NULL)
     AND NEW.status='published' AND NEW.visibility='public' AND NOT NEW.secret_show_enabled
     AND NEW.archived_at IS NULL AND NOT NEW.skip_follower_email THEN
    SELECT host.id INTO eligible_host
      FROM organizers host JOIN users account ON account.id=host.user_id
     WHERE host.id=NEW.organizer_id AND host.auto_follower_email AND account.account_status='active';
    IF eligible_host IS NOT NULL THEN
      -- One-time, stable host-local calendar. Later publications do not need
      -- an organizer write for this feature or wait on email transport.
      UPDATE organizers SET auto_follower_email_timezone=CASE
        WHEN EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=NEW.timezone) THEN NEW.timezone
        ELSE 'America/Los_Angeles' END
      WHERE id=eligible_host AND auto_follower_email_timezone IS NULL;
      -- Use the publication statement's start for the opt-out cutover. Even
      -- if disabling races this statement, it cannot revive the older job.
      INSERT INTO automatic_follower_email_events (event_id, organizer_id, created_at, available_at)
        VALUES (NEW.id, eligible_host, statement_timestamp(), clock_timestamp() + INTERVAL '10 minutes')
        ON CONFLICT (event_id) DO NOTHING;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER events_queue_automatic_follower_email
  AFTER INSERT OR UPDATE ON events FOR EACH ROW EXECUTE FUNCTION queue_automatic_follower_email();
