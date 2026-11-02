-- Optional return-to-hosting messages are prospective and explicitly opt-in.
-- The legacy recap timestamp is a delivery claim, not proof of provider acceptance.
-- Never backfill delivered_at from that claim or enroll historical recaps.
ALTER TABLE events ADD COLUMN IF NOT EXISTS host_recap_delivered_at TIMESTAMPTZ;

ALTER TABLE email_optouts DROP CONSTRAINT IF EXISTS email_optouts_scope_check;
ALTER TABLE email_optouts ADD CONSTRAINT email_optouts_scope_check
  CHECK (scope IN ('host_recaps', 'product_updates', 'host_onboarding', 'host_followups'));

CREATE TABLE IF NOT EXISTS email_optins (
  email TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope = 'host_followups'),
  consent_version TEXT NOT NULL,
  consent_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (email, scope),
  CHECK (email = LOWER(TRIM(email)))
);

CREATE TABLE IF NOT EXISTS host_event_follow_ups (
  event_id INT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  organizer_id INT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','suppressed','failed')),
  recipient TEXT NOT NULL,
  render_snapshot JSONB NOT NULL,
  attempt_count INT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  first_attempt_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  provider_id TEXT,
  sent_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS host_event_follow_ups_host_frequency_idx
  ON host_event_follow_ups (organizer_id, first_attempt_at DESC);

CREATE INDEX IF NOT EXISTS events_host_follow_up_due_idx
  ON events (host_recap_delivered_at)
  WHERE host_recap_delivered_at IS NOT NULL AND status='published';

COMMENT ON COLUMN events.host_recap_delivered_at IS
  'Provider acceptance of a newly sent recap. No historical backfill; anchors optional host follow-ups.';
