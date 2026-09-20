async function linkVerifiedRsvps(db, accountId, email) {
  const id = Number(accountId);
  const verifiedEmail = String(email || '').trim().toLowerCase();
  if (!Number.isInteger(id) || id < 1 || !verifiedEmail) return 0;
  await db.query(
    `INSERT INTO canonical_user_link_conflicts
       (relationship_type,source_record_id,first_candidate_user_id,second_candidate_user_id,reason)
     SELECT 'rsvp',rsvp.id,rsvp.user_id,account.user_id,'legacy_owner_mismatch'
       FROM rsvps rsvp
       JOIN organizers account ON account.id=$1
      WHERE (rsvp.account_id IS NULL OR rsvp.account_id=$1)
        AND LOWER(rsvp.email)=LOWER($2)
        AND rsvp.user_id IS NOT NULL AND account.user_id IS NOT NULL
        AND rsvp.user_id<>account.user_id
     ON CONFLICT DO NOTHING`,
    [id, verifiedEmail]
  );
  const { rowCount } = await db.query(
    `UPDATE rsvps
        SET account_id=COALESCE(account_id,$1),
            user_id=COALESCE(user_id,(SELECT user_id FROM organizers WHERE id=$1))
      WHERE (account_id IS NULL OR account_id=$1)
        AND LOWER(email)=LOWER($2)
        AND (user_id IS NULL OR user_id=(SELECT user_id FROM organizers WHERE id=$1))
        AND (account_id IS NULL OR user_id IS NULL)`,
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
  await db.query(
    `INSERT INTO canonical_user_link_conflicts
       (relationship_type,source_record_id,first_candidate_user_id,second_candidate_user_id,reason)
     SELECT 'rsvp',rsvp.id,rsvp.user_id,account.user_id,'legacy_owner_mismatch'
       FROM rsvps rsvp
       JOIN organizers account ON account.id=$1
      WHERE rsvp.event_id=$2 AND (rsvp.account_id IS NULL OR rsvp.account_id=$1)
        AND (LOWER(rsvp.email)=LOWER($3) OR ($4 <> '' AND rsvp.manage_token=$4))
        AND rsvp.user_id IS NOT NULL AND account.user_id IS NOT NULL
        AND rsvp.user_id<>account.user_id
     ON CONFLICT DO NOTHING`,
    [id, scopedEventId, verifiedEmail, attendeeToken]
  );
  const { rowCount } = await db.query(
    `UPDATE rsvps
        SET account_id=COALESCE(account_id,$1),
            user_id=COALESCE(user_id,(SELECT user_id FROM organizers WHERE id=$1))
      WHERE event_id=$2 AND (account_id IS NULL OR account_id=$1)
        AND (LOWER(email)=LOWER($3) OR ($4 <> '' AND manage_token=$4))
        AND (user_id IS NULL OR user_id=(SELECT user_id FROM organizers WHERE id=$1))
        AND (account_id IS NULL OR user_id IS NULL)`,
    [id, scopedEventId, verifiedEmail, attendeeToken]
  );
  return rowCount;
}

module.exports = { linkVerifiedRsvps, linkOwnedRsvpForEvent };
