-- Reconcile the short-lived test-only gate into the general Super Admin
-- account-deletion/anonymization flow. Keep the legacy test-account columns
-- and their constraint during the rolling deploy so an older application instance can
-- continue to read and write them safely. The direct deletion command does
-- not depend on that designation.
COMMENT ON COLUMN users.is_test_account IS
  'Legacy administrator test-account designation retained for rolling-deploy compatibility; general account deletion does not require it.';

COMMENT ON COLUMN users.deletion_reason IS
  'Permanent operator reason for deleting and anonymizing an account.';

-- Keep the durable media outbox compatible with both the former test-only
-- command and the general account-deletion command during a rolling deploy.
-- Jobs remain retryable after the database commit.
ALTER TABLE managed_media_deletion_jobs
  DROP CONSTRAINT IF EXISTS managed_media_deletion_jobs_source_kind_check;

ALTER TABLE managed_media_deletion_jobs
  ADD CONSTRAINT managed_media_deletion_jobs_source_kind_check
  CHECK (source_kind IN ('test_account_deletion','account_deletion'));

COMMENT ON TABLE managed_media_deletion_jobs IS
  'Durable outbox for managed Cloudinary objects removed during permanent account deletion.';
