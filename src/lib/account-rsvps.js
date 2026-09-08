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

async function linkOwnedRsvpForEvent(db, accountId, email, eventId, manageToken) {
  const id = Number(accountId);
  const scopedEventId = Number(eventId);
  const verifiedEmail = String(email || '').trim().toLowerCase();
  const attendeeToken = String(manageToken || '').trim();
  if (!Number.isInteger(id) || id < 1 ||
      !Number.isInteger(scopedEventId) || scopedEventId < 1 ||
      (!verifiedEmail && !attendeeToken)) return 0;
  const { rowCount } = await db.query(
    `UPDATE rsvps
        SET account_id=$1
      WHERE event_id=$2 AND account_id IS NULL
        AND (LOWER(email)=LOWER($3) OR ($4 <> '' AND manage_token=$4))`,
    [id, scopedEventId, verifiedEmail, attendeeToken]
  );
  return rowCount;
}

module.exports = { linkVerifiedRsvps, linkOwnedRsvpForEvent };
