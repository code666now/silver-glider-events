const crypto = require('node:crypto');
const { hasUnlockCookie } = require('./secret-show');

const MIGRATION = '087_event_follow_attribution.sql';
const SECRET = (process.env.SESSION_SECRET || '').trim();

function signEventFollowSource(event) {
  if (event?.status !== 'published') return null;
  // This marker proves only the source of a follow. It is never accepted in
  // place of a sign-in, RSVP proof, or the Secret Show unlock cookie.
  const payload = JSON.stringify([
    'sge-event-follow-source-v1', event.id, event.organizer_id, event.slug, event.visibility,
    event.secret_show_enabled === true, event.secret_show_version
  ]);
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
}

function eventFollowSourceMatches(req, event, marker) {
  if (typeof marker !== 'string' || !/^[0-9a-f]{64}$/.test(marker)) return false;
  const expected = signEventFollowSource(event);
  if (!expected || !crypto.timingSafeEqual(Buffer.from(marker, 'hex'), Buffer.from(expected, 'hex'))) {
    return false;
  }
  if (!event.secret_show_enabled) return true;

  // A marker copied from a protected page cannot credit that event for a
  // locked visitor. A malformed optional cookie does not break a valid follow.
  try { return hasUnlockCookie(req, event); } catch (_) { return false; }
}

async function loadEventFollowerImpact(db, { eventId, organizerId }) {
  const { rows } = await db.query(
    `SELECT COUNT(DISTINCT COALESCE(hf.follower_user_id,hf.follower_organizer_id))::int AS active_followers,
            (COUNT(DISTINCT COALESCE(hf.follower_user_id,hf.follower_organizer_id))
              FILTER (WHERE hf.first_follow_event_id=e.id))::int AS new_followers,
            (SELECT applied_at FROM schema_migrations WHERE filename=$3) AS attribution_started_at
       FROM events e
       LEFT JOIN host_follows hf ON hf.host_organizer_id=e.organizer_id
         AND hf.unsubscribed_at IS NULL
      WHERE e.id=$1 AND e.organizer_id=$2
      GROUP BY e.id`,
    [eventId, organizerId, MIGRATION]
  );
  const row = rows[0];
  return {
    newFollowers: Number(row?.new_followers) || 0,
    activeFollowers: Number(row?.active_followers) || 0,
    attributionStartedAt: row?.attribution_started_at ? new Date(row.attribution_started_at).toISOString() : null
  };
}

module.exports = { eventFollowSourceMatches, loadEventFollowerImpact, signEventFollowSource };
