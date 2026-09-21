-- A permanent deletion may run only after an administrator has deliberately
-- designated the canonical user as disposable test data. The designation is
-- durable and audited by the application; it cannot be supplied only by the
-- destructive request itself.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_test_account BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS test_account_marked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS test_account_marked_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS test_account_mark_reason TEXT;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_test_account_state_check;
ALTER TABLE users ADD CONSTRAINT users_test_account_state_check CHECK (
  (is_test_account = FALSE
    AND test_account_marked_at IS NULL
    AND test_account_marked_by_user_id IS NULL
    AND test_account_mark_reason IS NULL)
  OR
  (is_test_account = TRUE
    AND test_account_marked_at IS NOT NULL
    AND test_account_marked_by_user_id IS NOT NULL
    AND CHAR_LENGTH(BTRIM(test_account_mark_reason)) BETWEEN 8 AND 500)
);

COMMENT ON COLUMN users.is_test_account IS
  'Durable administrator designation required before the guarded test-account deletion command can run.';

-- Managed media deletion is an outbox, committed atomically with account
-- erasure. A retry worker removes the remote object after commit, so a
-- temporary Cloudinary outage cannot make the cleanup disappear silently.
CREATE TABLE IF NOT EXISTS managed_media_deletion_jobs (
  id              BIGSERIAL PRIMARY KEY,
  public_id       TEXT NOT NULL,
  source_kind     TEXT NOT NULL CHECK (source_kind IN ('test_account_deletion')),
  source_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','completed')),
  attempt_count   INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT managed_media_deletion_jobs_public_id_check
    CHECK (NULLIF(BTRIM(public_id), '') IS NOT NULL),
  CONSTRAINT managed_media_deletion_jobs_source_uq
    UNIQUE (source_kind, source_user_id, public_id)
);

CREATE INDEX IF NOT EXISTS managed_media_deletion_jobs_pending_idx
  ON managed_media_deletion_jobs (next_attempt_at, id)
  WHERE status IN ('pending','processing');

COMMENT ON TABLE managed_media_deletion_jobs IS
  'Durable outbox for managed Cloudinary objects whose database owners have been permanently erased.';
