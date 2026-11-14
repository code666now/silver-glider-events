-- Emergency moderation (V1): Super Admins can take an image off the public
-- internet or hide a whole event, and undo either. Every published event
-- alerts the admin team once. Nothing here delays or gates publishing.

-- A hidden event keeps every record (RSVPs, comments, photos) but leaves
-- public view. Every public query already shows only 'published' (and the
-- going list 'cancelled'), so a new status hides it everywhere by default.
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_status_check;
ALTER TABLE events ADD CONSTRAINT events_status_check
  CHECK (status IN ('draft','published','cancelled','hidden'));

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hidden_previous_status TEXT,
  ADD COLUMN IF NOT EXISTS hidden_reason TEXT,
  ADD COLUMN IF NOT EXISTS hidden_by_admin_operator_id BIGINT REFERENCES admin_operators(id) ON DELETE SET NULL;

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_hidden_state_check;
ALTER TABLE events ADD CONSTRAINT events_hidden_state_check CHECK (
  (status='hidden' AND hidden_at IS NOT NULL AND hidden_previous_status IN ('published','cancelled'))
  OR (status<>'hidden')
);

-- One row per removed image file. The same file can sit on several events
-- (duplicating an event copies its images), so the places it was cleared
-- from are kept separately and restored together.
CREATE TABLE IF NOT EXISTS event_image_removals (
  id BIGSERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  image_field TEXT NOT NULL CHECK (image_field IN (
    'cover_image_url','flyer_image_url','event_vibe_image_url',
    'event_vibe_image_url_2','event_vibe_image_url_3'
  )),
  image_url TEXT NOT NULL,
  -- NULL for images not stored on our Cloudinary (a credited stock photo).
  cloudinary_public_id TEXT,
  -- 'private': moved out of public delivery. 'failed': the page no longer
  -- shows it but the file is still reachable; the admin can retry.
  storage_state TEXT NOT NULL DEFAULT 'not_applicable'
    CHECK (storage_state IN ('not_applicable','pending','private','failed','public')),
  storage_error TEXT,
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  removed_by_admin_operator_id BIGINT REFERENCES admin_operators(id) ON DELETE SET NULL,
  removed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  restored_by_admin_operator_id BIGINT REFERENCES admin_operators(id) ON DELETE SET NULL,
  restored_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS event_image_removals_event_idx
  ON event_image_removals (event_id, removed_at DESC);
-- An image file can be under one active removal at a time.
CREATE UNIQUE INDEX IF NOT EXISTS event_image_removals_active_url_uq
  ON event_image_removals (image_url) WHERE restored_at IS NULL;

CREATE TABLE IF NOT EXISTS event_image_removal_refs (
  removal_id BIGINT NOT NULL REFERENCES event_image_removals(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  image_field TEXT NOT NULL,
  -- The exact link that was cleared here, put back on restore.
  image_url TEXT NOT NULL,
  PRIMARY KEY (removal_id, event_id, image_field)
);
CREATE INDEX IF NOT EXISTS event_image_removal_refs_event_idx
  ON event_image_removal_refs (event_id);

-- Minimal audit trail of every emergency action and its reversal.
CREATE TABLE IF NOT EXISTS event_moderation_actions (
  id BIGSERIAL PRIMARY KEY,
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('remove_image','restore_image','retry_image','hide_event','unhide_event')),
  image_field TEXT,
  image_url TEXT,
  removal_id BIGINT REFERENCES event_image_removals(id) ON DELETE SET NULL,
  reason TEXT,
  admin_operator_id BIGINT REFERENCES admin_operators(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS event_moderation_actions_event_idx
  ON event_moderation_actions (event_id, created_at DESC);

-- Internal alerts. One alert per (event, kind, key): a first publication, or
-- a new image on an event that had one removed. The job fans each alert out
-- to every active Super Admin and Support admin at send time.
CREATE TABLE IF NOT EXISTS event_admin_alerts (
  id BIGSERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('first_published','image_replaced')),
  dedupe_key TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fanned_out_at TIMESTAMPTZ,
  UNIQUE (event_id, kind, dedupe_key)
);
CREATE INDEX IF NOT EXISTS event_admin_alerts_pending_idx
  ON event_admin_alerts (created_at) WHERE fanned_out_at IS NULL;

CREATE TABLE IF NOT EXISTS event_admin_alert_deliveries (
  id BIGSERIAL PRIMARY KEY,
  alert_id BIGINT NOT NULL REFERENCES event_admin_alerts(id) ON DELETE CASCADE,
  admin_operator_id BIGINT REFERENCES admin_operators(id) ON DELETE SET NULL,
  recipient TEXT NOT NULL CHECK (recipient=LOWER(BTRIM(recipient))),
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','abandoned')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  provider_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (alert_id, recipient)
);
CREATE INDEX IF NOT EXISTS event_admin_alert_deliveries_due_idx
  ON event_admin_alert_deliveries (next_attempt_at) WHERE status IN ('pending','failed','sending');

-- Alerts are raised by the database itself, so every way an event can be
-- published (create, publish a draft, the admin editor, Done For You) and
-- every way an image can change is covered without touching those paths.
CREATE OR REPLACE FUNCTION raise_event_admin_alerts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  field TEXT;
  old_value TEXT;
  new_value TEXT;
BEGIN
  IF NEW.first_published_at IS NOT NULL
     AND (TG_OP='INSERT' OR OLD.first_published_at IS NULL) THEN
    INSERT INTO event_admin_alerts (event_id, kind)
    VALUES (NEW.id, 'first_published')
    ON CONFLICT DO NOTHING;
  END IF;

  IF TG_OP='UPDATE' AND EXISTS (
       SELECT 1 FROM event_image_removal_refs ref
         JOIN event_image_removals removal ON removal.id=ref.removal_id
        WHERE ref.event_id=NEW.id AND removal.restored_at IS NULL
     ) THEN
    FOREACH field IN ARRAY ARRAY['cover_image_url','flyer_image_url','event_vibe_image_url',
                                 'event_vibe_image_url_2','event_vibe_image_url_3'] LOOP
      EXECUTE format('SELECT ($1).%I, ($2).%I', field, field) INTO old_value, new_value USING OLD, NEW;
      -- A new image, not an admin putting back the one that was removed.
      IF new_value IS NOT NULL AND new_value IS DISTINCT FROM old_value AND NOT EXISTS (
           SELECT 1 FROM event_image_removal_refs ref
            WHERE ref.event_id=NEW.id AND ref.image_url=new_value
         ) THEN
        INSERT INTO event_admin_alerts (event_id, kind, dedupe_key)
        VALUES (NEW.id, 'image_replaced', new_value)
        ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS events_raise_admin_alerts ON events;
CREATE TRIGGER events_raise_admin_alerts
  AFTER INSERT OR UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION raise_event_admin_alerts();
