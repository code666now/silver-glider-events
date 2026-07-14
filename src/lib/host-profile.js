const crypto = require('crypto');
const pool = require('../config/db');
const { slugify } = require('./slug');

function cleanHostName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 100) || null;
}

async function organizerWithHostProfile(organizerId) {
  const { rows } = await pool.query(
    'SELECT id, email, name, org_name, public_slug, logo_url, plan, is_admin, created_at FROM organizers WHERE id=$1',
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
            SET org_name=$2, public_slug=$3
          WHERE id=$1 AND public_slug IS NULL
          RETURNING id, email, name, org_name, public_slug, logo_url, plan, is_admin, created_at`,
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

module.exports = { cleanHostName, ensureHostProfile, organizerWithHostProfile };
