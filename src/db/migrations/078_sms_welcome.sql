-- Complimentary texting is a separately attributed part of the existing wallet.
-- Claims and aggregate usage survive account deletion; raw contact details do not.
ALTER TABLE organizers ADD COLUMN IF NOT EXISTS sms_welcome_credits INT NOT NULL DEFAULT 0
  CHECK (sms_welcome_credits >= 0 AND sms_welcome_credits <= 50);

CREATE TABLE IF NOT EXISTS sms_welcome_campaigns (
  campaign_key TEXT PRIMARY KEY,
  identity_hmac_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sms_welcome_claims (
  id BIGSERIAL PRIMARY KEY,
  campaign_key TEXT NOT NULL REFERENCES sms_welcome_campaigns(campaign_key),
  organizer_id INT REFERENCES organizers(id) ON DELETE SET NULL,
  account_key TEXT NOT NULL,
  email_key TEXT NOT NULL,
  phone_key TEXT NOT NULL,
  granted_credits INT NOT NULL DEFAULT 50 CHECK (granted_credits = 50),
  funded_credits INT NOT NULL DEFAULT 0 CHECK (funded_credits BETWEEN 0 AND 50),
  accepted_credits INT NOT NULL DEFAULT 0 CHECK (accepted_credits BETWEEN 0 AND 50),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_key, account_key),
  UNIQUE (campaign_key, email_key),
  UNIQUE (campaign_key, phone_key)
);
CREATE INDEX IF NOT EXISTS sms_welcome_claims_organizer_idx ON sms_welcome_claims(organizer_id);

ALTER TABLE sms_notification_batches
  ADD COLUMN IF NOT EXISTS welcome_credit_cost INT NOT NULL DEFAULT 0 CHECK (welcome_credit_cost >= 0),
  ADD COLUMN IF NOT EXISTS welcome_refunded_credits INT NOT NULL DEFAULT 0 CHECK (welcome_refunded_credits >= 0),
  ADD COLUMN IF NOT EXISTS welcome_claim_id BIGINT REFERENCES sms_welcome_claims(id);
ALTER TABLE sms_notification_recipients
  ADD COLUMN IF NOT EXISTS welcome_credits INT NOT NULL DEFAULT 0 CHECK (welcome_credits >= 0),
  ADD COLUMN IF NOT EXISTS welcome_accounted_at TIMESTAMPTZ;
