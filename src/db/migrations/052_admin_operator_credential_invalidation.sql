-- Changing an operator's enabled state is the security boundary. Enforce the
-- revocation in the database so direct SQL/admin tooling cannot leave a live
-- session, passcode challenge, or destructive-action proof behind.
CREATE OR REPLACE FUNCTION invalidate_admin_operator_credentials()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  invalidated_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  NEW.sessions_valid_after := GREATEST(NEW.sessions_valid_after, invalidated_at);
  NEW.updated_at := invalidated_at;

  UPDATE admin_auth_challenges
     SET used_at=invalidated_at
   WHERE operator_id=OLD.id AND used_at IS NULL;

  UPDATE admin_action_proofs
     SET consumed_at=invalidated_at
   WHERE operator_id=OLD.id AND consumed_at IS NULL;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS admin_operators_invalidate_credentials ON admin_operators;
CREATE TRIGGER admin_operators_invalidate_credentials
BEFORE UPDATE OF status ON admin_operators
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION invalidate_admin_operator_credentials();

COMMENT ON FUNCTION invalidate_admin_operator_credentials() IS
  'Revokes operator sessions, pending passcodes, and action proofs whenever active/disabled changes.';
