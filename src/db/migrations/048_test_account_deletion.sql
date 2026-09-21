-- A deleted account keeps only its numeric canonical user row so immutable
-- support history remains attributable and the ID can never be reused. All
-- usable identity, profile, and owned test property is removed by the
-- application transaction before this terminal state is written.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deletion_reason TEXT;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_status_check;
ALTER TABLE users ADD CONSTRAINT users_account_status_check
  CHECK (account_status IN ('active', 'suspended', 'deleted'));

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_suspension_state_check;
ALTER TABLE users ADD CONSTRAINT users_suspension_state_check CHECK (
  (account_status = 'active'
    AND suspended_at IS NULL
    AND suspended_by_user_id IS NULL
    AND suspension_reason IS NULL
    AND deleted_at IS NULL
    AND deleted_by_user_id IS NULL
    AND deletion_reason IS NULL)
  OR
  (account_status = 'suspended'
    AND suspended_at IS NOT NULL
    AND NULLIF(BTRIM(suspension_reason), '') IS NOT NULL
    AND deleted_at IS NULL
    AND deleted_by_user_id IS NULL
    AND deletion_reason IS NULL)
  OR
  (account_status = 'deleted'
    AND name IS NULL
    AND suspended_at IS NULL
    AND suspended_by_user_id IS NULL
    AND suspension_reason IS NULL
    AND deleted_at IS NOT NULL
    AND NULLIF(BTRIM(deletion_reason), '') IS NOT NULL)
);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_deletion_reason_length_check;
ALTER TABLE users ADD CONSTRAINT users_deletion_reason_length_check
  CHECK (deletion_reason IS NULL OR CHAR_LENGTH(BTRIM(deletion_reason)) BETWEEN 8 AND 500);

CREATE INDEX IF NOT EXISTS users_deleted_at_idx
  ON users (deleted_at DESC)
  WHERE account_status='deleted';

COMMENT ON COLUMN users.deleted_at IS
  'Terminal account-erasure timestamp. A deleted row is an audit-only tombstone and cannot authenticate.';
COMMENT ON COLUMN users.deleted_by_user_id IS
  'Administrator who permanently erased the account; nullable only if that administrator is later erased.';
COMMENT ON COLUMN users.deletion_reason IS
  'Permanent operator reason for erasing a confirmed test account.';
