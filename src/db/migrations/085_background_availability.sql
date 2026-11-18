-- Availability controls new selections only. Event keys and assets stay intact.
CREATE TABLE IF NOT EXISTS event_background_availability (
  background_key TEXT PRIMARY KEY,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_admin_operator_id BIGINT REFERENCES admin_operators(id) ON DELETE SET NULL,
  CONSTRAINT event_background_key_check
    CHECK (background_key ~ '^[a-z][a-z0-9-]{0,59}$'),
  CONSTRAINT event_background_defaults_active_check
    CHECK (background_key NOT IN ('adaptive', 'midnight', 'plaster') OR active)
);

INSERT INTO event_background_availability (background_key)
VALUES ('adaptive'), ('midnight'), ('aurora'), ('sunset'), ('ocean'), ('plaster'),
       ('halloween'), ('last-guest'), ('disco'), ('fog'), ('paper'), ('static'),
       ('liquid-stardust'), ('color-static'), ('saloon'), ('golden-tide'),
       ('rain-on-glass'), ('gather-and-glow'), ('candlelit-christmas'),
       ('snow-day'), ('midnight-toast'), ('starlit-celebration')
ON CONFLICT (background_key) DO NOTHING;

COMMENT ON TABLE event_background_availability IS
  'Curated picker availability only; inactive backgrounds remain valid on saved and duplicated events.';
