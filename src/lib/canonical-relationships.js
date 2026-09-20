async function canonicalRelationshipReport(db) {
  const { rows } = await db.query(`
    WITH rsvp_candidates AS (
      SELECT rsvp.id,
             rsvp.user_id,
             account.user_id AS account_user_id,
             session.user_id AS session_user_id
        FROM rsvps rsvp
        LEFT JOIN organizers account ON account.id=rsvp.account_id
        LEFT JOIN guest_sessions session ON session.id=rsvp.guest_session_id
    ),
    message_candidates AS (
      SELECT message.id,
             message.recipient_user_id AS user_id,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT candidate.user_id),NULL) AS candidate_user_ids
        FROM message_log message
        LEFT JOIN LATERAL (
          SELECT rsvp.user_id FROM rsvps rsvp
           WHERE rsvp.id=message.rsvp_id AND rsvp.user_id IS NOT NULL
          UNION
          SELECT invitation.user_id FROM guest_invitation_tokens invitation
           WHERE invitation.message_log_id=message.id AND invitation.user_id IS NOT NULL
        ) candidate ON TRUE
       GROUP BY message.id,message.recipient_user_id
    )
    SELECT 'rsvps' AS relationship,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE user_id IS NOT NULL)::int AS linked,
           COUNT(*) FILTER (
             WHERE user_id IS NULL AND (account_user_id IS NOT NULL OR session_user_id IS NOT NULL)
           )::int AS exact_unlinked,
           COUNT(*) FILTER (
             WHERE user_id IS NOT NULL
               AND ((account_user_id IS NOT NULL AND account_user_id<>user_id)
                 OR (session_user_id IS NOT NULL AND session_user_id<>user_id))
           )::int AS mismatched,
           COUNT(*) FILTER (
             WHERE account_user_id IS NOT NULL AND session_user_id IS NOT NULL
               AND account_user_id<>session_user_id
           )::int AS ambiguous,
           COUNT(*) FILTER (
             WHERE EXISTS (
               SELECT 1
                 FROM canonical_user_link_conflicts conflict
                WHERE conflict.relationship_type='rsvp'
                  AND conflict.source_record_id=rsvp_candidates.id
                  AND conflict.reason='legacy_owner_mismatch'
                  AND conflict.resolved_at IS NULL
             )
           )::int AS quarantined
      FROM rsvp_candidates
    UNION ALL
    SELECT 'guest_sessions',COUNT(*)::int,
           COUNT(*) FILTER (WHERE session.user_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE session.user_id IS NULL AND organizer.user_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE session.user_id IS NOT NULL AND session.user_id<>organizer.user_id)::int,
           0,0
      FROM guest_sessions session
      JOIN organizers organizer ON organizer.id=session.identity_id
    UNION ALL
    SELECT 'guest_invitation_tokens',COUNT(*)::int,
           COUNT(*) FILTER (WHERE invitation.user_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE invitation.user_id IS NULL AND organizer.user_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE invitation.user_id IS NOT NULL AND invitation.user_id<>organizer.user_id)::int,
           0,0
      FROM guest_invitation_tokens invitation
      JOIN organizers organizer ON organizer.id=invitation.identity_id
    UNION ALL
    SELECT 'host_follows',COUNT(*)::int,
           COUNT(*) FILTER (WHERE follow.follower_user_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE follow.follower_user_id IS NULL AND organizer.user_id IS NOT NULL)::int,
           COUNT(*) FILTER (
             WHERE follow.follower_user_id IS NOT NULL AND follow.follower_user_id<>organizer.user_id
           )::int,
           0,0
      FROM host_follows follow
      JOIN organizers organizer ON organizer.id=follow.follower_organizer_id
    UNION ALL
    SELECT 'event_photos',COUNT(*)::int,
           COUNT(*) FILTER (WHERE uploader_user_id IS NOT NULL)::int,
           0,0,0,0
      FROM event_photos
    UNION ALL
    SELECT 'message_log',COUNT(*)::int,
           COUNT(*) FILTER (WHERE user_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE user_id IS NULL AND CARDINALITY(candidate_user_ids)>0)::int,
           COUNT(*) FILTER (
             WHERE user_id IS NOT NULL
               AND (CARDINALITY(candidate_user_ids)>1
                    OR (CARDINALITY(candidate_user_ids)>0
                        AND NOT user_id=ANY(candidate_user_ids)))
           )::int,
           COUNT(*) FILTER (WHERE CARDINALITY(candidate_user_ids)>1)::int,
           COUNT(*) FILTER (
             WHERE EXISTS (
               SELECT 1
                 FROM canonical_user_link_conflicts conflict
                WHERE conflict.relationship_type='message_log'
                  AND conflict.source_record_id=message_candidates.id
                  AND conflict.reason='legacy_owner_mismatch'
                  AND conflict.resolved_at IS NULL
             )
           )::int
      FROM message_candidates
    ORDER BY relationship
  `);

  return rows.map(row => ({
    relationship: row.relationship,
    total: Number(row.total),
    linked: Number(row.linked),
    exactUnlinked: Number(row.exact_unlinked),
    mismatched: Number(row.mismatched),
    ambiguous: Number(row.ambiguous),
    quarantined: Number(row.quarantined || 0)
  }));
}

function relationshipReportHasDrift(report) {
  return report.some(row => row.exactUnlinked > (row.quarantined || 0) || row.mismatched > 0);
}

module.exports = { canonicalRelationshipReport, relationshipReportHasDrift };
