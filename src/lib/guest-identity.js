const { resolveOrCreateOrganizerByEmail } = require('./canonical-identity');

async function ensureGuestIdentity(db, { email, displayName }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const name = String(displayName || '').trim().replace(/\s+/g, ' ').slice(0, 160) || null;
  if (!normalizedEmail) throw new Error('Guest identity requires an email');

  const resolved = await resolveOrCreateOrganizerByEmail(db, {
    email: normalizedEmail,
    name
  });
  return resolved.organizer;
}

module.exports = { ensureGuestIdentity };
