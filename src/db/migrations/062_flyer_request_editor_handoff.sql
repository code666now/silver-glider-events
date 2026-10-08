-- Carry a reviewed flyer request into the existing scoped Done For You event
-- editor without widening the editor grant. The association is immutable and
-- is bound to the event created inside that workspace exactly once.
ALTER TABLE admin_event_editor_workspaces
  ADD COLUMN IF NOT EXISTS flyer_request_id BIGINT
    REFERENCES admin_flyer_requests(id);

CREATE UNIQUE INDEX IF NOT EXISTS admin_event_editor_workspaces_flyer_request_active_uq
  ON admin_event_editor_workspaces (flyer_request_id)
  WHERE status='active' AND flyer_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS admin_event_editor_workspaces_flyer_request_idx
  ON admin_event_editor_workspaces (flyer_request_id,created_at DESC)
  WHERE flyer_request_id IS NOT NULL;

-- Replace the original immutability trigger so the optional request scope is
-- protected by the same database-level boundary as client, owner, and event.
CREATE OR REPLACE FUNCTION reject_admin_editor_workspace_reassignment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.token_hash IS DISTINCT FROM NEW.token_hash
     OR OLD.done_for_you_client_id IS DISTINCT FROM NEW.done_for_you_client_id
     OR OLD.actor_admin_operator_id IS DISTINCT FROM NEW.actor_admin_operator_id
     OR OLD.target_user_id IS DISTINCT FROM NEW.target_user_id
     OR OLD.organizer_id IS DISTINCT FROM NEW.organizer_id
     OR OLD.flyer_request_id IS DISTINCT FROM NEW.flyer_request_id
     OR (OLD.event_id IS NOT NULL AND OLD.event_id IS DISTINCT FROM NEW.event_id) THEN
    RAISE EXCEPTION 'admin event editor workspace scope is immutable';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON COLUMN admin_event_editor_workspaces.flyer_request_id IS
  'Optional immutable flyer-intake request carried into this scoped editor workspace.';
