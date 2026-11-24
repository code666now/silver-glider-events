'use strict';

const { createHash } = require('node:crypto');
const sms = require('../sms');
const { isWelcomeSmsDestination } = require('../sms-welcome');
const { assertSingleSegmentMessage } = require('../sms-lifecycle');
const { eventEndAtSql } = require('../post-event');
const { isMakeOutRoomEvent, PILOT } = require('./make-out-room');

const CONSENT_VERSION = 'transit_ride_reminder_v1';
const RIDE_SMS_CONSENT = 'Text me one reminder for this event. No marketing texts. Msg & data rates may apply. Reply STOP to opt out.';
const MINUTE = 60_000;
const REMINDER_LEAD = 30 * MINUTE;
const MAX_LATENESS = 5 * MINUTE;
const MAX_DATA_AGE = 12 * 60 * MINUTE;
const BUDGET_LOCK = 'transit-ride-reminder-budget-v1';
const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: PILOT.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
const TIME_FORMAT = new Intl.DateTimeFormat('en-US', { timeZone: PILOT.timezone, hour: 'numeric', minute: '2-digit' });

class RideReminderError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'RideReminderError';
    this.code = code;
    this.status = status;
  }
}

const changeRequired = () => new RideReminderError('schedule-changed', 'The ride time changed or could not be verified. Check the schedule again.', 409);
const budgetExhausted = () => new RideReminderError('budget-exhausted', 'Ride texts are fully booked. You can still plan your trip here.', 409);
const notGoing = () => new RideReminderError('not-eligible', 'This reminder is only for verified guests going to an eligible event.', 403);
const reminderLock = (eventId, userId) => `transit-ride-reminder:${eventId}:${userId}`;
const phoneLock = phone => `transit-ride-stop:${createHash('sha256').update(phone).digest('hex')}`;

function limits(env) {
  const cap = name => {
    const raw = String(env[name] || '');
    return /^\d{1,6}$/.test(raw) ? Number(raw) : 0;
  };
  return { day: cap('TRANSIT_SMS_DAILY_SEGMENT_CAP'), total: cap('TRANSIT_SMS_LIFETIME_SEGMENT_CAP') };
}

function enabled(env) {
  const { day, total } = limits(env);
  return env.TRANSIT_RIDE_REMINDERS_ENABLED === 'true' && day > 0 && total > 0;
}

function validId(id) {
  return typeof id === 'number' && Number.isInteger(id) && id > 0 && id <= 2147483647;
}

function usageDay(ms) {
  const parts = Object.fromEntries(DAY_FORMAT.formatToParts(ms).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function cleanSelection(value) {
  const selection = {};
  const keys = ['stopId', 'routeId', 'direction', 'headsign', 'stationId', 'destinationStationId'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw changeRequired();
  for (const key of keys) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || value[key].length > 256 || /[\u0000-\u001f\u007f]/u.test(value[key])) throw changeRequired();
    selection[key] = value[key];
  }
  if (selection.stationId) {
    if (!selection.destinationStationId) throw changeRequired();
    return { stationId: selection.stationId, destinationStationId: selection.destinationStationId };
  }
  if (!selection.routeId || !selection.stopId) throw changeRequired();
  return selection;
}

function checkedRide(result, now) {
  if (result?.status !== 'scheduled' || result.timing !== 'scheduled'
      || !Number.isSafeInteger(result.leaveByAt) || result.leaveByAt <= now
      || !Number.isSafeInteger(result.fetchedAt) || result.fetchedAt > now || now - result.fetchedAt > MAX_DATA_AGE) return null;
  return { leaveByAt: result.leaveByAt, reminderAt: result.leaveByAt - REMINDER_LEAD };
}

function buildRideReminderMessage({ slug, leaveByAt }) {
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(String(slug)) || !Number.isSafeInteger(leaveByAt)) throw changeRequired();
  const time = TIME_FORMAT.format(leaveByAt).replace(/\s+/g, ' ');
  const url = `https://silvergliderevents.com/e/${slug}/getting-home?from=text`;
  const body = `Silver Glider: Leave by ${time} for your ride. ${url} Reply STOP to opt out.`;
  assertSingleSegmentMessage(body);
  return body;
}

async function withTransaction(pool, fn, borrowed = false) {
  const client = borrowed ? pool : await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (!borrowed) client.release();
  }
}

async function xactLock(db, key) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

async function addStop(db, phone) {
  await db.query(`INSERT INTO transit_ride_sms_optouts (phone_e164) VALUES ($1) ON CONFLICT DO NOTHING`, [phone]);
  await db.query(`UPDATE transit_ride_reminders rr SET status='cancelled',outcome='phone-opted-out',selection=NULL
    WHERE rr.status='pending' AND (
      EXISTS (SELECT 1 FROM user_identities p WHERE p.id=rr.phone_identity_id AND p.normalized_value=$1)
      OR EXISTS (SELECT 1 FROM sms_notification_recipients p WHERE p.id=rr.event_phone_proof_id AND p.recipient=$1)
    )`, [phone]);
}

async function recordRideSmsOptOut(pool, rawPhone) {
  if (!isWelcomeSmsDestination(rawPhone)) return false;
  const phone = sms.normalizeE164(rawPhone);
  await withTransaction(pool, async db => {
    await xactLock(db, phoneLock(phone));
    await addStop(db, phone);
  });
  return true;
}

async function readCurrent(db, { eventId, userId, rsvpId = null }, lock = false) {
  const event = (await db.query(`SELECT e.*, ${eventEndAtSql('e')} AS ends_at FROM events e
    JOIN organizers h ON h.id=e.organizer_id JOIN users host ON host.id=h.user_id
    WHERE e.id=$1 AND e.timezone=$2 AND host.account_status='active'${lock ? ' FOR SHARE OF e,h,host' : ''}`, [eventId, PILOT.timezone])).rows[0];
  if (!isMakeOutRoomEvent(event) || event.timezone !== PILOT.timezone) return null;
  const rsvp = (await db.query(`SELECT r.id,r.phone FROM rsvps r JOIN users guest ON guest.id=r.user_id
    WHERE r.event_id=$1 AND r.user_id=$2 AND r.status='confirmed' AND guest.account_status='active'
      AND ($3::int IS NULL OR r.id=$3)
    ORDER BY r.id DESC LIMIT 1${lock ? ' FOR SHARE OF r,guest' : ''}`, [eventId, userId, rsvpId])).rows[0];
  if (!rsvp) return null;
  // An unverified contact number is never a credential. The old RSVP grant
  // only proves the recipient actually used that exact number's SMS link.
  const identity = (await db.query(`SELECT id,normalized_value AS phone FROM user_identities
    WHERE user_id=$1 AND identity_type='phone' AND verification_scope='account'
      AND verified_at IS NOT NULL AND revoked_at IS NULL
    ORDER BY is_primary DESC,id LIMIT 1${lock ? ' FOR SHARE' : ''}`, [userId])).rows[0];
  const proof = !identity && rsvp.phone ? (await db.query(`SELECT id,recipient AS phone FROM sms_notification_recipients
    WHERE rsvp_id=$1 AND recipient=$2 AND accessed_at IS NOT NULL
    ORDER BY accessed_at DESC,id LIMIT 1${lock ? ' FOR SHARE' : ''}`, [rsvp.id, rsvp.phone])).rows[0] : null;
  const phone = identity?.phone || proof?.phone;
  return {
    event,
    rsvpId: Number(rsvp.id),
    phone: isWelcomeSmsDestination(phone) ? phone : null,
    identityId: identity?.id ?? null,
    proofId: proof?.id ?? null
  };
}

async function hasStop(db, phone) {
  return Boolean((await db.query('SELECT 1 FROM transit_ride_sms_optouts WHERE phone_e164=$1', [phone])).rowCount);
}

function sameEvent(a, b) {
  const fields = ['organizer_id', 'slug', 'status', 'visibility', 'timezone', 'event_date', 'start_time', 'end_time',
    'venue_name', 'venue_address', 'venue_city', 'venue_state', 'updated_at'];
  return fields.every(key => String(a?.[key]) === String(b?.[key]));
}

function sameRecipient(current, stored) {
  return current?.phone && current.rsvpId === Number(stored.rsvp_id)
    && String(current.identityId) === String(stored.phone_identity_id)
    && String(current.proofId) === String(stored.event_phone_proof_id);
}

async function hasBudget(db, date, now, caps, includeReservations) {
  const spent = (await db.query(`SELECT COALESCE(SUM(attempted_segments),0)::int AS total,
    COALESCE(SUM(attempted_segments) FILTER (WHERE usage_day=$1::date),0)::int AS today
    FROM transit_ride_sms_usage`, [date])).rows[0];
  const slots = includeReservations ? (await db.query(`SELECT COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE (reminder_at AT TIME ZONE $2)::date=$1::date)::int AS today
    FROM transit_ride_reminders WHERE status='pending' AND reminder_at > $3`,
  [date, PILOT.timezone, new Date(now - MAX_LATENESS)])).rows[0] : { total: 0, today: 0 };
  return spent.total + slots.total < caps.total && spent.today + slots.today < caps.day;
}

function receipt(row, canRequest = false) {
  if (!row) return { status: canRequest ? 'available' : 'unavailable', canRequest };
  return {
    status: row.status,
    ...(row.status === 'pending' && { reminderAt: new Date(row.reminder_at).getTime() }),
    canRequest: canRequest && row.status === 'cancelled' && !row.attempted_at,
    canCancel: row.status === 'pending'
  };
}

function createRideReminders({ pool, getDeparture, env = process.env, now = Date.now, sendSms = sms.sendSms } = {}) {
  function checkIds(eventId, userId) {
    if (!validId(eventId) || !validId(userId)) throw notGoing();
  }

  async function getStatus({ eventId, userId }) {
    checkIds(eventId, userId);
    const current = await readCurrent(pool, { eventId, userId });
    if (!current) throw notGoing();
    const row = (await pool.query(`SELECT status,reminder_at,attempted_at FROM transit_ride_reminders
      WHERE event_id=$1 AND user_id=$2`, [eventId, userId])).rows[0];
    const active = enabled(env);
    const canRequest = active && current.phone && !await hasStop(pool, current.phone);
    if (row) return receipt(row, Boolean(canRequest));
    if (!active) return { status: 'unavailable', canRequest: false };
    if (!current.phone) return { status: 'verification-required', canRequest: false };
    return { status: canRequest ? 'available' : 'opted-out', canRequest: Boolean(canRequest) };
  }

  async function schedule({ eventId, userId, selection: raw, consent, expectedReminderAt }) {
    checkIds(eventId, userId);
    if (!enabled(env)) throw new RideReminderError('unavailable', 'Ride texts are not available for this event.', 503);
    if (consent !== true) throw new RideReminderError('consent-required', 'Choose whether to receive one text for this event.');
    const selection = cleanSelection(raw);
    const before = await readCurrent(pool, { eventId, userId });
    if (!before) throw notGoing();
    if (!before.phone) throw new RideReminderError('verification-required', 'A verified US phone is needed to request a ride text.', 403);
    let planned;
    try { planned = checkedRide(await getDeparture(before.event, selection), now()); }
    catch (_) { throw changeRequired(); }
    if (!planned || planned.reminderAt !== expectedReminderAt || planned.reminderAt <= now()) throw changeRequired();
    buildRideReminderMessage({ slug: before.event.slug, leaveByAt: planned.leaveByAt });
    return withTransaction(pool, async db => {
      await xactLock(db, phoneLock(before.phone));
      await xactLock(db, reminderLock(eventId, userId));
      const current = await readCurrent(db, { eventId, userId, rsvpId: before.rsvpId }, true);
      if (!current || current.phone !== before.phone || !sameEvent(current.event, before.event)) throw changeRequired();
      if (await hasStop(db, current.phone)) throw new RideReminderError('opted-out', 'Texts are turned off for this phone.', 409);
      const existing = (await db.query('SELECT * FROM transit_ride_reminders WHERE event_id=$1 AND user_id=$2 FOR UPDATE', [eventId, userId])).rows[0];
      if (existing && (existing.status !== 'cancelled' || existing.attempted_at)) return receipt(existing);
      await xactLock(db, BUDGET_LOCK);
      if (!enabled(env) || !await hasBudget(db, usageDay(planned.reminderAt), now(), limits(env), true)) throw budgetExhausted();
      if (planned.reminderAt <= now()) throw changeRequired();
      let row;
      try {
        row = (await db.query(`INSERT INTO transit_ride_reminders
          (event_id,user_id,rsvp_id,phone_identity_id,event_phone_proof_id,selection,reminder_at,leave_by_at,consent_version,consented_at,status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
          ON CONFLICT (event_id,user_id) DO UPDATE SET rsvp_id=EXCLUDED.rsvp_id,
            phone_identity_id=EXCLUDED.phone_identity_id,event_phone_proof_id=EXCLUDED.event_phone_proof_id,
            selection=EXCLUDED.selection,reminder_at=EXCLUDED.reminder_at,leave_by_at=EXCLUDED.leave_by_at,
            consent_version=EXCLUDED.consent_version,consented_at=EXCLUDED.consented_at,
            request_id=gen_random_uuid(),status='pending',outcome=NULL
          WHERE transit_ride_reminders.status='cancelled' AND transit_ride_reminders.attempted_at IS NULL
          RETURNING status,reminder_at,attempted_at`,
        [eventId, userId, current.rsvpId, current.identityId, current.proofId, JSON.stringify(selection), new Date(planned.reminderAt), new Date(planned.leaveByAt), CONSENT_VERSION, new Date(now())])).rows[0];
      } catch (error) {
        if (error.code === '23505') throw new RideReminderError('already-requested', 'A ride reminder already exists for this phone and event.', 409);
        throw error;
      }
      return receipt(row);
    });
  }

  async function cancel({ eventId, userId }) {
    checkIds(eventId, userId);
    return withTransaction(pool, async db => {
      await xactLock(db, reminderLock(eventId, userId));
      await db.query(`UPDATE transit_ride_reminders SET status='cancelled',outcome='guest-cancelled',selection=NULL
        WHERE event_id=$1 AND user_id=$2 AND status='pending'`, [eventId, userId]);
      return receipt((await db.query('SELECT status,reminder_at,attempted_at FROM transit_ride_reminders WHERE event_id=$1 AND user_id=$2', [eventId, userId])).rows[0]);
    });
  }

  const changeState = (db, row, status, outcome) => db.query(`UPDATE transit_ride_reminders
    SET status=$3,outcome=$4,selection=NULL WHERE id=$1 AND request_id=$2 AND status='pending'`,
  [row.id, row.request_id, status, outcome]);

  async function deliver(row) {
    const ids = { eventId: Number(row.event_id), userId: Number(row.user_id), rsvpId: Number(row.rsvp_id) };
    if (row.consent_version !== CONSENT_VERSION || !row.consented_at) return changeState(pool, row, 'cancelled', 'no-consent');
    const before = await readCurrent(pool, ids);
    if (!sameRecipient(before, row)) return changeState(pool, row, 'cancelled', 'recipient-changed');
    let ride;
    let body;
    try {
      ride = checkedRide(await getDeparture(before.event, cleanSelection(row.selection)), now());
      if (!ride || ride.leaveByAt !== new Date(row.leave_by_at).getTime() || ride.reminderAt !== new Date(row.reminder_at).getTime()) {
        return changeState(pool, row, 'cancelled', 'schedule-changed');
      }
      body = buildRideReminderMessage({ slug: before.event.slug, leaveByAt: ride.leaveByAt });
    } catch (_) {
      return changeState(pool, row, 'cancelled', 'schedule-unavailable');
    }
    const client = await pool.connect();
    const locks = [phoneLock(before.phone), reminderLock(ids.eventId, ids.userId)];
    let acquired = 0;
    let releaseError;
    try {
      for (const key of locks) {
        await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
        acquired++;
      }
      const claimed = await withTransaction(client, async db => {
        const fresh = await readCurrent(db, ids, true);
        if (!sameRecipient(fresh, row) || fresh.phone !== before.phone || !sameEvent(fresh.event, before.event) || await hasStop(db, before.phone)) {
          await changeState(db, row, 'cancelled', 'no-longer-eligible');
          return false;
        }
        await xactLock(db, BUDGET_LOCK);
        if (!enabled(env)) return false;
        const at = now();
        if (at < ride.reminderAt) return false;
        if (at - ride.reminderAt > MAX_LATENESS) {
          await changeState(db, row, 'cancelled', 'missed-window');
          return false;
        }
        const date = usageDay(at);
        // A delayed reminder must not take a slot reserved on the next day.
        if (date !== usageDay(ride.reminderAt)) {
          await changeState(db, row, 'cancelled', 'missed-window');
          return false;
        }
        if (!await hasBudget(db, date, at, limits(env), false)) {
          await changeState(db, row, 'failed', 'budget-exhausted');
          return false;
        }
        const attempt = await db.query(`UPDATE transit_ride_reminders SET status='sending',selection=NULL,attempted_at=$3
          WHERE id=$1 AND request_id=$2 AND status='pending' RETURNING id`, [row.id, row.request_id, new Date(at)]);
        if (!attempt.rowCount) return false;
        await db.query(`INSERT INTO transit_ride_sms_usage (usage_day,attempted_segments) VALUES ($1,1)
          ON CONFLICT (usage_day) DO UPDATE SET attempted_segments=transit_ride_sms_usage.attempted_segments+1`, [date]);
        return true; // durable before calling the provider; a crash cannot requeue
      }, true);
      if (!claimed) return;

      await withTransaction(client, async db => {
        // Keep the live RSVP/event/phone rows locked for the bounded provider
        // call; consent and STOP for this phone use the same advisory locks.
        const fresh = await readCurrent(db, ids, true);
        let outcome = 'no-longer-eligible';
        let status = 'failed';
        let sid = null;
        const at = now();
        if (enabled(env) && at >= ride.reminderAt && at - ride.reminderAt <= MAX_LATENESS && sameRecipient(fresh, row)
            && fresh.phone === before.phone && sameEvent(fresh.event, before.event) && !await hasStop(db, before.phone)) {
          try {
            const result = await sendSms({ to: before.phone, body, validityPeriod: 300 });
            if (!/^(SM|MM)[\da-f]{32}$/i.test(String(result?.sid))) {
              status = 'unknown';
              outcome = 'acceptance-unknown';
            } else if (['failed', 'undelivered', 'canceled', 'cancelled'].includes(result.status)) {
              sid = result.sid;
              status = 'failed';
              outcome = 'provider-failed';
            } else {
              sid = result.sid;
              status = 'sent';
              outcome = 'provider-accepted';
            }
          } catch (error) {
            if (Number(error?.providerCode) === 21610) {
              await addStop(db, before.phone);
              outcome = 'provider-opt-out';
            } else if (['not_sent', 'rejected'].includes(error?.acceptance)) {
              outcome = 'provider-rejected';
            } else {
              status = 'unknown';
              outcome = 'acceptance-unknown';
            }
          }
        }
        await db.query(`UPDATE transit_ride_reminders SET status=$2,outcome=$3,provider_message_sid=$4,
          sent_at=CASE WHEN $2='sent' THEN $5::timestamptz ELSE NULL END WHERE id=$1 AND status='sending'`,
        [row.id, status, outcome, sid, new Date(now())]);
      }, true);
    } finally {
      while (acquired > 0) {
        try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [locks[--acquired]]); }
        catch (error) { releaseError = error; }
      }
      client.release(releaseError);
    }
  }

  async function processDue() {
    if (!enabled(env)) return 0;
    const at = now();
    await pool.query(`UPDATE transit_ride_reminders SET status='unknown',outcome='acceptance-unknown'
      WHERE status='sending' AND attempted_at < $1`, [new Date(at - 15 * MINUTE)]);
    await pool.query(`UPDATE transit_ride_reminders SET status='cancelled',outcome='missed-window',selection=NULL
      WHERE status='pending' AND reminder_at < $1`, [new Date(at - MAX_LATENESS)]);
    const due = (await pool.query(`SELECT * FROM transit_ride_reminders
      WHERE status='pending' AND reminder_at <= $1 ORDER BY reminder_at,id LIMIT 20`, [new Date(at)])).rows;
    for (const row of due) await deliver(row);
    return due.length;
  }

  return { getStatus, schedule, cancel, processDue };
}

module.exports = {
  createRideReminders, recordRideSmsOptOut, buildRideReminderMessage, RideReminderError, CONSENT_VERSION, RIDE_SMS_CONSENT
};
