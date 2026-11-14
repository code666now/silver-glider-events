const cron = require('node-cron');
const pool = require('../config/db');
const { sendAdminEventAlert } = require('../lib/mailer');
const { lockAdminOperatorRosterInTransaction } = require('../lib/admin-operators');

// The database raises an alert row whenever an event is first published (or
// gets a new image after one was removed). This job turns each alert into one
// email per active Super Admin and Support admin, and retries failures with
// backoff. Publishing never waits on any of it.
const RETRY_BASE_SECONDS = 60;
const RETRY_MAX_SECONDS = 6 * 60 * 60;
const MAX_ATTEMPTS = 8;
const SENDING_LEASE_MINUTES = 5;
const RECIPIENT_ROLES = ['super_admin', 'support'];
let running = false;
let deliver = sendAdminEventAlert;

function cleanError(error) {
  return String(error?.message || error || 'Email delivery failed').trim().slice(0, 500) || 'Email delivery failed';
}

function retryDelaySeconds(attempt) {
  return Math.min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * (2 ** Math.min(Math.max(1, attempt) - 1, 16)));
}

// Snapshot the recipients for every alert that has not been fanned out yet.
async function fanOutPendingAlerts() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Same lock operator create/update takes, so the roster can't change mid-snapshot.
    await lockAdminOperatorRosterInTransaction(client);
    const { rows } = await client.query(
      `SELECT id FROM event_admin_alerts
        WHERE fanned_out_at IS NULL
        ORDER BY id
        LIMIT 100
        FOR UPDATE SKIP LOCKED`
    );
    for (const { id } of rows) {
      await client.query(
        `INSERT INTO event_admin_alert_deliveries (alert_id,admin_operator_id,recipient,idempotency_key)
         SELECT $1::bigint, operator.id, LOWER(BTRIM(operator.email)),
                'event-admin-alert-' || $1::bigint::text || '-' || operator.id::text || '-v1'
           FROM admin_operators operator
          WHERE operator.status='active' AND operator.role = ANY($2::text[])
         ON CONFLICT DO NOTHING`,
        [id, RECIPIENT_ROLES]
      );
      await client.query('UPDATE event_admin_alerts SET fanned_out_at=NOW() WHERE id=$1', [id]);
    }
    await client.query('COMMIT');
    return rows.length;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function claimDelivery(id) {
  const { rows } = await pool.query(
    `UPDATE event_admin_alert_deliveries
        SET status='sending', attempt_count=attempt_count+1, last_attempt_at=NOW(),
            next_attempt_at=NULL, error=NULL
      WHERE id=$1
        AND ((status IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at<=NOW()))
          OR (status='sending' AND last_attempt_at < NOW() - ($2::int * INTERVAL '1 minute')))
      RETURNING *`,
    [id, SENDING_LEASE_MINUTES]
  );
  return rows[0] || null;
}

// Everything the email shows, read at send time so it reflects the event now.
async function alertDetails(alertId) {
  const { rows } = await pool.query(
    `SELECT alert.kind, e.id AS event_id, e.title, e.slug,
            to_char(e.event_date, 'Dy, Mon FMDD, YYYY') AS date_label,
            to_char(e.start_time, 'FMHH12:MI AM') AS time_label,
            COALESCE(e.flyer_image_url, e.cover_image_url) AS image_url,
            COALESCE(NULLIF(BTRIM(o.org_name),''), NULLIF(BTRIM(o.name),''), 'Host') AS organizer_name,
            COALESCE((
              SELECT identity.value FROM user_identities identity
               WHERE identity.user_id=o.user_id AND identity.identity_type='email'
                 AND identity.verification_scope='account' AND identity.verified_at IS NOT NULL
                 AND identity.revoked_at IS NULL
               ORDER BY identity.is_primary DESC, identity.id ASC LIMIT 1
            ), o.email) AS organizer_email,
            (SELECT COUNT(*)::int FROM events mine
              WHERE mine.organizer_id=e.organizer_id AND mine.first_published_at IS NOT NULL) AS published_count
       FROM event_admin_alerts alert
       JOIN events e ON e.id=alert.event_id
       JOIN organizers o ON o.id=e.organizer_id
      WHERE alert.id=$1`,
    [alertId]
  );
  return rows[0] || null;
}

async function processDelivery(id) {
  const delivery = await claimDelivery(id);
  if (!delivery) return null;
  const attempt = Number(delivery.attempt_count);
  const finish = (status, fields = {}) => pool.query(
    `UPDATE event_admin_alert_deliveries
        SET status=$3, error=$4, provider_id=COALESCE($5, provider_id),
            sent_at=CASE WHEN $3='sent' THEN NOW() ELSE sent_at END,
            next_attempt_at=CASE WHEN $3='failed' THEN NOW() + ($6::int * INTERVAL '1 second') ELSE NULL END
      WHERE id=$1 AND status='sending' AND attempt_count=$2`,
    [id, attempt, status, fields.error || null, fields.providerId || null, fields.retryAfter || 0]
  );

  const recipientActive = await pool.query(
    `SELECT 1 FROM admin_operators
      WHERE id=$1 AND LOWER(BTRIM(email))=$2 AND status='active' AND role = ANY($3::text[])`,
    [delivery.admin_operator_id, delivery.recipient, RECIPIENT_ROLES]
  );
  if (!recipientActive.rows.length) {
    await finish('abandoned', { error: 'Recipient is no longer an active admin' });
    return { id, status: 'abandoned' };
  }
  const details = await alertDetails(delivery.alert_id);
  if (!details) {
    await finish('abandoned', { error: 'Event no longer exists' });
    return { id, status: 'abandoned' };
  }

  const baseUrl = String(process.env.APP_URL || 'https://silvergliderevents.com').replace(/\/$/, '');
  try {
    const result = await deliver({
      to: delivery.recipient,
      kind: details.kind,
      event: {
        title: details.title,
        dateLabel: details.date_label,
        timeLabel: details.time_label,
        imageUrl: details.image_url
      },
      organizer: { name: details.organizer_name, email: details.organizer_email },
      publishedEventCount: details.published_count,
      publicUrl: `${baseUrl}/e/${encodeURIComponent(details.slug)}`,
      adminUrl: `${baseUrl}/admin/events?event=${Number(details.event_id)}`,
      idempotencyKey: delivery.idempotency_key
    });
    await finish('sent', { providerId: result?.id || null });
    return { id, status: 'sent' };
  } catch (error) {
    const message = cleanError(error);
    console.error(`[event-admin-alerts] delivery ${id} failed:`, message);
    if (attempt >= MAX_ATTEMPTS) {
      await finish('abandoned', { error: message });
      return { id, status: 'abandoned', error: message };
    }
    await finish('failed', { error: message, retryAfter: retryDelaySeconds(attempt) });
    return { id, status: 'failed', error: message };
  }
}

async function runEventAdminAlertPass() {
  if (running) return [];
  running = true;
  try {
    await fanOutPendingAlerts();
    const { rows } = await pool.query(
      `SELECT id FROM event_admin_alert_deliveries
        WHERE (status IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at<=NOW()))
           OR (status='sending' AND last_attempt_at < NOW() - ($1::int * INTERVAL '1 minute'))
        ORDER BY id
        LIMIT 100`,
      [SENDING_LEASE_MINUTES]
    );
    const results = [];
    for (const row of rows) results.push(await processDelivery(Number(row.id)));
    return results.filter(Boolean);
  } catch (error) {
    console.error('[event-admin-alerts] pass failed:', cleanError(error));
    return [];
  } finally {
    running = false;
  }
}

function startEventAdminAlertCron() {
  cron.schedule('* * * * *', () => runEventAdminAlertPass());
  console.log('[event-admin-alerts] minute cron scheduled');
}

function setEventAdminAlertSenderForTests(sender = sendAdminEventAlert) {
  deliver = sender;
}

module.exports = {
  runEventAdminAlertPass,
  startEventAdminAlertCron,
  setEventAdminAlertSenderForTests,
  RECIPIENT_ROLES
};
