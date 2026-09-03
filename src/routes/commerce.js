const express = require('express');
const pool = require('../config/db');
const requireOrganizer = require('../middleware/requireOrganizer');
const requireAdmin = require('../middleware/requireAdmin');
const { commerceAdmissionEnabled } = require('../lib/commerce-client');
const { sendCommerceLaunch } = require('../lib/mailer');

const router = express.Router();
const FEATURE_KEY = 'commerce_ticketing';

async function readInterest(organizerId) {
  const { rows } = await pool.query(
    `SELECT requested_at, removed_at, launch_sent_at
       FROM commerce_feature_interests
      WHERE organizer_id=$1 AND feature_key=$2`,
    [organizerId, FEATURE_KEY]
  );
  const interest = rows[0];
  return {
    interested: Boolean(interest && !interest.removed_at),
    requestedAt: interest?.requested_at || null,
    notifiedAt: interest?.launch_sent_at || null
  };
}

// The editor can reveal native ticket setup only after the Commerce service is
// explicitly configured. No credentials or service details reach the browser.
router.get('/api/commerce/config', requireOrganizer, async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      enabled: commerceAdmissionEnabled(),
      interest: await readInterest(req.organizer.id)
    });
  } catch (err) { next(err); }
});

// Explicit, reversible consent for one ticketing launch notification.
router.post('/api/commerce/interest', requireOrganizer, async (req, res, next) => {
  try {
    if (typeof req.body?.interested !== 'boolean') {
      return res.status(400).json({ error: 'Choose whether you want the ticketing launch notification' });
    }

    if (req.body.interested) {
      await pool.query(
        `INSERT INTO commerce_feature_interests (organizer_id, feature_key)
         VALUES ($1,$2)
         ON CONFLICT (organizer_id, feature_key) DO UPDATE
           SET requested_at=CASE
                 WHEN commerce_feature_interests.removed_at IS NOT NULL THEN NOW()
                 ELSE commerce_feature_interests.requested_at
               END,
               removed_at=NULL,
               launch_error=NULL`,
        [req.organizer.id, FEATURE_KEY]
      );
    } else {
      await pool.query(
        `UPDATE commerce_feature_interests
            SET removed_at=COALESCE(removed_at,NOW()), launch_claimed_at=NULL
          WHERE organizer_id=$1 AND feature_key=$2`,
        [req.organizer.id, FEATURE_KEY]
      );
    }

    res.json({ interest: await readInterest(req.organizer.id) });
  } catch (err) { next(err); }
});

router.get('/api/admin/commerce-interest', requireAdmin, async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const { rows } = await pool.query(
      `SELECT cfi.id, cfi.organizer_id, cfi.requested_at, cfi.removed_at,
              cfi.launch_sent_at, cfi.launch_error,
              o.email, o.name, o.org_name
         FROM commerce_feature_interests cfi
         JOIN organizers o ON o.id=cfi.organizer_id
        WHERE cfi.feature_key=$1
        ORDER BY cfi.requested_at DESC, cfi.id DESC`,
      [FEATURE_KEY]
    );
    const active = rows.filter(row => !row.removed_at);
    res.json({
      commerceEnabled: commerceAdmissionEnabled(),
      counts: {
        interested: active.length,
        awaiting: active.filter(row => !row.launch_sent_at).length,
        notified: active.filter(row => row.launch_sent_at).length
      },
      interests: rows
    });
  } catch (err) { next(err); }
});

router.post('/api/admin/commerce-interest/test', requireAdmin, async (req, res, next) => {
  try {
    await sendCommerceLaunch({ to: req.organizer.email, isTest: true });
    res.json({ sent: true, recipient: req.organizer.email });
  } catch (err) { next(err); }
});

// The feature flag and explicit confirmation protect this one-time bulk send.
// Atomic claims plus launch_sent_at make retries safe across multiple instances.
router.post('/api/admin/commerce-interest/send', requireAdmin, async (req, res, next) => {
  try {
    if (!commerceAdmissionEnabled()) {
      return res.status(409).json({ error: 'Enable the Commerce integration before sending the launch email' });
    }
    if (req.body?.confirm !== 'SEND_LAUNCH') {
      return res.status(400).json({ error: 'Confirm the ticketing launch announcement before sending' });
    }

    const { rows: recipients } = await pool.query(
      `WITH claimed AS (
         UPDATE commerce_feature_interests
            SET launch_claimed_at=NOW(), launch_error=NULL
          WHERE feature_key=$1
            AND removed_at IS NULL
            AND launch_sent_at IS NULL
            AND (launch_claimed_at IS NULL OR launch_claimed_at < NOW() - INTERVAL '15 minutes')
         RETURNING id, organizer_id
       )
       SELECT claimed.id, o.email
         FROM claimed
         JOIN organizers o ON o.id=claimed.organizer_id
        ORDER BY claimed.id`,
      [FEATURE_KEY]
    );

    let sent = 0;
    let failed = 0;
    for (const recipient of recipients) {
      try {
        const result = await sendCommerceLaunch({ to: recipient.email });
        await pool.query(
          `UPDATE commerce_feature_interests
              SET launch_sent_at=NOW(), launch_provider_id=$2,
                  launch_claimed_at=NULL, launch_error=NULL
            WHERE id=$1 AND launch_sent_at IS NULL`,
          [recipient.id, result?.id || null]
        );
        sent += 1;
      } catch (error) {
        failed += 1;
        await pool.query(
          `UPDATE commerce_feature_interests
              SET launch_claimed_at=NULL, launch_error=$2
            WHERE id=$1 AND launch_sent_at IS NULL`,
          [recipient.id, String(error.message || 'Email send failed').slice(0, 1000)]
        ).catch(() => {});
      }
    }

    res.json({ total: recipients.length, sent, failed });
  } catch (err) { next(err); }
});

module.exports = router;
