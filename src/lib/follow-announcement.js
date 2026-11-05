const { reserveSendCreditsDetailed } = require('./sms-credit-ledger');
const { isWelcomeSmsDestination } = require('./sms-welcome');
const {
  FOLLOW_EMAIL_CONSENT_VERSION,
  CONTRIBUTOR_EMAIL_CONSENT_SOURCE,
  CONTRIBUTOR_EMAIL_CONSENT_VERSION,
  FOLLOW_SMS_CONSENT_VERSION
} = require('./follow-consent');
const {
  SINGLE_SEGMENT_TEMPLATE_VERSION, assertSingleSegmentMessage,
  buildFollowerAnnouncementMessage, previewFingerprint
} = require('./sms-lifecycle');

async function eligibleEmailRecipients(queryable, organizerId, eventId) {
  const { rows } = await queryable.query(
    `WITH candidates AS (
       SELECT r.user_id,LOWER(r.email) AS email,MIN(r.first_name) AS first_name,
              1 AS source_rank,MAX(r.created_at) AS consent_at
         FROM rsvps r JOIN events source_event ON source_event.id=r.event_id
        WHERE source_event.organizer_id=$1 AND r.organizer_optin=TRUE AND r.status='confirmed'
        GROUP BY r.user_id,LOWER(r.email)
       UNION ALL
       SELECT hf.follower_user_id AS user_id,LOWER(follower.email) AS email,
              MIN(COALESCE(NULLIF(SPLIT_PART(follower.name,' ',1),''),'Friend')) AS first_name,
              0 AS source_rank,MAX(hf.email_opted_in_at) AS consent_at
         FROM host_follows hf JOIN organizers follower ON follower.id=hf.follower_organizer_id
        WHERE hf.host_organizer_id=$1 AND hf.unsubscribed_at IS NULL
          AND hf.email_opted_in_at IS NOT NULL
          AND (hf.email_consent_version=$3
               OR (hf.email_consent_source=$4 AND hf.email_consent_version=$5))
        GROUP BY hf.follower_user_id,LOWER(follower.email)
     ), ranked AS (
       SELECT candidate.*,
              ROW_NUMBER() OVER (
                PARTITION BY COALESCE('user:' || candidate.user_id::text,'email:' || candidate.email)
                ORDER BY candidate.source_rank,candidate.consent_at DESC,candidate.email
              ) AS person_rank
         FROM candidates candidate
     )
     SELECT c.email,c.first_name,c.user_id,
            COALESCE('user:' || c.user_id::text,'email:' || c.email) AS person_key
       FROM ranked c
      WHERE c.person_rank=1
        AND NOT EXISTS (
              SELECT 1 FROM follower_optouts fo
               WHERE fo.organizer_id=$1 AND LOWER(fo.email)=c.email
            )
        AND NOT EXISTS (
              SELECT 1 FROM rsvps target
               WHERE target.event_id=$2 AND target.status='confirmed'
                 AND ((c.user_id IS NOT NULL AND target.user_id=c.user_id)
                      OR ((c.user_id IS NULL OR target.user_id IS NULL)
                          AND LOWER(target.email)=c.email))
            )
        AND NOT EXISTS (
              SELECT 1 FROM message_log ml
               WHERE ml.event_id=$2
                 AND ((c.user_id IS NOT NULL AND ml.recipient_user_id=c.user_id)
                      OR ((c.user_id IS NULL OR ml.recipient_user_id IS NULL)
                          AND LOWER(ml.recipient)=c.email))
                 AND ml.message_type IN ('announcement','previous_guest_invite')
                 AND (ml.status IN ('pending','sent')
                      OR (ml.message_type='previous_guest_invite' AND ml.import_delivery_state IS NOT NULL))
            )
      ORDER BY c.email`,
    [organizerId, eventId, FOLLOW_EMAIL_CONSENT_VERSION,
      CONTRIBUTOR_EMAIL_CONSENT_SOURCE, CONTRIBUTOR_EMAIL_CONSENT_VERSION]
  );
  return rows;
}

async function eligibleSmsRecipients(queryable, organizerId, eventId) {
  const { rows } = await queryable.query(
    `SELECT DISTINCT ON (hf.sms_phone)
            hf.id,hf.sms_phone AS phone,LOWER(follower.email) AS email,
            hf.follower_user_id AS user_id,
            COALESCE(NULLIF(follower.name,''),'Friend') AS name
       FROM host_follows hf JOIN organizers follower ON follower.id=hf.follower_organizer_id
      WHERE hf.host_organizer_id=$1 AND hf.unsubscribed_at IS NULL
        AND hf.sms_opted_in_at IS NOT NULL AND hf.sms_opted_out_at IS NULL
        AND hf.sms_consent_version=$3
        AND hf.sms_phone ~ '^\\+[1-9][0-9]{7,14}$'
        AND NOT EXISTS (
              SELECT 1 FROM rsvps target
               WHERE target.event_id=$2 AND target.status='confirmed'
                 AND ((hf.follower_user_id IS NOT NULL AND target.user_id=hf.follower_user_id)
                      OR ((hf.follower_user_id IS NULL OR target.user_id IS NULL)
                          AND LOWER(target.email)=LOWER(follower.email)))
            )
      ORDER BY hf.sms_phone,hf.updated_at DESC,hf.id DESC`,
    [organizerId, eventId, FOLLOW_SMS_CONSENT_VERSION]
  );
  return rows;
}

async function currentFollowerBatch(queryable, eventId) {
  return (await queryable.query(
    `SELECT * FROM sms_notification_batches
      WHERE event_id=$1 AND kind='follower_announcement' LIMIT 1`, [eventId]
  )).rows[0] || null;
}

async function makeFollowerAnnouncementPreview(queryable, event) {
  // Keep these sequential: this helper also runs on a checked-out transaction
  // client, and node-postgres does not support concurrent queries on one client.
  const emails = await eligibleEmailRecipients(queryable, event.organizer_id, event.id);
  const texts = await eligibleSmsRecipients(queryable, event.organizer_id, event.id);
  const batch = await currentFollowerBatch(queryable, event.id);
  let messageBody = '';
  let textReason = null;
  try { messageBody = buildFollowerAnnouncementMessage(event); } catch (error) {
    if (error.code !== 'sms_single_segment_required') throw error;
    textReason = error.message;
  }
  const segmentCount = messageBody ? 1 : 0;
  const creditCost = segmentCount * texts.length;
  const balance = Number(event.sms_credits || 0);
  const welcomeBalance = Number(event.sms_welcome_credits || 0);
  const welcomeEligibleCredits = texts.filter(recipient => isWelcomeSmsDestination(recipient.phone)).length;
  const usableBalance = balance - welcomeBalance + Math.min(welcomeBalance, welcomeEligibleCredits);
  const creditsNeeded = Math.max(0, creditCost - usableBalance);
  const fingerprint = previewFingerprint({ event, recipients: texts, messageBody, creditCost });
  return {
    emailCount: emails.length,
    textCount: texts.length,
    count: new Set([
      ...emails.map(row => row.person_key || row.email),
      ...texts.map(row => row.user_id ? `user:${row.user_id}` : (row.email || `sms:${row.phone}`))
    ]).size,
    messageBody,
    segmentCount,
    templateVersion: SINGLE_SEGMENT_TEMPLATE_VERSION,
    textReason,
    creditCost,
    balance,
    welcomeBalance,
    welcomeEligibleCredits,
    usableBalance,
    creditsNeeded,
    balanceAfter: Math.max(0, balance - creditCost),
    canIncludeTexts: !textReason && texts.length > 0 && !batch && creditsNeeded === 0,
    needsFunds: !textReason && texts.length > 0 && creditsNeeded > 0,
    fingerprint,
    batch,
    _emails: emails,
    _texts: texts
  };
}

async function createFollowerAnnouncementBatch(client, event, preview) {
  assertSingleSegmentMessage(preview.messageBody);
  if (preview.segmentCount !== 1 || preview.creditCost !== preview._texts.length ||
      preview.messageBody !== buildFollowerAnnouncementMessage(event)) {
    throw Object.assign(new Error('The text cost changed. Review the updated preview.'), { code: 'sms_cost_changed', statusCode: 409 });
  }
  const batch = (await client.query(
    `INSERT INTO sms_notification_batches
       (event_id,organizer_id,kind,message_body,segment_count,recipient_count,credit_cost,template_version)
     VALUES ($1,$2,'follower_announcement',$3,$4,$5,$6,$7) RETURNING *`,
    [event.id,event.organizer_id,preview.messageBody,preview.segmentCount,
     preview.textCount,preview.creditCost,SINGLE_SEGMENT_TEMPLATE_VERSION]
  )).rows[0];
  const { balance, welcomeCredits } = await reserveSendCreditsDetailed(client, {
    organizerId: event.organizer_id,
    batchId: batch.id,
    credits: preview.creditCost,
    maxWelcomeCredits: preview._texts.filter(recipient => isWelcomeSmsDestination(recipient.phone)).length,
    metadata: { eventId: event.id, kind: 'follower_announcement', recipientCount: preview.textCount }
  });
  let welcomeRemaining = welcomeCredits;
  for (const recipient of preview._texts) {
    const welcomeCreditsForRecipient = welcomeRemaining > 0 && isWelcomeSmsDestination(recipient.phone) ? 1 : 0;
    welcomeRemaining -= welcomeCreditsForRecipient;
    await client.query(
      `INSERT INTO sms_notification_recipients
         (batch_id,host_follow_id,recipient,recipient_name,segment_count,message_body,welcome_credits)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [batch.id,recipient.id,recipient.phone,recipient.name || null,
       preview.segmentCount,preview.messageBody,welcomeCreditsForRecipient]
    );
  }
  return { batch, balance };
}

module.exports = {
  buildFollowerAnnouncementMessage,
  createFollowerAnnouncementBatch,
  currentFollowerBatch,
  eligibleEmailRecipients,
  eligibleSmsRecipients,
  makeFollowerAnnouncementPreview
};
