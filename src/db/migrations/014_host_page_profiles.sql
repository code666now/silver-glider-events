-- Public host-page foundation: optional branding, biography, and contact links.
-- Existing org_name/public_slug/logo_url/created_at columns remain the source
-- of truth for host name, slug, logo, and creation date.
ALTER TABLE organizers
  ADD COLUMN IF NOT EXISTS header_image_url TEXT,
  ADD COLUMN IF NOT EXISTS bio TEXT,
  ADD COLUMN IF NOT EXISTS website_url TEXT,
  ADD COLUMN IF NOT EXISTS instagram_url TEXT,
  ADD COLUMN IF NOT EXISTS contact_email TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
