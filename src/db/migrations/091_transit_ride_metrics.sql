-- Aggregate unique interactions, not attendance. No route selection payload,
-- contact, network metadata or identities are stored in feature analytics.
CREATE TABLE transit_ride_totals (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  metric TEXT NOT NULL CHECK (metric IN ('page_open','route_selected','reminder_requested','reminder_sent',
    'email_link_open','text_link_open','repeat_open')),
  unique_count BIGINT NOT NULL CHECK (unique_count > 0),
  PRIMARY KEY (event_id, metric)
);

-- Short-lived, event-scoped HMACs prevent double counting without linking a
-- person's distinct events. A separate, unlinkable key enables repeat totals.
CREATE TABLE transit_ride_samples (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  metric TEXT NOT NULL CHECK (metric IN ('page_open','route_selected','reminder_requested','reminder_sent',
    'email_link_open','text_link_open')),
  subject_key TEXT NOT NULL CHECK (subject_key ~ '^[0-9a-f]{40}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (event_id, metric, subject_key)
);
CREATE INDEX transit_ride_samples_expiry ON transit_ride_samples (expires_at);

CREATE TABLE transit_ride_repeat_subjects (
  subject_key TEXT PRIMARY KEY CHECK (subject_key ~ '^[0-9a-f]{40}$'),
  first_event_key TEXT NOT NULL CHECK (first_event_key ~ '^[0-9a-f]{40}$'),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX transit_ride_repeat_subjects_expiry ON transit_ride_repeat_subjects (expires_at);
