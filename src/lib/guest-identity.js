async function ensureGuestIdentity(db, { email, displayName }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const name = String(displayName || '').trim().replace(/\s+/g, ' ').slice(0, 160) || null;
  if (!normalizedEmail) throw new Error('Guest identity requires an email');

  let identity = (await db.query(
    'SELECT id, email, name FROM organizers WHERE LOWER(email)=LOWER($1) LIMIT 1',
    [normalizedEmail]
  )).rows[0];
  if (identity) return identity;

  const inserted = await db.query(
    `INSERT INTO organizers (email, name)
     VALUES ($1,$2)
     ON CONFLICT DO NOTHING
     RETURNING id, email, name`,
    [normalizedEmail, name]
  );
  identity = inserted.rows[0] || (await db.query(
    'SELECT id, email, name FROM organizers WHERE LOWER(email)=LOWER($1) LIMIT 1',
    [normalizedEmail]
  )).rows[0];
  if (!identity) throw new Error('Could not create guest identity');
  return identity;
}

module.exports = { ensureGuestIdentity };
