-- Migration 044 could encounter a legacy message with two exact owners: its
-- RSVP and its personal invitation. Reconcile those candidates without ever
-- choosing between different canonical users.
ALTER TABLE canonical_user_link_conflicts
  DROP CONSTRAINT IF EXISTS canonical_user_link_conflicts_relationship_check;
ALTER TABLE canonical_user_link_conflicts
  ADD CONSTRAINT canonical_user_link_conflicts_relationship_check
  CHECK (relationship_type IN ('rsvp','message_log'));

WITH candidates AS (
  SELECT message.id,
         ARRAY(
           SELECT DISTINCT candidate_user_id
             FROM UNNEST(ARRAY[
               message.recipient_user_id,
               rsvp.user_id,
               invitation.user_id
             ]) candidate_user_id
            WHERE candidate_user_id IS NOT NULL
            ORDER BY candidate_user_id
         ) AS user_ids
    FROM message_log message
    LEFT JOIN rsvps rsvp ON rsvp.id=message.rsvp_id
    LEFT JOIN guest_invitation_tokens invitation ON invitation.message_log_id=message.id
)
INSERT INTO canonical_user_link_conflicts (
  relationship_type,
  source_record_id,
  first_candidate_user_id,
  second_candidate_user_id,
  reason
)
SELECT 'message_log',id,user_ids[1],user_ids[2],'legacy_owner_mismatch'
  FROM candidates
 WHERE CARDINALITY(user_ids)>1
ON CONFLICT DO NOTHING;

WITH candidates AS (
  SELECT message.id,
         ARRAY(
           SELECT DISTINCT candidate_user_id
             FROM UNNEST(ARRAY[
               message.recipient_user_id,
               rsvp.user_id,
               invitation.user_id
             ]) candidate_user_id
            WHERE candidate_user_id IS NOT NULL
            ORDER BY candidate_user_id
         ) AS user_ids
    FROM message_log message
    LEFT JOIN rsvps rsvp ON rsvp.id=message.rsvp_id
    LEFT JOIN guest_invitation_tokens invitation ON invitation.message_log_id=message.id
)
UPDATE message_log message
   SET recipient_user_id = CASE
         WHEN CARDINALITY(candidate.user_ids)=1 THEN candidate.user_ids[1]
         ELSE NULL
       END
  FROM candidates candidate
 WHERE message.id=candidate.id
   AND CARDINALITY(candidate.user_ids)>0;

COMMENT ON TABLE canonical_user_link_conflicts IS
  'Exact legacy-owner disagreements quarantined for review; no canonical user is selected automatically.';
