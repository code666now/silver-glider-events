-- The app's production safety gate does not turn on the guest feature by
-- itself. A dedicated Super Admin explicitly opts in from Transportation.
CREATE TABLE transit_sf_rollout (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ,
  updated_by_admin_operator_id BIGINT REFERENCES admin_operators(id)
);

INSERT INTO transit_sf_rollout (singleton) VALUES (TRUE);
