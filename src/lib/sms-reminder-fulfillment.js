const crypto = require('crypto');
const { reserveSendCredits } = require('./sms-credit-ledger');
const { SMS_CONSENT_VERSION } = require('./sms-consent');
const {
  buildTomorrowMessage,
  maskPhone,
  previewFingerprint,
  smsSegments
} = require('./sms-lifecycle');

const PREVIEW_ACCESS_TOKEN = 'x'.repeat(32);

function batchPayload(batch) {
  if (!batch) return null;
  return {
    id: String(batch.id),
    kind: batch.kind,
    status: batch.status,
    recipientCount: Number(batch.recipient_count),
    creditCost: Number(batch.credit_cost),
    refundedCredits: Number(batch.refunded_credits),
    acceptedCount: Number(batch.accepted_count),
    deliveredCount: Number(batch.delivered_count),
    failedCount: Number(batch.failed_count),
    createdAt: batch.created_at
  };
}

async function eligibleRecipients(queryable, eventId) {
  const { rows } = await queryable.query(
    `SELECT DISTINCT ON (r.phone) r.id,r.phone,r.first_name,r.last_name
       FROM rsvps r
      WHERE r.event_id=$1 AND r.status='confirmed' AND r.sms_optin=TRUE
        AND r.sms_consent_at IS NOT NULL AND r.sms_opted_out_at IS NULL
        AND r.sms_consent_version=$2
        AND r.phone ~ '^\\+[1-9][0-9]{7,14}$'
      ORDER BY r.phone,r.id DESC`,
    [eventId, SMS_CONSENT_VERSION]
  );
  return rows;
}

async function eventForSms(queryable, eventId, organizerId = null, { lock = false } = {}) {
  const params = [eventId];
  const organizerFilter = organizerId == null ? '' : ` AND e.organizer_id=$${params.push(organizerId)}`;
  const { rows } = await queryable.query(
    `SELECT e.*,o.sms_credits,
            COALESCE(o.org_name,o.name,'Silver Glider Events') AS organizer_label,
            e.event_date=((CURRENT_TIMESTAMP AT TIME ZONE e.timezone)::date + 1) AS is_tomorrow
       FROM events e JOIN organizers o ON o.id=e.organizer_id
      WHERE e.id=$1${organizerFilter}${lock ? ' FOR UPDATE OF e,o' : ''}`,
    params
  );
  return rows[0] || null;
}

async function currentBatch(queryable, eventId) {
  return (await queryable.query(
    `SELECT * FROM sms_notification_batches
      WHERE event_id=$1 AND kind='event_tomorrow' LIMIT 1`,
    [eventId]
  )).rows[0] || null;
}

async function makePreview(queryable, event, { requireTomorrow = true } = {}) {
  const [recipients, batch] = await Promise.all([
    eligibleRecipients(queryable, event.id),
    currentBatch(queryable, event.id)
  ]);
  const messageBody = buildTomorrowMessage(event, process.env.APP_URL, PREVIEW_ACCESS_TOKEN);
  const segmentInfo = smsSegments(messageBody);
  const creditCost = segmentInfo.segments * recipients.length;
  const balance = Number(event.sms_credits || 0);
  let reason = null;
  if (!event.sms_reminder_enabled) reason = 'Turn on the day-before text reminder for this event first.';
  else if (event.status !== 'published') reason = 'Publish the event before text reminders can send.';
  else if (event.secret_show_enabled) reason = 'Text reminders are not available for Secret Shows yet.';
  else if (batch) reason = 'The day-before reminder has already been created for this event.';
  else if (requireTomorrow && !event.is_tomorrow) reason = 'The reminder will send automatically at 4 PM the day before the event.';
  else if (!recipients.length) reason = 'No guests have opted in to text reminders yet.';
  else if (balance < creditCost) reason = `Add ${creditCost - balance} more texting ${creditCost - balance === 1 ? 'credit' : 'credits'} before the reminder sends.`;
  const fingerprint = previewFingerprint({ event, recipients, messageBody, creditCost });
  return {
    canSend: !reason,
    reason,
    reminderEnabled: Boolean(event.sms_reminder_enabled),
    eventIsTomorrow: Boolean(event.is_tomorrow),
    eventStatus: event.status,
    secretShowEnabled: Boolean(event.secret_show_enabled),
    messageBody,
    encoding: segmentInfo.encoding,
    segmentCount: segmentInfo.segments,
    recipientCount: recipients.length,
    creditCost,
    balance,
    balanceAfter: Math.max(0, balance - creditCost),
    needsFunds: recipients.length > 0 && balance < creditCost,
    fingerprint,
    batch: batchPayload(batch),
    recipients: recipients.map(recipient => ({
      id: recipient.id,
      name: `${recipient.first_name || ''} ${recipient.last_name || ''}`.trim() || 'Guest',
      phone: maskPhone(recipient.phone)
    })),
    _recipients: recipients
  };
}

async function createReminderBatch(client, event, preview) {
  const deliveries = preview._recipients.map(recipient => {
    const accessToken = crypto.randomBytes(16).toString('hex');
    const messageBody = buildTomorrowMessage(event, process.env.APP_URL, accessToken);
    const segmentCount = smsSegments(messageBody).segments;
    return { recipient, accessToken, messageBody, segmentCount };
  });
  const creditCost = deliveries.reduce((sum, delivery) => sum + delivery.segmentCount, 0);
  if (creditCost !== preview.creditCost) {
    const error = new Error('The text cost changed while creating the reminder');
    error.code = 'sms_cost_changed';
    throw error;
  }
  const batch = (await client.query(
    `INSERT INTO sms_notification_batches
       (event_id,organizer_id,kind,message_body,segment_count,recipient_count,credit_cost)
     VALUES ($1,$2,'event_tomorrow',$3,$4,$5,$6) RETURNING *`,
    [event.id, event.organizer_id, preview.messageBody, preview.segmentCount,
     preview.recipientCount, creditCost]
  )).rows[0];
  const balance = await reserveSendCredits(client, {
    organizerId: event.organizer_id,
    batchId: batch.id,
    credits: creditCost,
    metadata: { eventId: event.id, kind: 'event_tomorrow', recipientCount: preview.recipientCount }
  });
  for (const delivery of deliveries) {
    const recipient = delivery.recipient;
    await client.query(
      `INSERT INTO sms_notification_recipients
         (batch_id,rsvp_id,recipient,recipient_name,segment_count,message_body,
          access_token,access_token_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()+INTERVAL '8 days')`,
      [batch.id, recipient.id, recipient.phone,
       `${recipient.first_name || ''} ${recipient.last_name || ''}`.trim() || null,
       delivery.segmentCount, delivery.messageBody, delivery.accessToken]
    );
  }
  return { batch, balance };
}

module.exports = {
  PREVIEW_ACCESS_TOKEN,
  batchPayload,
  createReminderBatch,
  currentBatch,
  eligibleRecipients,
  eventForSms,
  makePreview
};
