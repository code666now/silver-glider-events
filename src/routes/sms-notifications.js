const express = require('express');
const twilio = require('twilio');
const pool = require('../config/db');
const requireOrganizer = require('../middleware/requireOrganizer');
const { reserveSendCredits, SmsCreditError } = require('../lib/sms-credit-ledger');
const { buildTomorrowMessage, maskPhone, previewFingerprint, smsSegments } = require('../lib/sms-lifecycle');
const { normalizeE164 } = require('../lib/sms');
const { finalizeSmsBatch, queueSmsBatch } = require('../jobs/sms-notifications');

const router = express.Router();
const verifyTwilio = twilio.webhook({ validate: process.env.NODE_ENV === 'production' });

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
        AND r.phone ~ '^\\+[1-9][0-9]{7,14}$'
      ORDER BY r.phone,r.id DESC`,
    [eventId]
  );
  return rows;
}

async function eventForSms(queryable, eventId, organizerId, { lock = false } = {}) {
  const { rows } = await queryable.query(
    `SELECT e.*,o.sms_credits,
            COALESCE(o.org_name,o.name,'Silver Glider Events') AS organizer_label,
            e.event_date=((CURRENT_TIMESTAMP AT TIME ZONE e.timezone)::date + 1) AS is_tomorrow
       FROM events e JOIN organizers o ON o.id=e.organizer_id
      WHERE e.id=$1 AND e.organizer_id=$2${lock ? ' FOR UPDATE OF e,o' : ''}`,
    [eventId, organizerId]
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

async function makePreview(queryable, event) {
  const [recipients, batch] = await Promise.all([
    eligibleRecipients(queryable, event.id),
    currentBatch(queryable, event.id)
  ]);
  const messageBody = buildTomorrowMessage(event);
  const segmentInfo = smsSegments(messageBody);
  const creditCost = segmentInfo.segments * recipients.length;
  const balance = Number(event.sms_credits || 0);
  let reason = null;
  if (event.status !== 'published') reason = 'Publish the event before texting guests.';
  else if (event.secret_show_enabled) reason = 'SMS reminders are not available for Secret Shows yet.';
  else if (!event.is_tomorrow) reason = 'Tomorrow reminders become available one day before the event.';
  else if (batch) reason = 'The tomorrow reminder has already been created for this event.';
  else if (!recipients.length) reason = 'No confirmed guests have opted in to text messages.';
  else if (balance < creditCost) reason = `Buy ${creditCost - balance} more SMS ${creditCost - balance === 1 ? 'credit' : 'credits'} before sending.`;
  const fingerprint = previewFingerprint({ event, recipients, messageBody, creditCost });
  return {
    canSend: !reason,
    reason,
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

router.post('/api/webhooks/twilio/status/:token', verifyTwilio, async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.token))) return res.sendStatus(404);
    const providerStatus = String(req.body.MessageStatus || '').toLowerCase().slice(0, 40);
    const providerSid = String(req.body.MessageSid || '').slice(0, 40);
    const mapped = ['accepted','queued','sending','sent','delivered','undelivered','failed'].includes(providerStatus)
      ? providerStatus : null;
    if (!mapped || !/^(SM|MM)[0-9a-f]{32}$/i.test(providerSid)) return res.sendStatus(204);
    const { rows } = await pool.query(
      `UPDATE sms_notification_recipients
          SET status=$2,provider_status=$2,
              provider_message_sid=COALESCE(provider_message_sid,$3),
              provider_error_code=NULLIF($4,''),
              delivered_at=CASE WHEN $2='delivered' THEN COALESCE(delivered_at,NOW()) ELSE delivered_at END,
              failed_at=CASE WHEN $2 IN ('failed','undelivered') THEN COALESCE(failed_at,NOW()) ELSE failed_at END,
              updated_at=NOW()
        WHERE status_token=$1 AND (provider_message_sid IS NULL OR provider_message_sid=$3)
        RETURNING batch_id`,
      [req.params.token, mapped, providerSid, String(req.body.ErrorCode || '').slice(0, 40)]
    );
    if (rows[0]) await finalizeSmsBatch(rows[0].batch_id);
    res.sendStatus(204);
  } catch (error) { next(error); }
});

router.post('/api/webhooks/twilio/inbound', verifyTwilio, async (req, res, next) => {
  try {
    const optOutType = String(req.body.OptOutType || '').trim().toUpperCase();
    const body = String(req.body.Body || '').trim().toUpperCase();
    const isStop = optOutType === 'STOP' || ['STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT'].includes(body);
    if (isStop) {
      let from = null;
      try { from = normalizeE164(req.body.From); } catch (_) {}
      if (from) {
        await pool.query(
          `UPDATE rsvps SET sms_optin=FALSE,sms_opted_out_at=COALESCE(sms_opted_out_at,NOW())
            WHERE phone=$1 AND sms_optin=TRUE`,
          [from]
        );
      }
    }
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } catch (error) { next(error); }
});

router.use('/api/events', requireOrganizer);

router.get('/api/events/:id/sms/tomorrow-preview', async (req, res, next) => {
  try {
    const event = await eventForSms(pool, req.params.id, req.organizer.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const preview = await makePreview(pool, event);
    delete preview._recipients;
    res.json(preview);
  } catch (error) { next(error); }
});

router.post('/api/events/:id/sms/tomorrow', async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (req.body?.confirm !== 'SEND_TOMORROW_SMS') {
      return res.status(400).json({ error: 'Review and confirm the SMS before sending' });
    }
    await client.query('BEGIN');
    const event = await eventForSms(client, req.params.id, req.organizer.id, { lock: true });
    if (!event) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found' });
    }
    const preview = await makePreview(client, event);
    if (preview.batch) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'The tomorrow reminder was already sent or queued' });
    }
    if (!preview.canSend) {
      await client.query('ROLLBACK');
      return res.status(preview.balance < preview.creditCost ? 402 : 400).json({ error: preview.reason });
    }
    if (String(req.body.fingerprint || '') !== preview.fingerprint) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'The audience or cost changed. Review the updated preview before sending.' });
    }
    const batch = (await client.query(
      `INSERT INTO sms_notification_batches
         (event_id,organizer_id,kind,message_body,segment_count,recipient_count,credit_cost)
       VALUES ($1,$2,'event_tomorrow',$3,$4,$5,$6) RETURNING *`,
      [event.id, event.organizer_id, preview.messageBody, preview.segmentCount,
       preview.recipientCount, preview.creditCost]
    )).rows[0];
    const balance = await reserveSendCredits(client, {
      organizerId: event.organizer_id,
      batchId: batch.id,
      credits: preview.creditCost,
      metadata: { eventId: event.id, kind: 'event_tomorrow', recipientCount: preview.recipientCount }
    });
    for (const recipient of preview._recipients) {
      await client.query(
        `INSERT INTO sms_notification_recipients
           (batch_id,rsvp_id,recipient,recipient_name,segment_count)
         VALUES ($1,$2,$3,$4,$5)`,
        [batch.id, recipient.id, recipient.phone,
         `${recipient.first_name || ''} ${recipient.last_name || ''}`.trim() || null,
         preview.segmentCount]
      );
    }
    await client.query('COMMIT');
    queueSmsBatch(batch.id);
    res.status(202).json({ queued: preview.recipientCount, balance, batch: batchPayload(batch) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') return res.status(409).json({ error: 'The tomorrow reminder was already sent or queued' });
    if (error instanceof SmsCreditError) return res.status(error.status).json({ error: error.message });
    next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
