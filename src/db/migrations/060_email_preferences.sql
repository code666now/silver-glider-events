-- Optional email categories are suppressed independently. Essential security,
-- RSVP confirmations, and critical event changes never consult this table.
CREATE TABLE IF NOT EXISTS email_optouts (
  email      TEXT NOT NULL,
  scope      TEXT NOT NULL CHECK (scope IN ('host_recaps', 'product_updates')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (email, scope),
  CHECK (email = LOWER(TRIM(email)))
);

CREATE INDEX IF NOT EXISTS email_optouts_scope_idx ON email_optouts (scope);
