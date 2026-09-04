async function linkVerifiedRsvps(db, accountId, email) {
  const id = Number(accountId);
  const verifiedEmail = String(email || '').trim().toLowerCase();
  if (!Number.isInteger(id) || id < 1 || !verifiedEmail) return 0;
  const { rowCount } = await db.query(
    `UPDATE rsvps
        SET account_id=$1
      WHERE account_id IS NULL AND LOWER(email)=LOWER($2)`,
    [id, verifiedEmail]
  );
  return rowCount;
}

module.exports = { linkVerifiedRsvps };
