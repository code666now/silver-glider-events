const cron = require('node-cron');
const pool = require('../config/db');
const { sendHostRecap } = require('../lib/mailer');
const { HOST_ACCOUNT_INACTIVE, withActiveHostAccount } = require('../lib/outbound-account-status');
const { emailOptedOut, emailPreferenceUrls } = require('../lib/email-preferences');
const { eventEndAtSql, loadPostEventContext } = require('../lib/post-event');

let _running = false;

// The morning after an event, its host hears how the night went and gets one
// way into the next one. Sent once per event: the row is claimed before the
// email goes out, so two passes can never both send. A failed send releases
// the claim, and the window below gives it a few hours to retry.
const RECAP_HOURS = [10, 11, 12, 13];

// Only events with RSVPs get a recap; nobody needs "nobody came" in their inbox.
async function pendingRecapEvents(hour) {
  const eventEnd = eventEndAtSql('e');
  const { rows } = await pool.query(
    `SELECT e.id, e.organizer_id
       FROM events e
       JOIN organizers o ON o.id=e.organizer_id
      WHERE e.status='published'
        AND e.host_recap_sent_at IS NULL
        AND NOW() >= (${eventEnd})
        AND ((((${eventEnd}) AT TIME ZONE e.timezone) - INTERVAL '10 hours')::date + 1)
              = (NOW() AT TIME ZONE e.timezone)::date
        AND EXTRACT(HOUR FROM (NOW() AT TIME ZONE e.timezone)) = $1
        AND EXISTS (
          SELECT 1 FROM user_identities identity
           WHERE identity.user_id=o.user_id
             AND identity.identity_type='email'
             AND identity.verification_scope='account'
             AND identity.verified_at IS NOT NULL
             AND identity.revoked_at IS NULL
        )
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

async function verifiedHostEmail(organizerId) {
  const { rows } = await pool.query(
    `SELECT identity.value AS email
       FROM organizers host
       JOIN user_identities identity ON identity.user_id=host.user_id
      WHERE host.id=$1
        AND identity.identity_type='email'
        AND identity.verification_scope='account'
        AND identity.verified_at IS NOT NULL
        AND identity.revoked_at IS NULL
      ORDER BY identity.is_primary DESC, identity.id ASC
      LIMIT 1`,
    [organizerId]
  );
  return String(rows[0]?.email || '').trim() || null;
}

async function sendRecapFor(event) {
  const hostEmail = await verifiedHostEmail(event.organizer_id);
  if (!hostEmail) {
    console.log(`[host-recap] skipped event ${event.id}: no verified host email`);
    return false;
  }
  if (await emailOptedOut(pool, hostEmail, 'host_recaps')) {
    console.log(`[host-recap] skipped event ${event.id}: host recaps disabled`);
    return false;
  }
  const context = await loadPostEventContext(pool, {
    eventId: event.id,
    organizerId: event.organizer_id
  });
  if (!context?.ended) {
    console.log(`[host-recap] skipped event ${event.id}: event has not ended`);
    return false;
  }
  if (!await claimRecap(event.id)) return false;
  try {
    const delivery = await withActiveHostAccount(
      pool,
      event.organizer_id,
      async () => {
        const preferences = emailPreferenceUrls(hostEmail, 'host_recaps');
        return sendHostRecap({
          to: hostEmail,
          event: {
            ...context.event,
            org_name: context.host?.org_name || context.host?.name || null,
            organizer_public_slug: context.host?.public_slug || null
          },
          ...preferences,
          stats: context.stats,
          idempotencyKey: `sge-host-recap-v2-${event.id}`
        });
      }
    );
    // A suspended host keeps the claim: nothing is owed to them, but a skip is
    // not counted as a sent recap in the pass result.
    if (!delivery.allowed) {
      console.log(`[host-recap] skipped event ${event.id}: ${HOST_ACCOUNT_INACTIVE}`);
      return false;
    }
    // Only newly accepted recaps may anchor the separately opt-in follow-up.
    // Historical host_recap_sent_at values are claims and are never backfilled.
    try {
      await pool.query(
        'UPDATE events SET host_recap_delivered_at=COALESCE(host_recap_delivered_at,NOW()) WHERE id=$1',
        [event.id]
      );
    } catch (_) {
      // The provider has already accepted the recap. A bookkeeping failure
      // must not release its one-ever claim or resend it. Missing the optional
      // follow-up is safer than guessing that an accepted recap was not sent.
      console.error('[host-recap] accepted recap follow-up timestamp could not be saved', { eventId: event.id });
    }
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
