const express = require('express');
const twilio = require('twilio');
const pool = require('../config/db');
const requireOrganizer = require('../middleware/requireOrganizer');
const { SmsCreditError } = require('../lib/sms-credit-ledger');
const {
  batchPayload,
  createReminderBatch,
  eventForSms,
  makePreview
} = require('../lib/sms-reminder-fulfillment');
const { normalizeE164 } = require('../lib/sms');
const { finalizeSmsBatch, queueSmsBatch } = require('../jobs/sms-notifications');

const router = express.Router();
const verifyTwilio = twilio.webhook({ validate: process.env.NODE_ENV === 'production' });

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
    const { batch, balance } = await createReminderBatch(client, event, preview);
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
