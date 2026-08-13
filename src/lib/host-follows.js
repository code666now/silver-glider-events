async function findPublicHost(db, slug) {
  const value = String(slug || '').trim();
  if (!value) return null;
  const { rows } = await db.query(
    `SELECT id, org_name, public_slug, logo_url, header_image_url
       FROM organizers
      WHERE LOWER(public_slug)=LOWER($1)
        AND org_name IS NOT NULL
        AND public_slug IS NOT NULL`,
    [value]
  );
  return rows[0] || null;
}

async function followHost(db, followerOrganizerId, hostOrganizerId, sourceEventId = null) {
  if (Number(followerOrganizerId) === Number(hostOrganizerId)) {
    const err = new Error('You cannot follow your own Host Page');
    err.statusCode = 400;
    throw err;
  }
  const { rows } = await db.query(
    `INSERT INTO host_follows
       (follower_organizer_id, host_organizer_id, source_event_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (follower_organizer_id, host_organizer_id)
     DO UPDATE SET unsubscribed_at=NULL,
                   source_event_id=COALESCE(host_follows.source_event_id, EXCLUDED.source_event_id),
                   updated_at=NOW()
     RETURNING id, created_at, unsubscribed_at`,
    [followerOrganizerId, hostOrganizerId, sourceEventId]
  );
  return rows[0];
}

async function unfollowHost(db, followerOrganizerId, hostOrganizerId) {
  const { rowCount } = await db.query(
    `UPDATE host_follows
        SET unsubscribed_at=COALESCE(unsubscribed_at,NOW()), updated_at=NOW()
      WHERE follower_organizer_id=$1 AND host_organizer_id=$2`,
    [followerOrganizerId, hostOrganizerId]
  );
  return rowCount > 0;
}

async function isFollowingHost(db, followerOrganizerId, hostOrganizerId) {
  if (!followerOrganizerId || Number(followerOrganizerId) === Number(hostOrganizerId)) return false;
  const { rows } = await db.query(
    `SELECT 1 FROM host_follows
      WHERE follower_organizer_id=$1 AND host_organizer_id=$2
        AND unsubscribed_at IS NULL`,
    [followerOrganizerId, hostOrganizerId]
  );
  return rows.length > 0;
}

module.exports = { findPublicHost, followHost, unfollowHost, isFollowingHost };
