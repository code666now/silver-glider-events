'use strict';

const cron = require('node-cron');
const pool = require('../config/db');
const { eventEndAtSql } = require('../lib/post-event');
const { sfCoverageInput, cleanCachedWalks, MAX_WALKS } = require('../lib/transit/sf-coverage-store');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WALK_TTL = 24 * HOUR;
const NO_WALKS_TTL = 6 * HOUR;
const READY_TTL = HOUR;
const CHECK_INTERVAL = 20 * MINUTE;
const FAILURE_RETRY = 15 * MINUTE;
const BATCH_SIZE = 4;
const MAX_ROLLING_CREDITS = 2_400;
const JOB_LOCK = 'transit:sf-coverage-worker-v1';

const eventColumns = `e.id, e.slug, e.event_date::text AS event_date, e.start_time, e.end_time, e.timezone,
  e.venue_name, e.venue_address, e.google_place_id, e.venue_city, e.venue_state, e.venue_latitude, e.venue_longitude,
  e.status, e.visibility, e.secret_show_enabled, e.hide_address_until_rsvp, e.archived_at,
  e.updated_at::text AS updated_at, ${eventEndAtSql('e')} AS ends_at`;

const publishedSfCandidates = `e.status='published' AND e.visibility='public' AND e.archived_at IS NULL
  AND NOT e.secret_show_enabled AND NOT e.hide_address_until_rsvp AND e.timezone='America/Los_Angeles'
  AND lower(btrim(e.venue_city))='san francisco' AND lower(btrim(e.venue_state)) IN ('ca','california')
  AND nullif(btrim(e.google_place_id),'') IS NOT NULL AND e.venue_latitude IS NOT NULL AND e.venue_longitude IS NOT NULL`;

function createSfCoverageWorker({ db = pool, now = Date.now, prepareVenue, checkEvent, env = process.env } = {}) {
  function enabled() {
    return env.TRANSIT_GETTING_HOME_ENABLED === 'true' && env.TRANSIT_SF_GETTING_HOME_ENABLED === 'true'
      && Boolean(env.GEOAPIFY_API_KEY?.trim()) && typeof prepareVenue === 'function' && typeof checkEvent === 'function';
  }

  async function runPass() {
    const report = { checked: 0, ready: 0 };
    if (!enabled()) return report;
    const client = await db.connect();
    let locked;
    try {
      const lock = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [JOB_LOCK]);
      locked = lock.rows[0]?.locked === true;
      if (!locked) return report;

      await client.query("DELETE FROM transit_sf_walk_reservations WHERE reserved_at <= clock_timestamp() - INTERVAL '24 hours'");
      await client.query(`DELETE FROM transit_sf_venue_coverage WHERE venue_key IN (
        SELECT venue_key FROM transit_sf_venue_coverage WHERE expires_at<=$1 ORDER BY expires_at LIMIT 100)`, [new Date(now())]);
      await client.query(`DELETE FROM transit_sf_event_coverage WHERE event_id IN (
        SELECT c.event_id FROM transit_sf_event_coverage c JOIN events e ON e.id=c.event_id
        WHERE e.event_date < ($1::timestamptz AT TIME ZONE 'America/Los_Angeles')::date - 2 LIMIT 100)`, [new Date(now())]);

      const { rows: events } = await client.query(`SELECT ${eventColumns}
        FROM events e LEFT JOIN transit_sf_event_coverage c ON c.event_id=e.id
        WHERE ${publishedSfCandidates}
        AND e.event_date BETWEEN ($1::timestamptz AT TIME ZONE 'America/Los_Angeles')::date - 1
          AND ($1::timestamptz AT TIME ZONE 'America/Los_Angeles')::date + 45
        AND (c.event_id IS NULL OR c.retry_at<=$1 OR c.source_updated_at IS DISTINCT FROM e.updated_at)
        ORDER BY LEAST(COALESCE(c.retry_at,'-infinity'::timestamptz),$1),e.event_date,e.start_time,e.id
        LIMIT $2`, [new Date(now()), BATCH_SIZE]);

      async function saveOutcome(event, input, retryAt, readyUntil = null) {
        await client.query(`INSERT INTO transit_sf_event_coverage
          (event_id,venue_key,input_version,source_updated_at,retry_at,ready_until)
          SELECT id,$2,$3,$4,$5,$6 FROM events WHERE id=$1
          ON CONFLICT (event_id) DO UPDATE SET
            venue_key=EXCLUDED.venue_key,input_version=EXCLUDED.input_version,source_updated_at=EXCLUDED.source_updated_at,
            retry_at=EXCLUDED.retry_at,ready_until=EXCLUDED.ready_until`,
        [event.id, input?.venue.key ?? null, input?.version ?? null, event.updated_at, new Date(retryAt), readyUntil === null ? null : new Date(readyUntil)]);
      }

      async function stillEligible(input) {
        const { rows } = await client.query(`SELECT ${eventColumns} FROM events e WHERE e.id=$1 AND ${publishedSfCandidates}`, [input.id]);
        return sfCoverageInput(rows[0])?.version === input.version;
      }

      for (const event of events) {
        const input = sfCoverageInput(event);
        if (!input) {
          // Skip e.g. the original Make-Out Room pilot without repeatedly
          // scanning the same row ahead of other venues in the queue.
          await saveOutcome(event, null, now() + NO_WALKS_TTL);
          continue;
        }
        if (!await stillEligible(input)) continue;
        report.checked++;
        try {
          const { rows } = await client.query(`SELECT walks,expires_at FROM transit_sf_venue_coverage
            WHERE venue_key=$1 AND expires_at>$2`, [input.venue.key, new Date(now())]);
          let walks = cleanCachedWalks(rows[0]?.walks);
          let expiresAt = walks && new Date(rows[0].expires_at).getTime();
          if (!walks) {
            let reserved = false;
            let tried = false;
            const reserveCredits = async credits => {
              if (tried || !Number.isInteger(credits) || credits < 1 || credits > MAX_WALKS) return false;
              tried = true;
              // Recheck privacy/location after independently resolving the
              // address and before sending walking coordinates to Geoapify.
              if (!await stillEligible(input)) return false;
              // The session advisory lock serializes this check on all app
              // replicas. Charge before calls, including timeouts/rejections.
              const result = await client.query(`INSERT INTO transit_sf_walk_reservations(credits)
                SELECT $1::int WHERE $1::int + COALESCE((SELECT SUM(credits) FROM transit_sf_walk_reservations
                  WHERE reserved_at > clock_timestamp() - INTERVAL '24 hours'),0)<=$2`, [credits, MAX_ROLLING_CREDITS]);
              reserved = result.rowCount === 1;
              return reserved;
            };
            walks = cleanCachedWalks(await prepareVenue(event, input.venue, reserveCredits));
            if (!walks || (tried && !reserved) || (walks.length && !reserved)) throw new Error('Walking estimates unavailable');
            if (!await stillEligible(input)) continue;
            expiresAt = now() + (walks.length ? WALK_TTL : NO_WALKS_TTL);
            await client.query(`INSERT INTO transit_sf_venue_coverage(venue_key,walks,expires_at) VALUES ($1,$2::jsonb,$3)
              ON CONFLICT (venue_key) DO UPDATE SET walks=EXCLUDED.walks,expires_at=EXCLUDED.expires_at`,
            [input.venue.key, JSON.stringify(walks), new Date(expiresAt)]);
          }

          const ready = walks.length > 0 && await checkEvent(event, walks) === true;
          if (!await stillEligible(input)) continue;
          const checkedAt = now();
          const readyUntil = ready ? Math.min(expiresAt, checkedAt + READY_TTL) : null;
          const retryAt = walks.length ? Math.min(expiresAt, checkedAt + CHECK_INTERVAL) : expiresAt;
          await saveOutcome(event, input, retryAt, readyUntil);
          if (readyUntil > checkedAt) report.ready++;
        } catch (error) {
          // Provider payloads and exception text must never reach the logs,
          // DB, or guests. A moved stop can invalidate the shared venue cache.
          if (error?.code === 'SF_WALKS_STALE') {
            await client.query('DELETE FROM transit_sf_venue_coverage WHERE venue_key=$1', [input.venue.key]);
            await client.query(`UPDATE transit_sf_event_coverage SET ready_until=NULL, retry_at=LEAST(retry_at,$2)
              WHERE venue_key=$1`, [input.venue.key, new Date(now())]);
          }
          await saveOutcome(event, input, now() + FAILURE_RETRY);
        }
      }
      return report;
    } finally {
      let discard = false;
      if (locked) {
        try {
          const result = await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked', [JOB_LOCK]);
          discard = result.rows[0]?.unlocked !== true;
        } catch {
          discard = true;
        }
      } else if (locked === undefined) {
        discard = true;
      }
      client.release(discard);
    }
  }

  function startCron() {
    if (!enabled()) return null;
    return cron.schedule('* * * * *', async () => {
      try { await runPass(); }
      catch { console.error('[sf-transit-coverage] background pass unavailable'); }
    }, { noOverlap: true });
  }

  return { runPass, startCron };
}

module.exports = { createSfCoverageWorker };
