const { loadEventFollowerImpact } = require('./host-follows');
const { loadExternalTicketImpact } = require('./external-ticket-impact');
const { confirmedPrimaryGuestInviteSql, upcomingFamiliarInviteTargetSql } = require('./familiar-invitation-eligibility');

// The owner context has already been verified by the Manage API / recap job.
// Only aggregate values leave this helper. No emails, account IDs or click
// identifiers appear in the recap payload.
async function loadFamiliarFaceImpact(db, { eventId, organizerId }) {
  const { rows: [stats] } = await db.query(
    `WITH source AS (
       SELECT id,organizer_id FROM events WHERE id=$1 AND organizer_id=$2 AND status='published'
     ), eligible AS (
       SELECT r.id,r.user_id,LOWER(BTRIM(r.email)) AS email,r.created_at
         FROM rsvps r JOIN source ON source.id=r.event_id
        WHERE ${confirmedPrimaryGuestInviteSql('r', '$2')}
          AND BTRIM(r.email) ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'
     ), unique_people AS (
       SELECT DISTINCT ON (COALESCE('user:' || guest.user_id::text,'email:' || guest.email)) guest.email
         FROM eligible guest
        WHERE guest.user_id IS NOT NULL OR NOT EXISTS (
          SELECT 1 FROM eligible identified WHERE identified.email=guest.email AND identified.user_id IS NOT NULL
        )
        ORDER BY COALESCE('user:' || guest.user_id::text,'email:' || guest.email),guest.created_at DESC,guest.id DESC
     )
     SELECT (SELECT COUNT(DISTINCT email)::int FROM unique_people) AS familiar_faces,
            EXISTS (
              SELECT 1 FROM events target JOIN source ON source.organizer_id=target.organizer_id
               WHERE target.id<>source.id AND ${upcomingFamiliarInviteTargetSql('target')}
                 AND (target.event_date + target.start_time) AT TIME ZONE target.timezone > NOW()
            ) AS has_upcoming_invite_target`, [eventId, organizerId]
  );
  return { familiarFaces: stats.familiar_faces, hasUpcomingInviteTarget: stats.has_upcoming_invite_target };
}

async function loadPostEventImpact(db, { eventId, organizerId }) {
  const scope = { eventId, organizerId };
  const [followers, tickets, faces] = await Promise.all([
    loadEventFollowerImpact(db, scope),
    loadExternalTicketImpact(db, scope),
    loadFamiliarFaceImpact(db, scope)
  ]);
  return { ...followers, ...tickets, ...faces };
}

module.exports = { loadFamiliarFaceImpact, loadPostEventImpact };
