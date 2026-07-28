const crypto = require('crypto');
const pool = require('../config/db');
const { slugify } = require('./slug');

function cleanHostName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 100) || null;
}

function cleanHostBio(value) {
  return String(value ?? '').trim().replace(/\r\n?/g, '\n').slice(0, 500) || null;
}

function cleanHostSlug(value) {
  const slug = String(value ?? '').trim().toLowerCase();
  if (!slug) return { value: null, error: 'Enter a host page slug' };
  if (slug.length < 2 || slug.length > 70 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return { value: null, error: 'Use 2–70 lowercase letters, numbers, and single hyphens for the host slug' };
  }
  return { value: slug, error: null };
}

function cleanProfileUrl(value, label, { instagramOnly = false } = {}) {
  let raw = String(value ?? '').trim();
  if (!raw) return { value: null, error: null };
  if (raw.length > 500) return { value: null, error: `${label} URL is too long` };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
    if (!url.hostname || url.username || url.password) throw new Error('host');
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if (instagramOnly && hostname !== 'instagram.com') {
      return { value: null, error: 'Enter a valid Instagram profile URL' };
    }
    url.hash = '';
    return { value: url.toString(), error: null };
  } catch (_) {
    return { value: null, error: `Enter a valid ${label} URL` };
  }
}

function cleanContactEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!email) return { value: null, error: null };
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { value: null, error: 'Enter a valid contact email' };
  }
  return { value: email, error: null };
}

function normalizeHostProfile(body, current = {}) {
  const orgName = cleanHostName(body.org_name);
  if (current.public_slug && !orgName) {
    return { error: 'A public host page needs a host name' };
  }

  let publicSlug = current.public_slug || null;
  if (publicSlug && Object.prototype.hasOwnProperty.call(body, 'public_slug')) {
    const parsed = cleanHostSlug(body.public_slug);
    if (parsed.error) return { error: parsed.error };
    publicSlug = parsed.value;
  }

  const website = cleanProfileUrl(body.website_url, 'website');
  if (website.error) return { error: website.error };
  const instagram = cleanProfileUrl(body.instagram_url, 'Instagram', { instagramOnly: true });
  if (instagram.error) return { error: instagram.error };
  const contact = cleanContactEmail(body.contact_email);
  if (contact.error) return { error: contact.error };

  const hasProfileDetails = Boolean(cleanHostBio(body.bio) || website.value || instagram.value || contact.value);
  if (!orgName && hasProfileDetails) return { error: 'Add a public host name before adding host-page details' };

  return {
    value: {
      orgName,
      publicSlug,
      bio: cleanHostBio(body.bio),
      websiteUrl: website.value,
      instagramUrl: instagram.value,
      contactEmail: contact.value
    },
    error: null
  };
}

async function organizerWithHostProfile(organizerId) {
  const { rows } = await pool.query(
    `SELECT id, email, name, org_name, public_slug, logo_url, header_image_url,
            bio, website_url, instagram_url, contact_email,
            plan, is_admin, created_at, updated_at
       FROM organizers WHERE id=$1`,
    [organizerId]
  );
  return rows[0] || null;
}

async function ensureHostProfile(organizerId, hostName) {
  const cleanName = cleanHostName(hostName);
  if (!cleanName) return organizerWithHostProfile(organizerId);

  const current = await organizerWithHostProfile(organizerId);
  if (!current) return null;
  if (current.public_slug) return current;

  const base = slugify(cleanName) || 'host';
  for (let attempt = 0; attempt < 6; attempt++) {
    const suffix = attempt === 0 ? '' : `-${crypto.randomBytes(2).toString('hex')}`;
    try {
      const { rows } = await pool.query(
        `UPDATE organizers
            SET org_name=$2, public_slug=$3, updated_at=NOW()
          WHERE id=$1 AND public_slug IS NULL
          RETURNING id, email, name, org_name, public_slug, logo_url, header_image_url,
                    bio, website_url, instagram_url, contact_email,
                    plan, is_admin, created_at, updated_at`,
        [organizerId, cleanName, `${base}${suffix}`]
      );
      if (rows.length) return rows[0];
      return organizerWithHostProfile(organizerId);
    } catch (err) {
      if (err.code === '23505' && attempt < 5) continue;
      throw err;
    }
  }
  throw new Error('Could not create a unique host page');
}

module.exports = {
  cleanContactEmail,
  cleanHostBio,
  cleanHostName,
  cleanHostSlug,
  cleanProfileUrl,
  ensureHostProfile,
  normalizeHostProfile,
  organizerWithHostProfile
};
