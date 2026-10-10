const cron = require('node-cron');
const pool = require('../config/db');
const { sendAdminFlyerNotification } = require('../lib/mailer');
const { lockAdminOperatorRosterInTransaction } = require('../lib/admin-operators');

const RETRY_BASE_SECONDS = 60;
const RETRY_MAX_SECONDS = 6 * 60 * 60;
const SENDING_LEASE_MINUTES = 5;
const KINDS = new Set(['submitted', 'fix_requested']);
let running = false;
let deliverFlyerAdminNotification = sendAdminFlyerNotification;
const backgroundWork = new Set();

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function cleanError(error) {
  return String(error?.message || error || 'Email delivery failed').trim().slice(0, 500) ||
    'Email delivery failed';
}

function retryDelaySeconds(attemptCount) {
  const attempt = Number.isSafeInteger(Number(attemptCount))
    ? Math.max(1, Number(attemptCount))
    : 1;
  // Capping the exponent as well as the result prevents numeric overflow if a
  // provider outage lasts long enough for the ledger to accumulate many tries.
  return Math.min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * (2 ** Math.min(attempt - 1, 16)));
}

// Call inside the transaction that creates the request or records recipient
// request-a-fix action. The recipient address is intentionally snapshotted: later team
// changes do not make an already-committed operational alert disappear.
async function enqueueFlyerAdminNotifications(db, { requestId, kind }) {
  const id = positiveId(requestId);
  if (!id) throw new Error('A valid flyer request is required for an admin notification');
  if (!KINDS.has(kind)) throw new Error('Unknown flyer admin notification kind');
  // Production callers already run inside the request/approval transaction.
  // Sharing the roster lock with operator create/update makes the recipient
  // snapshot deterministic when an operator is concurrently added or revoked.
  await lockAdminOperatorRosterInTransaction(db);
  const { rows } = await db.query(
    `INSERT INTO admin_flyer_request_notifications
       (flyer_request_id,notification_kind,recipient_admin_operator_id,
        notification_revision,recipient,idempotency_key)
     SELECT $1::bigint,$2::text,operator.id,request.preview_revision,operator.email,
            'dfy-flyer-admin-' || ($1::bigint)::text || '-' || $2::text || '-' ||
            request.preview_revision::text || '-' || operator.id::text || '-v1'
       FROM admin_operators operator
       JOIN admin_flyer_requests request ON request.id=$1::bigint
      WHERE operator.role='super_admin' AND operator.status='active'
     ON CONFLICT (flyer_request_id,notification_kind,notification_revision,recipient) DO NOTHING
     RETURNING id`,
    [id, kind]
  );
  return rows.map(row => Number(row.id)).filter(positiveId);
}

async function claimNotification(db, notificationId) {
  const { rows } = await db.query(
    `WITH claimed AS (
       UPDATE admin_flyer_request_notifications
          SET status='sending',attempt_count=attempt_count+1,
              last_attempt_at=NOW(),next_attempt_at=NULL,error=NULL
        WHERE id=$1
          AND (
            (status IN ('pending','failed') AND
             (next_attempt_at IS NULL OR next_attempt_at<=NOW()))
            OR
            (status='sending' AND
             last_attempt_at<NOW() - ($2::int * INTERVAL '1 minute'))
          )
        RETURNING *
     )
     SELECT claimed.*,request.submitter_name,request.host_name,
            request.latest_fix_request,
            event.title AS event_title,
            EXISTS (
              SELECT 1 FROM admin_operators operator
               WHERE operator.id=claimed.recipient_admin_operator_id
                 AND operator.email=claimed.recipient
                 AND operator.role='super_admin' AND operator.status='active'
            ) AS recipient_active
       FROM claimed
       JOIN admin_flyer_requests request ON request.id=claimed.flyer_request_id
       LEFT JOIN events event ON event.id=request.event_id`,
    [notificationId, SENDING_LEASE_MINUTES]
  );
  return rows[0] || null;
}

async function processFlyerAdminNotification(notificationId, { db = pool } = {}) {
  const id = positiveId(notificationId);
  if (!id) return null;
  const notification = await claimNotification(db, id);
  if (!notification) return null;

  const attempt = Number(notification.attempt_count);
  // Approval notices existed before verified recipient approval became the
  // publication action. Never send a stale "Review and publish" message after
  // this release; retain the historical row as a skipped audit record.
  if (notification.notification_kind === 'approved') {
    const error = 'Obsolete approval notification skipped after recipient auto-publish';
    await db.query(
      `UPDATE admin_flyer_request_notifications
          SET status='skipped',next_attempt_at=NULL,error=$3
        WHERE id=$1 AND status='sending' AND attempt_count=$2`,
      [id, attempt, error]
    );
    return { id, status: 'skipped', attemptCount: attempt, error };
  }
  if (!notification.recipient_active) {
    const error = 'Super Admin recipient is no longer active';
    await db.query(
      `UPDATE admin_flyer_request_notifications
          SET status='skipped',next_attempt_at=NULL,error=$3
        WHERE id=$1 AND status='sending' AND attempt_count=$2`,
      [id, attempt, error]
    );
    return { id, status: 'skipped', attemptCount: attempt, error };
  }

  const baseUrl = String(process.env.APP_URL || 'https://silvergliderevents.com').replace(/\/$/, '');
  const adminUrl = `${baseUrl}/admin/done-for-you/flyer-requests/${Number(notification.flyer_request_id)}`;
  try {
    const result = await deliverFlyerAdminNotification({
      to: notification.recipient,
      kind: notification.notification_kind,
      adminUrl,
      requestId: Number(notification.flyer_request_id),
      submitterName: notification.submitter_name,
      hostName: notification.host_name,
      eventTitle: notification.event_title,
      fixRequest: notification.latest_fix_request,
      idempotencyKey: notification.idempotency_key
    });
    await db.query(
      `UPDATE admin_flyer_request_notifications
          SET status='sent',sent_at=NOW(),next_attempt_at=NULL,provider_id=$3,error=NULL
        WHERE id=$1 AND status='sending' AND attempt_count=$2`,
      [id, attempt, result?.id || null]
    );
    return { id, status: 'sent', attemptCount: attempt };
  } catch (error) {
    const message = cleanError(error);
    const retryAfterSeconds = retryDelaySeconds(attempt);
    console.error(`[flyer-admin-notifications] delivery ${id} failed:`, message);
    await db.query(
      `UPDATE admin_flyer_request_notifications
          SET status='failed',error=$3,
              next_attempt_at=NOW() + ($4::int * INTERVAL '1 second')
        WHERE id=$1 AND status='sending' AND attempt_count=$2`,
      [id, attempt, message, retryAfterSeconds]
    );
    return {
      id,
      status: 'failed',
      attemptCount: attempt,
      error: message,
      retryAfterSeconds
    };
  }
}

async function processFlyerAdminNotifications(notificationIds, options = {}) {
  const ids = [...new Set((Array.isArray(notificationIds) ? notificationIds : [notificationIds])
    .map(positiveId).filter(Boolean))];
  const results = [];
  for (const id of ids) results.push(await processFlyerAdminNotification(id, options));
  return results.filter(Boolean);
}

function queueFlyerAdminNotifications(notificationIds) {
  const ids = [...new Set((Array.isArray(notificationIds) ? notificationIds : [notificationIds])
    .map(positiveId).filter(Boolean))];
  if (!ids.length) return;
  const work = new Promise(resolve => setImmediate(resolve))
    .then(() => processFlyerAdminNotifications(ids))
    .catch(error => {
      console.error('[flyer-admin-notifications] immediate delivery failed:', cleanError(error));
    })
    .finally(() => backgroundWork.delete(work));
  backgroundWork.add(work);
}

async function settleFlyerAdminNotificationWork() {
  while (backgroundWork.size) await Promise.allSettled([...backgroundWork]);
}

async function runFlyerAdminNotificationPass() {
  if (running) return;
  running = true;
  try {
    const { rows } = await pool.query(
      `SELECT id
         FROM admin_flyer_request_notifications
        WHERE (
            (status IN ('pending','failed') AND
             (next_attempt_at IS NULL OR next_attempt_at<=NOW()))
            OR
            (status='sending' AND
             last_attempt_at<NOW() - ($1::int * INTERVAL '1 minute'))
          )
        ORDER BY id
        LIMIT 100`,
      [SENDING_LEASE_MINUTES]
    );
    await processFlyerAdminNotifications(rows.map(row => row.id));
  } catch (error) {
    console.error('[flyer-admin-notifications] retry pass failed:', cleanError(error));
  } finally {
    running = false;
  }
}

function startFlyerAdminNotificationCron() {
  cron.schedule('* * * * *', () => runFlyerAdminNotificationPass());
  const initial = setTimeout(() => runFlyerAdminNotificationPass(), 2000);
  initial.unref?.();
  console.log('[flyer-admin-notifications] minute retry cron scheduled');
}

function setFlyerAdminNotificationSenderForTests(sender = sendAdminFlyerNotification) {
  deliverFlyerAdminNotification = sender;
}

module.exports = {
  RETRY_BASE_SECONDS,
  RETRY_MAX_SECONDS,
  enqueueFlyerAdminNotifications,
  processFlyerAdminNotification,
  processFlyerAdminNotifications,
  queueFlyerAdminNotifications,
  retryDelaySeconds,
  runFlyerAdminNotificationPass,
  setFlyerAdminNotificationSenderForTests,
  settleFlyerAdminNotificationWork,
  startFlyerAdminNotificationCron
};
