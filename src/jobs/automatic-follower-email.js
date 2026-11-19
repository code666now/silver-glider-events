const cron = require('node-cron');
const { isDeepStrictEqual } = require('node:util');
const pool = require('../config/db');
const mailer = require('../lib/mailer');
const { eligibleEmailRecipients } = require('../lib/follow-announcement');
const { signOptout } = require('../lib/followers');
const { withActiveHostAccount } = require('../lib/outbound-account-status');

const MAX_ATTEMPTS = 3;
const COALESCE_MS = 2 * 60 * 1000;
const RETRY_MS = 2 * 60 * 1000;
const BOUNDARY_MS = 20 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const millis = value => new Date(value).getTime();
const normalizeEmail = value => String(value || '').trim().toLowerCase();

async function transaction(client, work) {
  await client.query('BEGIN');
  try {
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function lockContext(client, eventIds, organizerId, now, { lockHost = true } = {}) {
  // Match publisher and manual/invitation approval order: event(s) by ID
  // first, then the organizer. Never acquire more event locks after the host.
  const { rows: events } = await client.query(
    `SELECT e.*,
            (e.event_date + e.start_time) AT TIME ZONE COALESCE(
              (SELECT name FROM pg_timezone_names WHERE name=e.timezone), 'America/Los_Angeles') AS starts_at
       FROM events e WHERE e.id=ANY($1::int[]) AND e.organizer_id=$2
       ORDER BY e.id FOR UPDATE OF e`, [eventIds, organizerId]
  );
  const { rows: [host] } = await client.query(
    `SELECT host.auto_follower_email,host.auto_follower_email_disabled_at,
            COALESCE(NULLIF(BTRIM(host.org_name),''),NULLIF(BTRIM(host.name),''),'Silver Glider Events') AS label,
            host.email, account.account_status,
            (($2::timestamptz AT TIME ZONE host.auto_follower_email_timezone)::date)::text AS local_day,
            (($2::timestamptz AT TIME ZONE host.auto_follower_email_timezone)::date + 1)::timestamp
              AT TIME ZONE host.auto_follower_email_timezone AS next_day
       FROM organizers host JOIN users account ON account.id=host.user_id
      WHERE host.id=$1${lockHost ? ' FOR NO KEY UPDATE OF host' : ''}`, [organizerId, now]
  );
  const { rows: jobs } = await client.query(
    `SELECT job.*,job.created_at <= host.auto_follower_email_disabled_at AS before_disable
       FROM automatic_follower_email_events job JOIN organizers host ON host.id=job.organizer_id
      WHERE job.organizer_id=$1 AND job.event_id=ANY($2::int[])`,
    [organizerId, eventIds]
  );
  return { host, events: new Map(events.map(event => [event.id, event])), jobs };
}

function jobSkipReason(job, event, host, now) {
  if (job.status === 'skipped') return job.skip_reason || 'event_unavailable';
  if (!host || host.account_status !== 'active' || !host.auto_follower_email || !host.local_day || job.before_disable) {
    return 'host_unavailable_or_opted_out';
  }
  if (!event || event.status !== 'published' || event.visibility !== 'public' ||
      event.secret_show_enabled || event.archived_at || event.skip_follower_email) return 'event_unavailable';
  if (!(millis(event.starts_at) > millis(now))) return 'event_started';
  return null;
}

async function skipUnassigned(client, job, reason) {
  await client.query(
    `UPDATE automatic_follower_email_events SET status='skipped',skip_reason=COALESCE(skip_reason,$2)
      WHERE event_id=$1 AND status IN ('pending','reserved','skipped')`, [job.event_id, reason]
  );
  // Keep the scheduled timestamp on terminal unassigned logs for accurate
  // result counts. Only pending rows can be picked up again.
  await client.query(
    `UPDATE message_log SET status='failed',error=$2
      WHERE event_id=$1 AND status='pending' AND automatic_follower_email_next_at IS NOT NULL`,
    [job.event_id, reason]
  );
}

async function recipientEligibleForAccount(client, recipientUserId) {
  if (!recipientUserId) return true; // legacy opted-in guests can have no linked account
  return Boolean((await client.query(
    `SELECT 1 FROM users WHERE id=$1 AND account_status='active'`, [recipientUserId]
  )).rowCount);
}

async function reserveAudience(client, job, now) {
  const audience = await eligibleEmailRecipients(client, job.organizer_id, job.event_id);
  const canonicalIds = audience.map(row => row.user_id).filter(Boolean);
  const active = new Set((await client.query(
    `SELECT id FROM users WHERE id=ANY($1::int[]) AND account_status='active'`, [canonicalIds]
  )).rows.map(row => Number(row.id)));
  const users = new Set();
  const addresses = new Set();
  const inactiveAddresses = new Set(audience.filter(row => row.user_id && !active.has(Number(row.user_id)))
    .map(row => normalizeEmail(row.email)));
  const selected = [];
  // Prefer known canonical identities on address collisions but never infer a
  // canonical identity from a bare guest email.
  for (const row of audience.sort((a, b) => Number(Boolean(b.user_id)) - Number(Boolean(a.user_id)))) {
    const userId = row.user_id ? Number(row.user_id) : null;
    const email = normalizeEmail(row.email);
    if (!EMAIL.test(email) || inactiveAddresses.has(email) || addresses.has(email) || (userId && users.has(userId))) continue;
    if (userId) users.add(userId);
    addresses.add(email);
    selected.push({ email, userId });
  }
  await client.query(
    `INSERT INTO message_log (event_id, recipient, recipient_user_id, message_type, channel, status,
                              automatic_follower_email_next_at, created_at)
     SELECT $1, input.email, input.user_id, 'announcement', 'email', 'pending', $2, $2
       FROM UNNEST($3::text[],$4::int[]) AS input(email,user_id)`,
    [job.event_id, now, selected.map(row => row.email), selected.map(row => row.userId)]
  );
  await client.query(
    `UPDATE automatic_follower_email_events SET status=$2 WHERE event_id=$1 AND status='pending'`,
    [job.event_id, selected.length ? 'reserved' : 'complete']
  );
}

function coalescingDeadline(ready, upcoming, events, now) {
  if (!ready.length || ready.some(job => job.send_now_at)) return 0;
  const cutoff = Math.min(...ready.map(job => millis(job.available_at))) + COALESCE_MS;
  const near = upcoming.filter(job => millis(job.available_at) <= cutoff);
  if (!near.length) return 0;
  const deadline = Math.max(...near.map(job => millis(job.available_at)));
  const earliestStart = Math.min(...[...ready, ...near].map(job => millis(events.get(job.event_id).starts_at)));
  return deadline > millis(now) && earliestStart > deadline + BOUNDARY_MS ? deadline : 0;
}

async function updateCompleted(client, eventIds) {
  await client.query(
    `UPDATE automatic_follower_email_events job SET status='complete'
      WHERE job.event_id=ANY($1::int[]) AND job.status='reserved'
        AND NOT EXISTS (SELECT 1 FROM message_log log WHERE log.event_id=job.event_id AND log.status='pending'
                      AND (log.automatic_follower_email_next_at IS NOT NULL OR log.automatic_follower_email_delivery_id IS NOT NULL))`,
    [eventIds]
  );
}

async function prepareHost(organizerId, now) {
  const client = await pool.connect();
  try {
    return await transaction(client, async () => {
      const candidateIds = (await client.query(
        `SELECT job.event_id FROM automatic_follower_email_events job
          WHERE job.organizer_id=$1 AND (
            (job.status='pending' AND job.available_at <= $2::timestamptz + INTERVAL '2 minutes')
            OR (job.status IN ('reserved','skipped') AND EXISTS (
              SELECT 1 FROM message_log log WHERE log.event_id=job.event_id AND log.status='pending'
                AND log.automatic_follower_email_next_at <= $2)))`, [organizerId, now]
      )).rows.map(row => row.event_id);
      if (!candidateIds.length) return 0;
      const { host, events, jobs } = await lockContext(client, candidateIds, organizerId, now);
      const ready = [];
      const upcoming = [];
      const validIds = [];
      for (const job of jobs) {
        if (job.status === 'complete') continue;
        const reason = jobSkipReason(job, events.get(job.event_id), host, now);
        if (reason) {
          await skipUnassigned(client, job, reason);
          continue;
        }
        validIds.push(job.event_id);
        if (job.status === 'pending') (millis(job.available_at) <= millis(now) ? ready : upcoming).push(job);
      }
      if (!validIds.length) return 0;
      if (!coalescingDeadline(ready, upcoming, events, now)) {
        for (const job of ready) await reserveAudience(client, job, now);
      }

      const { rows: members } = await client.query(
        `SELECT id,event_id,recipient,recipient_user_id FROM message_log
          WHERE event_id=ANY($1::int[]) AND status='pending' AND automatic_follower_email_next_at <= $2
          ORDER BY recipient, recipient_user_id NULLS LAST, event_id,id`, [validIds, now]
      );
      const byAddress = new Map();
      for (const member of members) {
        if (!byAddress.has(member.recipient)) byAddress.set(member.recipient, []);
        byAddress.get(member.recipient).push(member);
      }
      let prepared = 0;
      for (const [recipient, memberships] of byAddress) {
        const userIds = [...new Set(memberships.map(member => member.recipient_user_id).filter(Boolean))];
        // The same physical address gets one email. Never combine conflicting
        // identities at that address; their rows fail closed instead.
        const userId = userIds.length === 1 ? userIds[0] : null;
        if (userIds.length > 1) {
          await client.query(
            `UPDATE message_log SET status='failed',error='recipient_identity_conflict'
              WHERE id=ANY($1::int[])`, [memberships.map(member => member.id)]
          );
          continue;
        }
        const { rows: [delivery] } = await client.query(
          `INSERT INTO automatic_follower_email_deliveries (organizer_id,recipient,recipient_user_id,local_day,next_attempt_at,created_at)
           VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT DO NOTHING RETURNING id`,
          [organizerId, recipient, userId, host.local_day, now]
        );
        if (delivery) {
          await client.query(
            `UPDATE message_log SET automatic_follower_email_next_at=NULL,automatic_follower_email_delivery_id=$2
              WHERE id=ANY($1::int[])`, [memberships.map(member => member.id), delivery.id]
          );
          prepared++;
        } else {
          const deferred = memberships.filter(member => millis(events.get(member.event_id).starts_at) > millis(host.next_day));
          const deferredIds = deferred.map(member => member.id);
          await client.query(
            `UPDATE message_log SET automatic_follower_email_next_at=$2 WHERE id=ANY($1::int[])`,
            [deferredIds, host.next_day]
          );
          await client.query(
            `UPDATE message_log SET status='failed',error='event_starts_before_next_email_day'
              WHERE id=ANY($1::int[]) AND NOT (id=ANY($2::int[]))`,
            [memberships.map(member => member.id), deferredIds]
          );
        }
      }
      await updateCompleted(client, candidateIds);
      return prepared;
    });
  } finally {
    client.release();
  }
}

async function lockDelivery(client, id, organizerId, now, contextOptions) {
  const eventIds = (await client.query(
    `SELECT DISTINCT event_id FROM message_log WHERE automatic_follower_email_delivery_id=$1 AND status='pending'`, [id]
  )).rows.map(row => row.event_id);
  const context = await lockContext(client, eventIds, organizerId, now, contextOptions);
  const delivery = (await client.query(
    `SELECT *,local_day::text AS day_label FROM automatic_follower_email_deliveries
      WHERE id=$1 AND organizer_id=$2 FOR UPDATE`, [id, organizerId]
  )).rows[0];
  if (!delivery || !['pending','sending'].includes(delivery.status)) return null;
  const { rows: members } = await client.query(
    `SELECT id,event_id,recipient,recipient_user_id FROM message_log
      WHERE automatic_follower_email_delivery_id=$1 AND status='pending' ORDER BY event_id,id FOR UPDATE`, [id]
  );
  return { ...context, delivery, members, eventIds };
}

async function finishDelivery(client, context, status, now, providerId = null) {
  const { delivery, eventIds } = context;
  const logStatus = status === 'sent' ? 'sent' : 'failed';
  const reason = status === 'sent' ? null : status === 'unknown' ? 'automatic_delivery_unknown' : 'automatic_delivery_skipped';
  await client.query(
    `UPDATE automatic_follower_email_deliveries
        SET status=$2,payload=NULL,error=$3,next_attempt_at=NULL,
            sent_at=CASE WHEN $2='sent' THEN $4::timestamptz END,provider_id=$5 WHERE id=$1`,
    [delivery.id, status, reason, now, providerId]
  );
  await client.query(
    `UPDATE message_log SET status=$2,error=$3,automatic_follower_email_next_at=NULL,
            sent_at=CASE WHEN $2='sent' THEN $4::timestamptz END,provider_id=$5
      WHERE automatic_follower_email_delivery_id=$1 AND status='pending'`,
    [delivery.id, logStatus, reason, now, providerId]
  );
  await updateCompleted(client, eventIds);
  return status;
}

async function rollUnattemptedForward(client, context, nextAt, now) {
  const { delivery } = context;
  await client.query(
    `UPDATE message_log SET automatic_follower_email_delivery_id=NULL,automatic_follower_email_next_at=$2
      WHERE automatic_follower_email_delivery_id=$1 AND status='pending'`, [delivery.id, nextAt]
  );
  return finishDelivery(client, context, 'skipped', now);
}

async function evaluateDelivery(client, context, now) {
  const { host, events, jobs, delivery, members } = context;
  const valid = [];
  const invalid = [];
  const activeRecipient = EMAIL.test(delivery.recipient)
    && await recipientEligibleForAccount(client, delivery.recipient_user_id);
  const jobsByEvent = new Map(jobs.map(job => [job.event_id, job]));
  for (const member of members) {
    const job = jobsByEvent.get(member.event_id);
    const event = events.get(member.event_id);
    const reason = job ? jobSkipReason(job, event, host, now) : 'event_unavailable';
    if (reason && job) await skipUnassigned(client, job, reason);
    const eligible = !reason && activeRecipient && delivery.recipient === member.recipient &&
      (await eligibleEmailRecipients(client, delivery.organizer_id, member.event_id, {
        ignoreOwnAutoDeliveryId: delivery.id,
        recipient: member.recipient,
        recipientUserId: member.recipient_user_id
      })).some(candidate => normalizeEmail(candidate.email) === member.recipient &&
        Number(candidate.user_id || 0) === Number(member.recipient_user_id || 0));
    if (eligible) valid.push(event);
    else invalid.push(member);
  }
  if (!valid.length) return { payload: null, invalid, valid };
  valid.sort((a, b) => millis(a.starts_at) - millis(b.starts_at) || a.id - b.id);
  const baseUrl = String(process.env.APP_URL || 'https://silvergliderevents.com').replace(/\/$/, '');
  const payload = mailer.buildAutomaticFollowerEmail({
    events: valid,
    organizerLabel: host.label,
    replyTo: host.email,
    unsubscribeUrl: `${baseUrl}/unsubscribe?token=${signOptout(delivery.organizer_id, delivery.recipient)}`
  });
  return { payload: JSON.parse(JSON.stringify(payload)), invalid, valid };
}

function outcomeUnsent(delivery) {
  return delivery.attempt_count ? 'unknown' : 'skipped';
}

async function claimDelivery(client, row, now) {
  const context = await lockDelivery(client, row.id, row.organizer_id, now);
  if (!context) return null;
  const { delivery, host } = context;
  if (!delivery.next_attempt_at || millis(delivery.next_attempt_at) > millis(now)) return null;
  if (!context.members.length || !host?.local_day) return finishDelivery(client, context, outcomeUnsent(delivery), now);
  if (delivery.day_label !== host.local_day || millis(host.next_day) - millis(now) <= BOUNDARY_MS) {
    if (delivery.attempt_count) return finishDelivery(client, context, 'unknown', now);
    const nextAt = delivery.day_label === host.local_day ? host.next_day : now;
    return rollUnattemptedForward(client, context, nextAt, now);
  }
  if (delivery.attempt_count >= MAX_ATTEMPTS ||
      (delivery.first_attempt_at && millis(delivery.first_attempt_at) <= millis(now) - 23 * 60 * 60 * 1000)) {
    return finishDelivery(client, context, 'unknown', now);
  }
  const { payload, invalid } = await evaluateDelivery(client, context, now);
  if (!payload || (delivery.attempt_count && (invalid.length || !isDeepStrictEqual(payload, delivery.payload)))) {
    return finishDelivery(client, context, outcomeUnsent(delivery), now);
  }
  if (invalid.length) {
    await client.query(
      `UPDATE message_log SET status='failed',error='automatic_delivery_skipped'
        WHERE id=ANY($1::int[]) AND status='pending'`, [invalid.map(member => member.id)]
    );
    await updateCompleted(client, invalid.map(member => member.event_id));
  }
  const attempt = delivery.attempt_count + 1;
  await client.query(
    `UPDATE automatic_follower_email_deliveries SET status='sending',attempt_count=$2,
            first_attempt_at=COALESCE(first_attempt_at,$3),next_attempt_at=$4,payload=$5,error=NULL WHERE id=$1`,
    [row.id, attempt, now, new Date(millis(now) + RETRY_MS), payload]
  );
  return { attempt };
}

async function sendClaimedDelivery(client, row, claim, clock, sendDelivery) {
  const now = clock();
  // The organizer milestone trigger can write this host on ordinary publish.
  // Never hold an organizer row lock through provider I/O. The shared account
  // advisory lock still orders suspension/deletion against outbound delivery.
  const context = await lockDelivery(client, row.id, row.organizer_id, now, { lockHost: false });
  if (!context) return null;
  const { delivery, host } = context;
  if (delivery.status !== 'sending' || delivery.attempt_count !== claim.attempt) return null;
  if (!host || delivery.day_label !== host.local_day || millis(host.next_day) - millis(now) <= BOUNDARY_MS) {
    return finishDelivery(client, context, 'unknown', now);
  }
  // A committed claim precedes the provider call so a process crash cannot
  // reset the key/attempt. Recheck changed permissions and content after that
  // commit; lock event rows through the bounded provider request.
  const { payload, invalid, valid } = await evaluateDelivery(client, context, now);
  if (!payload || invalid.length || !isDeepStrictEqual(payload, delivery.payload)) {
    return finishDelivery(client, context, 'unknown', now);
  }
  const handoff = clock();
  if (millis(host.next_day) - millis(handoff) <= BOUNDARY_MS ||
      valid.some(event => millis(event.starts_at) <= millis(handoff))) {
    return finishDelivery(client, context, 'unknown', handoff);
  }
  let accepted;
  try {
    accepted = await sendDelivery({
      to: delivery.recipient, payload: delivery.payload, idempotencyKey: `sge-auto-follower-email-v1-${delivery.id}`
    });
    if (!accepted?.id && !(accepted?.dev === true && process.env.NODE_ENV !== 'production')) {
      throw new Error('Provider acceptance not confirmed');
    }
  } catch (_) {
    if (claim.attempt >= MAX_ATTEMPTS) return finishDelivery(client, context, 'unknown', now);
    await client.query(
      `UPDATE automatic_follower_email_deliveries SET status='pending',error='provider_acceptance_unconfirmed' WHERE id=$1`,
      [row.id]
    );
    return 'retry';
  }
  return finishDelivery(client, context, 'sent', clock(), accepted.id || null);
}

async function processDelivery(row, clock, sendDelivery) {
  const guarded = await withActiveHostAccount(pool, row.organizer_id, async client => {
    const claim = await transaction(client, () => claimDelivery(client, row, clock()));
    if (!claim?.attempt) return claim;
    return transaction(client, () => sendClaimedDelivery(client, row, claim, clock, sendDelivery));
  });
  if (guarded.allowed) return guarded.result;
  const client = await pool.connect();
  try {
    return await transaction(client, async () => {
      const now = clock();
      const context = await lockDelivery(client, row.id, row.organizer_id, now);
      if (!context) return null;
      for (const job of context.jobs) await skipUnassigned(client, job, 'host_unavailable_or_opted_out');
      return finishDelivery(client, context, outcomeUnsent(context.delivery), now);
    });
  } finally {
    client.release();
  }
}

async function runAutomaticFollowerEmailPass({ now, sendDelivery = mailer.sendAutomaticFollowerEmail } = {}) {
  const clock = now == null ? () => new Date() : () => new Date(now);
  const startedAt = clock();
  if (!Number.isFinite(millis(startedAt))) throw new Error('Invalid automatic email clock');
  const result = { prepared: 0, sent: 0, skipped: 0, unknown: 0, retry: 0 };
  const { rows: hosts } = await pool.query(
    `SELECT organizer_id FROM (
       SELECT organizer_id, available_at AS due_at FROM automatic_follower_email_events
        WHERE status='pending' AND available_at <= $1
       UNION ALL
       SELECT job.organizer_id,log.automatic_follower_email_next_at AS due_at FROM message_log log
         JOIN automatic_follower_email_events job ON job.event_id=log.event_id
        WHERE job.status IN ('reserved','skipped') AND log.status='pending' AND log.automatic_follower_email_next_at <= $1
     ) due GROUP BY organizer_id ORDER BY MIN(due_at),organizer_id LIMIT 30`, [startedAt]
  );
  for (const host of hosts) {
    try {
      result.prepared += await prepareHost(host.organizer_id, clock());
    } catch (_) {
      console.error('[automatic-follower-email] host queue preparation failed', { organizerId: host.organizer_id });
    }
  }
  const { rows: deliveries } = await pool.query(
    `SELECT id,organizer_id FROM automatic_follower_email_deliveries
      WHERE status IN ('pending','sending') AND next_attempt_at <= $1
      ORDER BY next_attempt_at,id LIMIT 100`, [clock()]
  );
  for (const delivery of deliveries) {
    try {
      const status = await processDelivery(delivery, clock, sendDelivery);
      if (status) result[status]++;
    } catch (_) {
      console.error('[automatic-follower-email] queue delivery failed', { deliveryId: delivery.id });
    }
  }
  return result;
}

function startAutomaticFollowerEmailCron() {
  let running = false;
  cron.schedule('* * * * *', async () => {
    if (running || process.env.AUTO_FOLLOWER_EMAIL_ENABLED !== 'true') return;
    running = true;
    try {
      await runAutomaticFollowerEmailPass();
    } catch (_) {
      console.error('[automatic-follower-email] pass failed');
    } finally {
      running = false;
    }
  });
}

module.exports = { runAutomaticFollowerEmailPass, startAutomaticFollowerEmailCron };
