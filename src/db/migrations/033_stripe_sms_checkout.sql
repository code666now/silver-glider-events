-- Stripe-hosted Checkout reuses the existing host wallet and immutable ledger.
-- PayPal remains valid for historical purchases, refunds, and rollback.
ALTER TABLE sms_credit_purchases
  DROP CONSTRAINT IF EXISTS sms_credit_purchases_provider_check;
ALTER TABLE sms_credit_purchases
  ADD CONSTRAINT sms_credit_purchases_provider_check
  CHECK (provider IN ('paypal','stripe'));

ALTER TABLE sms_credit_transactions
  DROP CONSTRAINT IF EXISTS sms_credit_transactions_provider_check;
ALTER TABLE sms_credit_transactions
  ADD CONSTRAINT sms_credit_transactions_provider_check
  CHECK (provider IS NULL OR provider IN ('paypal','stripe'));

CREATE TABLE IF NOT EXISTS stripe_sms_webhook_events (
  id            TEXT PRIMARY KEY,
  event_type    TEXT NOT NULL,
  resource_id   TEXT,
  status        TEXT NOT NULL DEFAULT 'processing'
                  CHECK (status IN ('processing','processed','ignored','failed')),
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ
);
