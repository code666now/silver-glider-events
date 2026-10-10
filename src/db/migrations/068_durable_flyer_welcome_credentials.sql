-- A provider can accept a welcome email and still time out before returning a
-- response. Retain the exact prepared claim credential and rendered payload so
-- the durable worker retries the same provider-idempotent message instead of
-- revoking the link the promoter may already have received.
ALTER TABLE admin_done_for_you_welcome_deliveries
  ADD COLUMN IF NOT EXISTS claim_token_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS delivery_payload JSONB;

ALTER TABLE admin_done_for_you_welcome_deliveries
  DROP CONSTRAINT IF EXISTS admin_done_for_you_welcome_secret_length_check,
  DROP CONSTRAINT IF EXISTS admin_done_for_you_welcome_payload_check,
  DROP CONSTRAINT IF EXISTS admin_done_for_you_welcome_prepared_pair_check;

ALTER TABLE admin_done_for_you_welcome_deliveries
  ADD CONSTRAINT admin_done_for_you_welcome_secret_length_check
    CHECK (claim_token_encrypted IS NULL OR
           CHAR_LENGTH(claim_token_encrypted) BETWEEN 20 AND 2000),
  ADD CONSTRAINT admin_done_for_you_welcome_payload_check
    CHECK (delivery_payload IS NULL OR (
      JSONB_TYPEOF(delivery_payload)='object' AND
      NOT (delivery_payload ? 'link') AND
      NOT (delivery_payload ? 'token')
    )),
  ADD CONSTRAINT admin_done_for_you_welcome_prepared_pair_check
    CHECK (
      (claim_token_encrypted IS NULL AND delivery_payload IS NULL)
      OR
      (claim_token_encrypted IS NOT NULL AND delivery_payload IS NOT NULL AND
       invitation_id IS NOT NULL)
    );

COMMENT ON COLUMN admin_done_for_you_welcome_deliveries.claim_token_encrypted IS
  'AES-GCM sealed one-time claim credential retained only for idempotent welcome retries.';
COMMENT ON COLUMN admin_done_for_you_welcome_deliveries.delivery_payload IS
  'Non-secret new-account welcome fields reused with a stable provider key; the sealed link is stored separately.';
