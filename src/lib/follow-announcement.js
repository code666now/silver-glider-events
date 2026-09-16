const { reserveSendCredits } = require('./sms-credit-ledger');
const {
  FOLLOW_EMAIL_CONSENT_VERSION,
  FOLLOW_SMS_CONSENT_VERSION
} = require('./follow-consent');
const { previewFingerprint, smsSegments } = require('./sms-lifecycle');

function compact(value, fallback) {
  return String(value || fallback || '').replace(/\s+/g, ' ').trim();
}

function shortEventDate(value) {
  const raw = value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
  const date = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC'
  });
}

function buildFollowerAnnouncementMessage(event, baseUrl = process.env.APP_URL) {
  const root = String(baseUrl || 'https://silvergliderevents.com').replace(/\/$/, '');
  const host = compact(event.organizer_label, 'Silver Glider Events');
  const title = compact(event.title, 'New event');
  const link = `${root}/e/${encodeURIComponent(event.slug)}`;
  const suffix = ` on ${shortEventDate(event.event_date)}. RSVP: ${link} Reply STOP to opt out.`;
  const lead = `${host}: New event - ${title}`.slice(0, Math.max(35, 300 - suffix.length)).trim();
  return `${lead}${suffix}`;
}

async function eligibleEmailRecipients(queryable, organizerId, eventId) {
  const { rows } = await queryable.query(
    `WITH candidates AS (
       SELECT LOWER(r.email) AS email,MIN(r.first_name) AS first_name
         FROM rsvps r JOIN events source_event ON source_event.id=r.event_id
        WHERE source_event.organizer_id=$1 AND r.organizer_optin=TRUE AND r.status='confirmed'
        GROUP BY LOWER(r.email)
       UNION ALL
       SELECT LOWER(follower.email) AS email,
              MIN(COALESCE(NULLIF(SPLIT_PART(follower.name,' ',1),''),'Friend')) AS first_name
         FROM host_follows hf JOIN organizers follower ON follower.id=hf.follower_organizer_id
        WHERE hf.host_organizer_id=$1 AND hf.unsubscribed_at IS NULL
          AND hf.email_opted_in_at IS NOT NULL
          AND hf.email_consent_version=$3
        GROUP BY LOWER(follower.email)
     )
     SELECT c.email,MIN(c.first_name) AS first_name
       FROM candidates c
      WHERE NOT EXISTS (
              SELECT 1 FROM follower_optouts fo
               WHERE fo.organizer_id=$1 AND LOWER(fo.email)=c.email
            )
        AND NOT EXISTS (
              SELECT 1 FROM rsvps target
               WHERE target.event_id=$2 AND target.status='confirmed'
                 AND LOWER(target.email)=c.email
            )
        AND NOT EXISTS (
              SELECT 1 FROM message_log ml
               WHERE ml.event_id=$2 AND LOWER(ml.recipient)=c.email
                 AND ml.message_type IN ('announcement','previous_guest_invite')
                 AND ml.status IN ('pending','sent')
            )
      GROUP BY c.email ORDER BY c.email`,
    [organizerId, eventId, FOLLOW_EMAIL_CONSENT_VERSION]
  );
  return rows;
}

async function eligibleSmsRecipients(queryable, organizerId, eventId) {
  const { rows } = await queryable.query(
    `SELECT DISTINCT ON (hf.sms_phone)
            hf.id,hf.sms_phone AS phone,LOWER(follower.email) AS email,
            COALESCE(NULLIF(follower.name,''),'Friend') AS name
       FROM host_follows hf JOIN organizers follower ON follower.id=hf.follower_organizer_id
      WHERE hf.host_organizer_id=$1 AND hf.unsubscribed_at IS NULL
        AND hf.sms_opted_in_at IS NOT NULL AND hf.sms_opted_out_at IS NULL
        AND hf.sms_consent_version=$3
        AND hf.sms_phone ~ '^\\+[1-9][0-9]{7,14}$'
        AND NOT EXISTS (
              SELECT 1 FROM rsvps target
               WHERE target.event_id=$2 AND target.status='confirmed'
                 AND LOWER(target.email)=LOWER(follower.email)
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
  const messageBody = buildFollowerAnnouncementMessage(event);
  const segmentInfo = smsSegments(messageBody);
  const creditCost = segmentInfo.segments * texts.length;
  const balance = Number(event.sms_credits || 0);
  const fingerprint = previewFingerprint({ event, recipients: texts, messageBody, creditCost });
  return {
    emailCount: emails.length,
    textCount: texts.length,
    count: new Set([...emails.map(row => row.email), ...texts.map(row => row.email || `sms:${row.phone}`)]).size,
    messageBody,
    segmentCount: segmentInfo.segments,
    creditCost,
    balance,
    balanceAfter: Math.max(0, balance - creditCost),
    canIncludeTexts: texts.length > 0 && !batch && balance >= creditCost,
    needsFunds: texts.length > 0 && balance < creditCost,
    fingerprint,
    batch,
    _emails: emails,
    _texts: texts
  };
}

async function createFollowerAnnouncementBatch(client, event, preview) {
  const batch = (await client.query(
    `INSERT INTO sms_notification_batches
       (event_id,organizer_id,kind,message_body,segment_count,recipient_count,credit_cost)
     VALUES ($1,$2,'follower_announcement',$3,$4,$5,$6) RETURNING *`,
    [event.id,event.organizer_id,preview.messageBody,preview.segmentCount,
     preview.textCount,preview.creditCost]
  )).rows[0];
  const balance = await reserveSendCredits(client, {
    organizerId: event.organizer_id,
    batchId: batch.id,
    credits: preview.creditCost,
    metadata: { eventId: event.id, kind: 'follower_announcement', recipientCount: preview.textCount }
  });
  for (const recipient of preview._texts) {
    await client.query(
      `INSERT INTO sms_notification_recipients
         (batch_id,host_follow_id,recipient,recipient_name,segment_count,message_body)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [batch.id,recipient.id,recipient.phone,recipient.name || null,
       preview.segmentCount,preview.messageBody]
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
