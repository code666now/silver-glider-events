const cron = require('node-cron');
const pool = require('../config/db');
const sms = require('../lib/sms');
const { sendDoneForYouWelcome } = require('../lib/mailer');
const { sendDoneForYouClaimInvitation } = require('../lib/done-for-you-claim-invitation');
const { openSecret, sealSecret } = require('../lib/sealed-secret');

const PILOT_PUBLISH_PHONE = '+14152053302';
const RETRY_BASE_SECONDS = 60;
const RETRY_MAX_SECONDS = 6 * 60 * 60;
const SENDING_LEASE_MINUTES = 5;
let running = false;
let deliverFlyerWelcome = sendDoneForYouWelcome;
const backgroundWork = new Set();

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function cleanError(error) {
  return String(error?.message || error || 'Delivery failed').trim().slice(0, 500) ||
    'Delivery failed';
}

function retryDelaySeconds(attemptCount) {
  const attempt = Number.isSafeInteger(Number(attemptCount))
    ? Math.max(1, Number(attemptCount))
    : 1;
  return Math.min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * (2 ** Math.min(attempt - 1, 16)));
}

function appBaseUrl() {
  return String(process.env.APP_URL || 'https://silvergliderevents.com').replace(/\/$/, '');
}

function newAccountWelcomeKey(requestId) {
  return `dfy-flyer-${Number(requestId)}-new-welcome-v1`;
}

function welcomeSecretPurpose(requestId, targetUserId, invitationId) {
  return `dfy-welcome:${Number(requestId)}:${Number(targetUserId)}:${Number(invitationId)}`;
}

function readPersistedWelcomePayload(value, expectedKey) {
  const payload = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
  if (!payload || payload.existingAccount !== false ||
      payload.idempotencyKey !== expectedKey ||
      Object.prototype.hasOwnProperty.call(payload, 'link') ||
      Object.prototype.hasOwnProperty.call(payload, 'token') ||
      !String(payload.to || '').trim()) {
    throw new Error('The durable welcome payload is invalid');
  }
  return payload;
}

function readPreparedClaimSecret(envelope, purpose) {
  let secret;
  try {
    secret = JSON.parse(openSecret(envelope, purpose));
  } catch (_) {
    throw new Error('The durable welcome credential could not be opened');
  }
  const token = String(secret?.token || '');
  const link = String(secret?.link || '');
  let linkToken = '';
  try {
    linkToken = new URL(link).searchParams.get('token') || '';
  } catch (_) {}
  if (!token || token.length > 200 || token !== linkToken) {
    throw new Error('The durable welcome credential is invalid');
  }
  return { token, link };
}

// Called inside the same transaction that publishes the event. A committed
// publication therefore always has durable work for both transactional texts
// and (for the first Done For You event) its welcome/Home Base email.
async function enqueueFlyerPublicationNotifications(db, { requestId }) {
  const id = positiveId(requestId);
  if (!id) throw new Error('A valid flyer request is required for publication delivery');
  const request = (await db.query(
    `SELECT request.id,request.event_id,request.preview_revision,request.phone_e164,
            request.done_for_you_client_id,request.assigned_admin_operator_id,
            request.claim_invitation_status,
            marker.target_user_id,marker.created_by_admin_operator_id
       FROM admin_flyer_requests request
       JOIN admin_done_for_you_clients marker ON marker.id=request.done_for_you_client_id
       JOIN events event ON event.id=request.event_id
      WHERE request.id=$1 AND request.status='published' AND event.status='published'
      FOR UPDATE OF request`,
    [id]
  )).rows[0];
  if (!request) throw new Error('Published flyer request not found while enqueuing delivery');

  const smsRows = (await db.query(
    `INSERT INTO admin_flyer_request_messages
       (flyer_request_id,event_id,message_kind,revision,recipient,status,
        initiated_by_admin_operator_id)
     VALUES
       ($1,$2,'live',$3,$4,'pending',NULL),
       ($1,$2,'pilot_publish',$3,$5,'pending',NULL)
     ON CONFLICT (flyer_request_id,message_kind,revision)
     DO UPDATE SET event_id=COALESCE(admin_flyer_request_messages.event_id,EXCLUDED.event_id)
     RETURNING id,message_kind`,
    [id, request.event_id, request.preview_revision, request.phone_e164, PILOT_PUBLISH_PHONE]
  )).rows;

  const authorizingAdminOperatorId = positiveId(request.assigned_admin_operator_id) ||
    positiveId(request.created_by_admin_operator_id);
  if (!authorizingAdminOperatorId) {
    throw new Error('The reviewed flyer has no authorizing administrator');
  }
  const welcome = request.claim_invitation_status === 'sent'
    ? null
    : (await db.query(
      `INSERT INTO admin_done_for_you_welcome_deliveries
         (target_user_id,flyer_request_id,authorizing_admin_operator_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (target_user_id) DO NOTHING
       RETURNING target_user_id,flyer_request_id,status`,
      [request.target_user_id, id, authorizingAdminOperatorId]
    )).rows[0];
  // Older releases recorded successful welcome delivery only on the request.
  // Preserve that terminal state even if the migration backfill has not run
  // yet in a partially upgraded development environment.
  if (request.claim_invitation_status !== 'sent' && welcome) {
    await db.query(
      `UPDATE admin_flyer_requests
          SET claim_invitation_status=CASE
                WHEN claim_invitation_status='sent' THEN 'sent'
                ELSE 'pending'
              END,
              claim_invitation_error=NULL,updated_at=NOW()
        WHERE id=$1`,
      [id]
    );
  } else if (request.claim_invitation_status !== 'sent') {
    const owner = (await db.query(
      `SELECT flyer_request_id,status,invitation_id,sent_at,error
         FROM admin_done_for_you_welcome_deliveries
        WHERE target_user_id=$1`,
      [request.target_user_id]
    )).rows[0];
    if (Number(owner?.flyer_request_id) === id) {
      await db.query(
        `UPDATE admin_flyer_requests
            SET claim_invitation_status=$2,
                claim_invitation_id=$3,
                claim_invitation_sent_at=$4,
                claim_invitation_error=$5,updated_at=NOW()
          WHERE id=$1`,
        [id, owner.status, owner.invitation_id, owner.sent_at, owner.error]
      );
    } else {
      await db.query(
        `UPDATE admin_flyer_requests
            SET claim_invitation_status='not_needed',claim_invitation_error=NULL,
                updated_at=NOW()
          WHERE id=$1 AND claim_invitation_status IS DISTINCT FROM 'sent'`,
        [id]
      );
    }
  }
  return {
    smsIds: smsRows.map(row => Number(row.id)).filter(positiveId),
    welcomeTargetUserId: welcome ? Number(welcome.target_user_id) : null
  };
}

async function claimSmsDelivery(messageId, { force = false, db = pool } = {}) {
  const { rows } = await db.query(
    `WITH claimed AS (
       UPDATE admin_flyer_request_messages
          SET status='sending',attempt_count=attempt_count+1,
              last_attempt_at=NOW(),next_attempt_at=NULL,error=NULL
        WHERE id=$1 AND message_kind IN ('live','pilot_publish')
          AND event_id IS NOT NULL
          AND (
            (status IN ('pending','failed') AND
             ($2::boolean OR next_attempt_at IS NULL OR next_attempt_at<=NOW()))
            OR
            (status='sending' AND
             COALESCE(last_attempt_at,created_at)<NOW() - ($3::int * INTERVAL '1 minute'))
          )
        RETURNING *
     )
     SELECT claimed.*,request.host_name,event.title AS event_title,event.slug AS event_slug
       FROM claimed
       JOIN admin_flyer_requests request ON request.id=claimed.flyer_request_id
       JOIN events event ON event.id=claimed.event_id AND event.status='published'`,
    [messageId, Boolean(force), SENDING_LEASE_MINUTES]
  );
  return rows[0] || null;
}

async function processSmsDelivery(messageId, options = {}) {
  const id = positiveId(messageId);
  if (!id) return null;
  const db = options.db || pool;
  const delivery = await claimSmsDelivery(id, { ...options, db });
  if (!delivery) return null;
  const attempt = Number(delivery.attempt_count);
  const eventUrl = `${appBaseUrl()}/e/${delivery.event_slug}`;
  const body = delivery.message_kind === 'pilot_publish'
    ? `Published: ${delivery.event_title || 'Untitled event'} by ${delivery.host_name || 'Unknown promoter'}\n${eventUrl}`
    : `Your show is live! 🎸\nShare your event: ${eventUrl}`;
  try {
    const result = await sms.sendSms({ to: delivery.recipient, body });
    await db.query(
      `UPDATE admin_flyer_request_messages
          SET status='sent',provider_id=$3,sent_at=NOW(),next_attempt_at=NULL,error=NULL
        WHERE id=$1 AND status='sending' AND attempt_count=$2`,
      [id, attempt, result.sid]
    );
    return { id, kind: delivery.message_kind, status: 'sent', attemptCount: attempt };
  } catch (error) {
    const message = cleanError(error);
    const delay = retryDelaySeconds(attempt);
    await db.query(
      `UPDATE admin_flyer_request_messages
          SET status='failed',error=$3,
              next_attempt_at=NOW() + ($4::int * INTERVAL '1 second')
        WHERE id=$1 AND status='sending' AND attempt_count=$2`,
      [id, attempt, message, delay]
    );
    console.error(`[flyer-publication] ${delivery.message_kind} SMS ${id} failed:`, message);
    return { id, kind: delivery.message_kind, status: 'failed', attemptCount: attempt, error: message };
  }
}

async function claimWelcomeDelivery(requestId, { force = false, db = pool } = {}) {
  const { rows } = await db.query(
    `WITH claimed AS (
       UPDATE admin_done_for_you_welcome_deliveries delivery
          SET status='sending',attempt_count=attempt_count+1,
              last_attempt_at=NOW(),next_attempt_at=NULL,error=NULL
        WHERE delivery.flyer_request_id=$1
          AND (
            (status IN ('pending','failed') AND
             ($2::boolean OR next_attempt_at IS NULL OR next_attempt_at<=NOW()))
            OR
            (status='sending' AND
             COALESCE(last_attempt_at,created_at)<NOW() - ($3::int * INTERVAL '1 minute'))
          )
        RETURNING *
     )
     SELECT claimed.*,request.done_for_you_client_id,request.email,request.event_id,
            request.event_title,request.event_slug,request.event_public_host_slug
       FROM claimed
       JOIN (
         SELECT flyer_request.id,flyer_request.done_for_you_client_id,flyer_request.email,
                event.id AS event_id,event.title AS event_title,event.slug AS event_slug,
                organizer.public_slug AS event_public_host_slug
           FROM admin_flyer_requests flyer_request
           JOIN events event ON event.id=flyer_request.event_id AND event.status='published'
           LEFT JOIN organizers organizer ON organizer.id=event.organizer_id
       ) request ON request.id=claimed.flyer_request_id`,
    [requestId, Boolean(force), SENDING_LEASE_MINUTES]
  );
  return rows[0] || null;
}

async function processWelcomeDelivery(requestId, options = {}) {
  const id = positiveId(requestId);
  if (!id) return null;
  const db = options.db || pool;
  const delivery = await claimWelcomeDelivery(id, { ...options, db });
  if (!delivery) return null;
  const attempt = Number(delivery.attempt_count);
  const eventUrl = `${appBaseUrl()}/e/${delivery.event_slug}`;
  const hostPageUrl = delivery.event_public_host_slug
    ? `${appBaseUrl()}/h/${delivery.event_public_host_slug}`
    : null;
  const stableNewAccountKey = newAccountWelcomeKey(id);
  let preparedInvitation = null;
  let preparedPayload = null;
  try {
    const hasPreparedCredential = delivery.invitation_id != null ||
      delivery.claim_token_encrypted != null || delivery.delivery_payload != null;
    if (hasPreparedCredential) {
      const invitationId = positiveId(delivery.invitation_id);
      if (!invitationId || !delivery.claim_token_encrypted || !delivery.delivery_payload) {
        throw new Error('The durable welcome credential is incomplete');
      }
      preparedPayload = readPersistedWelcomePayload(
        delivery.delivery_payload,
        stableNewAccountKey
      );
      const preparedSecret = readPreparedClaimSecret(
        delivery.claim_token_encrypted,
        welcomeSecretPurpose(id, delivery.target_user_id, invitationId)
      );
      preparedPayload = { ...preparedPayload, link: preparedSecret.link };
      preparedInvitation = {
        id: invitationId,
        token: preparedSecret.token
      };
    }
    const invitation = await sendDoneForYouClaimInvitation({
      pool: db,
      markerId: Number(delivery.done_for_you_client_id),
      actorAdminOperatorId: Number(delivery.authorizing_admin_operator_id),
      requestedEmail: delivery.email,
      metadata: {
        flyerRequestId: id,
        trigger: 'verified_recipient_auto_publish'
      },
      welcomeClaimedAccount: true,
      preparedInvitation,
      preserveInvitationOnDeliveryFailure: true,
      persistPreparedInvitation: async prepared => {
        const payload = {
          to: prepared.to,
          name: prepared.name,
          eventLink: eventUrl,
          hostPageLink: hostPageUrl,
          eventTitle: delivery.event_title,
          existingAccount: false,
          idempotencyKey: stableNewAccountKey
        };
        const encryptedToken = sealSecret(
          JSON.stringify({ token: prepared.token, link: prepared.link }),
          welcomeSecretPurpose(id, delivery.target_user_id, prepared.invitation.id)
        );
        const saved = await prepared.db.query(
          `UPDATE admin_done_for_you_welcome_deliveries
              SET invitation_id=$4,claim_token_encrypted=$5,
                  delivery_payload=$6::jsonb
            WHERE target_user_id=$1 AND flyer_request_id=$2
              AND status='sending' AND attempt_count=$3
              AND invitation_id IS NULL
            RETURNING invitation_id`,
          [delivery.target_user_id, id, attempt, prepared.invitation.id,
           encryptedToken, JSON.stringify(payload)]
        );
        if (!saved.rows[0]) {
          throw new Error('The durable welcome delivery changed while preparing its credential');
        }
        await prepared.db.query(
          `UPDATE admin_flyer_requests
              SET claim_invitation_id=$2,claim_invitation_status='sending',updated_at=NOW()
            WHERE id=$1`,
          [id, prepared.invitation.id]
        );
        preparedPayload = { ...payload, link: prepared.link };
      },
      deliver: message => {
        if (message.existingAccount) {
          return deliverFlyerWelcome({
            ...message,
            eventLink: eventUrl,
            hostPageLink: hostPageUrl,
            eventTitle: delivery.event_title,
            idempotencyKey: `dfy-flyer-${id}-existing-welcome-v1`
          });
        }
        if (!preparedPayload || message.link !== preparedPayload.link ||
            message.to !== preparedPayload.to) {
          throw new Error('The prepared welcome payload does not match its claim credential');
        }
        return deliverFlyerWelcome(preparedPayload);
      }
    });
    await db.query(
      `WITH saved AS (
       UPDATE admin_done_for_you_welcome_deliveries
            SET status='sent',invitation_id=$3,sent_at=NOW(),next_attempt_at=NULL,error=NULL,
                claim_token_encrypted=NULL,delivery_payload=NULL
          WHERE target_user_id=$1 AND status='sending' AND attempt_count=$2
          RETURNING flyer_request_id,invitation_id,sent_at
       )
       UPDATE admin_flyer_requests request
          SET claim_invitation_id=saved.invitation_id,claim_invitation_status='sent',
              claim_invitation_sent_at=saved.sent_at,claim_invitation_error=NULL,
              claimed_at=CASE WHEN $4 THEN COALESCE(request.claimed_at,NOW()) ELSE request.claimed_at END,
              updated_at=NOW()
         FROM saved
        WHERE request.id=saved.flyer_request_id`,
      [delivery.target_user_id, attempt, invitation.id, Boolean(invitation.existingAccount)]
    );
    return { requestId: id, status: 'sent', attemptCount: attempt };
  } catch (error) {
    const message = cleanError(error);
    const delay = retryDelaySeconds(attempt);
    await db.query(
      `WITH saved AS (
         UPDATE admin_done_for_you_welcome_deliveries
            SET status='failed',error=$3,
                next_attempt_at=NOW() + ($4::int * INTERVAL '1 second')
          WHERE target_user_id=$1 AND status='sending' AND attempt_count=$2
          RETURNING flyer_request_id,error
       )
       UPDATE admin_flyer_requests request
          SET claim_invitation_status='failed',claim_invitation_error=saved.error,
              claimed_at=CASE WHEN $5 THEN COALESCE(request.claimed_at,NOW()) ELSE request.claimed_at END,
              updated_at=NOW()
         FROM saved
        WHERE request.id=saved.flyer_request_id`,
      [delivery.target_user_id, attempt, message, delay, Boolean(error.doneForYouClaimedAccount)]
    ).catch(() => {});
    console.error(`[flyer-publication] welcome for request ${id} failed:`, message);
    return { requestId: id, status: 'failed', attemptCount: attempt, error: message };
  }
}

async function publicationDeliveryState(requestId, { db = pool } = {}) {
  const id = positiveId(requestId);
  if (!id) return null;
  const request = (await db.query(
    `SELECT claim_invitation_status
       FROM admin_flyer_requests WHERE id=$1`,
    [id]
  )).rows[0];
  if (!request) return null;
  const messages = (await db.query(
    `SELECT message_kind,status
       FROM admin_flyer_request_messages
      WHERE flyer_request_id=$1 AND message_kind IN ('live','pilot_publish')
        AND event_id IS NOT NULL`,
    [id]
  )).rows;
  const statusByKind = new Map(messages.map(row => [row.message_kind, row.status]));
  const liveStatus = statusByKind.get('live') || 'pending';
  const pilotStatus = statusByKind.get('pilot_publish') || 'pending';
  const welcomeStatus = request.claim_invitation_status || 'pending';
  return {
    liveSms: { status: liveStatus },
    pilotSms: { status: pilotStatus },
    claimInvitation: { status: welcomeStatus },
    // The pilot copy is an internal operational convenience and must never
    // make the recipient's successful publication look incomplete.
    retryNeeded: liveStatus !== 'sent' || !['sent', 'not_needed'].includes(welcomeStatus)
  };
}

async function processFlyerPublicationNotifications(requestId, { force = false, db = pool } = {}) {
  const id = positiveId(requestId);
  if (!id) return null;
  const messages = (await db.query(
    `SELECT id FROM admin_flyer_request_messages
      WHERE flyer_request_id=$1 AND message_kind IN ('live','pilot_publish')
        AND event_id IS NOT NULL
      ORDER BY id`,
    [id]
  )).rows;
  for (const message of messages) {
    await processSmsDelivery(message.id, { force, db });
  }
  await processWelcomeDelivery(id, { force, db });
  return publicationDeliveryState(id, { db });
}

function queueFlyerPublicationNotifications(requestId, { force = true } = {}) {
  const id = positiveId(requestId);
  if (!id) return;
  const work = new Promise(resolve => setImmediate(resolve))
    .then(() => processFlyerPublicationNotifications(id, { force }))
    .catch(error => {
      console.error('[flyer-publication] immediate delivery pass failed:', cleanError(error));
    })
    .finally(() => backgroundWork.delete(work));
  backgroundWork.add(work);
}

async function settleFlyerPublicationNotificationWork() {
  while (backgroundWork.size) await Promise.allSettled([...backgroundWork]);
}

async function runFlyerPublicationNotificationPass() {
  if (running) return;
  running = true;
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT request_id FROM (
         SELECT flyer_request_id AS request_id
           FROM admin_flyer_request_messages
          WHERE message_kind IN ('live','pilot_publish')
            AND event_id IS NOT NULL
            AND (
              (status IN ('pending','failed') AND
               (next_attempt_at IS NULL OR next_attempt_at<=NOW()))
              OR
              (status='sending' AND
               COALESCE(last_attempt_at,created_at)<NOW() - ($1::int * INTERVAL '1 minute'))
            )
         UNION
         SELECT flyer_request_id AS request_id
           FROM admin_done_for_you_welcome_deliveries
          WHERE (status IN ('pending','failed') AND
                 (next_attempt_at IS NULL OR next_attempt_at<=NOW()))
             OR (status='sending' AND
                 COALESCE(last_attempt_at,created_at)<NOW() - ($1::int * INTERVAL '1 minute'))
       ) due
       ORDER BY request_id
       LIMIT 100`,
      [SENDING_LEASE_MINUTES]
    );
    for (const row of rows) {
      await processFlyerPublicationNotifications(row.request_id, { force: false });
    }
  } catch (error) {
    console.error('[flyer-publication] retry pass failed:', cleanError(error));
  } finally {
    running = false;
  }
}

function startFlyerPublicationNotificationCron() {
  cron.schedule('* * * * *', () => runFlyerPublicationNotificationPass());
  const initial = setTimeout(() => runFlyerPublicationNotificationPass(), 2500);
  initial.unref?.();
  console.log('[flyer-publication] minute retry cron scheduled');
}

function setFlyerPublicationWelcomeSenderForTests(sender = sendDoneForYouWelcome) {
  deliverFlyerWelcome = sender;
}

module.exports = {
  PILOT_PUBLISH_PHONE,
  RETRY_BASE_SECONDS,
  RETRY_MAX_SECONDS,
  enqueueFlyerPublicationNotifications,
  processFlyerPublicationNotifications,
  publicationDeliveryState,
  queueFlyerPublicationNotifications,
  retryDelaySeconds,
  runFlyerPublicationNotificationPass,
  setFlyerPublicationWelcomeSenderForTests,
  settleFlyerPublicationNotificationWork,
  startFlyerPublicationNotificationCron
};
