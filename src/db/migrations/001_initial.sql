CREATE TABLE IF NOT EXISTS organizers (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL,
  name          TEXT,
  org_name      TEXT,
  plan          TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro')),
  sms_credits   INT  NOT NULL DEFAULT 0,
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS organizers_email_uq ON organizers (LOWER(email));

CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id         SERIAL PRIMARY KEY,
  token      TEXT UNIQUE NOT NULL,
  email      TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS magic_link_tokens_email_idx ON magic_link_tokens (LOWER(email));

CREATE TABLE IF NOT EXISTS events (
  id                 SERIAL PRIMARY KEY,
  organizer_id       INT NOT NULL REFERENCES organizers(id),
  slug               TEXT UNIQUE NOT NULL,
  title              TEXT NOT NULL,
  description        TEXT,
  cover_image_url    TEXT,
  event_date         DATE NOT NULL,
  start_time         TIME NOT NULL,
  end_time           TIME,
  timezone           TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  venue_name         TEXT NOT NULL,
  venue_address      TEXT,
  category           TEXT,
  capacity           INT,
  visibility         TEXT NOT NULL DEFAULT 'public'    CHECK (visibility IN ('public','private')),
  admission_type     TEXT NOT NULL DEFAULT 'free_rsvp' CHECK (admission_type IN ('free_rsvp','paid','donation','door','vip')),
  status             TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','cancelled')),
  duplicated_from_id INT REFERENCES events(id),
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS events_organizer_idx ON events (organizer_id);
CREATE INDEX IF NOT EXISTS events_date_idx      ON events (event_date);

CREATE TABLE IF NOT EXISTS rsvps (
  id               SERIAL PRIMARY KEY,
  event_id         INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  first_name       TEXT NOT NULL,
  last_name        TEXT NOT NULL,
  email            TEXT NOT NULL,
  phone            TEXT,
  wants_reminders  BOOLEAN NOT NULL DEFAULT TRUE,
  organizer_optin  BOOLEAN NOT NULL DEFAULT FALSE,
  status           TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
  manage_token     TEXT UNIQUE NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS rsvps_event_email_uq ON rsvps (event_id, LOWER(email));

CREATE TABLE IF NOT EXISTS message_log (
  id           SERIAL PRIMARY KEY,
  rsvp_id      INT REFERENCES rsvps(id)  ON DELETE CASCADE,
  event_id     INT REFERENCES events(id) ON DELETE CASCADE,
  recipient    TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN
    ('magic_link','rsvp_confirmation','reminder_day_before','reminder_day_of')),
  channel      TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','sms')),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  provider_id  TEXT,
  error        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  sent_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS message_log_dedupe_uq
  ON message_log (rsvp_id, message_type, channel) WHERE rsvp_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS line_submissions (
  id           SERIAL PRIMARY KEY,
  event_id     INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  organizer_id INT NOT NULL REFERENCES organizers(id),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  note         TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS line_submissions_event_uq ON line_submissions (event_id);
