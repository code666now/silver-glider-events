-- SMS credits belong to the host account. Purchases and immutable ledger
-- entries stay separate so payment retries, refunds, and future sends remain
-- auditable without treating PayPal as the source of account balance.
ALTER TABLE organizers
  ADD COLUMN IF NOT EXISTS sms_credits INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sms_credit_purchases (
  id                    BIGSERIAL PRIMARY KEY,
  reference             TEXT NOT NULL UNIQUE,
  organizer_id          INT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  pack_key              TEXT NOT NULL CHECK (pack_key IN ('starter','standard','pro')),
  credits               INT NOT NULL CHECK (credits > 0),
  amount_cents          INT NOT NULL CHECK (amount_cents > 0),
  currency              TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  provider              TEXT NOT NULL DEFAULT 'paypal' CHECK (provider = 'paypal'),
  provider_order_id     TEXT UNIQUE,
  provider_capture_id   TEXT UNIQUE,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','completed','partially_refunded','refunded','reversed','failed')),
  refunded_cents        INT NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0 AND refunded_cents <= amount_cents),
  refunded_credits      INT NOT NULL DEFAULT 0 CHECK (refunded_credits >= 0 AND refunded_credits <= credits),
  failure_code          TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sms_credit_purchases_organizer_idx
  ON sms_credit_purchases (organizer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sms_credit_transactions (
  id                      BIGSERIAL PRIMARY KEY,
  organizer_id            INT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  purchase_id             BIGINT REFERENCES sms_credit_purchases(id) ON DELETE CASCADE,
  kind                    TEXT NOT NULL CHECK (kind IN ('purchase','refund','reversal','send','adjustment')),
  credits_delta           INT NOT NULL,
  balance_after           INT NOT NULL,
  amount_cents_delta      INT,
  currency                TEXT CHECK (currency IS NULL OR currency = 'USD'),
  provider                TEXT CHECK (provider IS NULL OR provider = 'paypal'),
  provider_transaction_id TEXT,
  external_key            TEXT UNIQUE,
  metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (credits_delta <> 0 OR COALESCE(amount_cents_delta,0) <> 0)
);

CREATE INDEX IF NOT EXISTS sms_credit_transactions_organizer_idx
  ON sms_credit_transactions (organizer_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS paypal_webhook_events (
  id            TEXT PRIMARY KEY,
  event_type    TEXT NOT NULL,
  resource_id   TEXT,
  status        TEXT NOT NULL DEFAULT 'processing'
                  CHECK (status IN ('processing','processed','ignored','failed')),
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ
);
