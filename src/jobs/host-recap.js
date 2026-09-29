const cron = require('node-cron');
const pool = require('../config/db');
const { sendHostRecap } = require('../lib/mailer');
const { HOST_ACCOUNT_INACTIVE, withActiveHostAccount } = require('../lib/outbound-account-status');

let _running = false;

// The morning after an event, its host hears how the night went and gets one
// way into the next one. Sent once per event: the row is claimed before the
// email goes out, so two passes can never both send. A failed send releases
// the claim, and the window below gives it a few hours to retry.
const RECAP_HOURS = [10, 11, 12, 13];

// Only events with RSVPs get a recap; nobody needs "nobody came" in their inbox.
async function pendingRecapEvents(hour) {
  const { rows } = await pool.query(
    `SELECT e.id, e.title, e.slug, e.event_date, e.start_time, e.venue_name, e.venue_address,
            e.organizer_id, o.email AS host_email,
            COALESCE((SELECT COUNT(*) + COUNT(guest_first_name) FROM rsvps
                       WHERE event_id=e.id AND status='confirmed'), 0)::int AS total_attendance,
            COALESCE((SELECT COUNT(*) FROM rsvps r
                       WHERE r.event_id=e.id AND r.status='confirmed'
                         AND EXISTS (
                           SELECT 1 FROM rsvps prior
                            JOIN events prior_event ON prior_event.id=prior.event_id
                            WHERE prior_event.organizer_id=e.organizer_id
                              AND prior_event.id<>e.id
                              AND prior_event.event_date < e.event_date
                              AND prior.status='confirmed'
                              AND ((r.user_id IS NOT NULL AND prior.user_id=r.user_id)
                                   OR ((r.user_id IS NULL OR prior.user_id IS NULL)
                                       AND LOWER(TRIM(prior.email))=LOWER(TRIM(r.email))))
                         )), 0)::int AS returning_count,
            COALESCE((SELECT COUNT(*) FROM rsvps r
                       WHERE r.event_id=e.id AND r.status='confirmed'
                         AND EXISTS (
                           SELECT 1 FROM message_log ml
                            WHERE ml.event_id=e.id
                              AND ml.message_type='previous_guest_invite'
                              AND ml.status IN ('pending','sent')
                              AND ml.created_at <= r.created_at
                              AND ((ml.recipient_user_id IS NOT NULL AND ml.recipient_user_id=r.user_id)
                                   OR ((ml.recipient_user_id IS NULL OR r.user_id IS NULL)
                                       AND LOWER(TRIM(ml.recipient))=LOWER(TRIM(r.email))))
                         )), 0)::int AS invited_returning_count
       FROM events e
       JOIN organizers o ON o.id=e.organizer_id
      WHERE e.status='published'
        AND e.host_recap_sent_at IS NULL
        AND e.event_date = ((NOW() AT TIME ZONE e.timezone)::date - 1)
        AND EXTRACT(HOUR FROM (NOW() AT TIME ZONE e.timezone)) = $1
        AND NULLIF(TRIM(o.email), '') IS NOT NULL
        AND EXISTS (SELECT 1 FROM rsvps WHERE event_id=e.id AND status='confirmed')`,
    [hour]
  );
  return rows;
}

async function claimRecap(eventId) {
  const { rows } = await pool.query(
    `UPDATE events SET host_recap_sent_at=NOW()
      WHERE id=$1 AND host_recap_sent_at IS NULL
      RETURNING id`,
    [eventId]
  );
  return rows.length > 0;
}

async function releaseRecap(eventId) {
  await pool.query('UPDATE events SET host_recap_sent_at=NULL WHERE id=$1', [eventId]);
}

async function sendRecapFor(event) {
  if (!await claimRecap(event.id)) return false;
  try {
    const delivery = await withActiveHostAccount(
      pool,
      event.organizer_id,
      () => sendHostRecap({
        to: event.host_email,
        event,
        stats: {
          totalAttendance: event.total_attendance,
          returning: event.returning_count,
          fromInvites: event.invited_returning_count
        }
      })
    );
    // A suspended host keeps the claim: nothing is owed to them.
    if (!delivery.allowed) console.log(`[host-recap] skipped event ${event.id}: ${HOST_ACCOUNT_INACTIVE}`);
    return true;
  } catch (error) {
    console.error('[host-recap] send failed', { eventId: event.id, error: error.message });
    await releaseRecap(event.id).catch(() => {});
    return false;
  }
}

// `hours` is injectable so a test run can match the current wall clock.
async function runHostRecapPass({ hours = RECAP_HOURS } = {}) {
  if (_running) return 0;
  _running = true;
  let sent = 0;
  try {
    for (const hour of hours) {
      for (const event of await pendingRecapEvents(hour)) {
        if (await sendRecapFor(event)) sent += 1;
      }
    }
  } catch (error) {
    console.error('[host-recap] pass failed:', error.message);
  } finally {
    _running = false;
  }
  return sent;
}

function startHostRecapCron() {
  if (process.env.REMINDERS_ENABLED === 'false') {
    console.log('[host-recap] disabled via REMINDERS_ENABLED=false');
    return;
  }
  cron.schedule('5 * * * *', () => runHostRecapPass());
  console.log('[host-recap] hourly cron scheduled (morning after, event-local)');
}

module.exports = { startHostRecapCron, runHostRecapPass, RECAP_HOURS };
