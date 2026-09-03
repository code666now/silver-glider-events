-- Keep ticketing launch interest separate from RSVP updates, Host follows, and
-- general marketing consent. One organizer can opt in once and remove/rejoin.
CREATE TABLE IF NOT EXISTS commerce_feature_interests (
  id                    BIGSERIAL PRIMARY KEY,
  organizer_id          INT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  feature_key           TEXT NOT NULL DEFAULT 'commerce_ticketing'
                          CHECK (feature_key IN ('commerce_ticketing')),
  requested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at            TIMESTAMPTZ,
  launch_claimed_at     TIMESTAMPTZ,
  launch_sent_at        TIMESTAMPTZ,
  launch_provider_id    TEXT,
  launch_error          TEXT,
  CONSTRAINT commerce_feature_interests_organizer_feature_uq
    UNIQUE (organizer_id, feature_key)
);

CREATE INDEX IF NOT EXISTS commerce_feature_interests_active_idx
  ON commerce_feature_interests (feature_key, requested_at)
  WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS commerce_feature_interests_launch_idx
  ON commerce_feature_interests (feature_key, launch_sent_at)
  WHERE removed_at IS NULL;

COMMENT ON TABLE commerce_feature_interests IS
  'Explicit one-time launch-notification requests; separate from RSVP and Host-follow consent.';
