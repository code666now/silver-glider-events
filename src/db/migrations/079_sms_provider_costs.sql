-- Only newly created controlled templates promise one text / one credit.
-- Leave existing queued messages and their version NULL; never rewrite them.
ALTER TABLE sms_notification_batches ADD COLUMN IF NOT EXISTS template_version TEXT;
ALTER TABLE sms_notification_recipients
  ADD COLUMN IF NOT EXISTS provider_price NUMERIC(18,8),
  ADD COLUMN IF NOT EXISTS provider_price_unit TEXT,
  ADD COLUMN IF NOT EXISTS provider_num_segments INT,
  ADD COLUMN IF NOT EXISTS provider_price_checked_at TIMESTAMPTZ;

-- Durable, non-PII cost facts survive event/account deletion. The provider SID
-- prevents retries/callbacks from double-counting a charge. Missing prices stay
-- NULL (pending), never zero. Store the provider's signed decimal unchanged.
CREATE TABLE IF NOT EXISTS sms_provider_cost_facts (
  id BIGSERIAL PRIMARY KEY,
  provider_message_sid TEXT UNIQUE CHECK (provider_message_sid IS NULL OR provider_message_sid ~ '^(SM|MM)[0-9a-fA-F]{32}$'),
  -- Intentionally not a FK: an attempt and its unknown charge survive deletion.
  source_recipient_id BIGINT,
  notification_recipient_id BIGINT REFERENCES sms_notification_recipients(id) ON DELETE SET NULL,
  welcome_claim_id BIGINT REFERENCES sms_welcome_claims(id) ON DELETE SET NULL,
  welcome_credits INT NOT NULL CHECK (welcome_credits > 0),
  acceptance_state TEXT NOT NULL DEFAULT 'accepted' CHECK (acceptance_state IN ('pending','accepted','unknown','not_sent')),
  provider_price NUMERIC(18,8),
  price_unit TEXT CHECK (price_unit IS NULL OR price_unit ~ '^[A-Z]{3}$'),
  provider_segments INT CHECK (provider_segments IS NULL OR provider_segments > 0),
  accepted_at TIMESTAMPTZ DEFAULT NOW(),
  price_checked_at TIMESTAMPTZ,
  price_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Keep the migration safely re-runnable in the dedicated local test database.
ALTER TABLE sms_provider_cost_facts
  ALTER COLUMN provider_message_sid DROP NOT NULL,
  ALTER COLUMN accepted_at DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS source_recipient_id BIGINT,
  ADD COLUMN IF NOT EXISTS acceptance_state TEXT NOT NULL DEFAULT 'accepted'
    CHECK (acceptance_state IN ('pending','accepted','unknown','not_sent'));
CREATE UNIQUE INDEX IF NOT EXISTS sms_provider_cost_source_recipient_idx
  ON sms_provider_cost_facts (source_recipient_id);

CREATE INDEX IF NOT EXISTS sms_provider_cost_pending_idx
  ON sms_provider_cost_facts (price_checked_at NULLS FIRST,id)
  WHERE provider_message_sid IS NOT NULL AND (provider_price IS NULL OR price_unit IS NULL OR provider_segments IS NULL);
