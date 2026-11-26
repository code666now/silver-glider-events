'use strict';

const { createHmac } = require('node:crypto');

const RETENTION_MS = 45 * 24 * 60 * 60 * 1000;
const TRANSPORTATION_INTERACTION_KINDS = Object.freeze(['bus_click', 'uber_click', 'lyft_click']);
const KINDS = new Set(['page_open', 'route_selected', 'reminder_requested', 'reminder_sent', 'email_link_open', 'text_link_open',
  ...TRANSPORTATION_INTERACTION_KINDS]);
const validId = id => Number.isInteger(id) && id > 0 && id <= 2147483647;

function createRideMetrics({ db, secret = process.env.SESSION_SECRET, now = Date.now } = {}) {
  const key = typeof secret === 'string' ? secret.trim() : '';
  const subject = (purpose, parts) => createHmac('sha256', key).update(`sge:transit-metrics:${purpose}:v1\0`)
    .update(parts.join(':')).digest('hex').slice(0, 40);

  return {
    // Only call after server-side eligibility, ownership/redeemed-link and
    // outcome checks. Never give clients a generic analytics write endpoint.
    async record({ kind, eventId, userId, rsvpId } = {}) {
      if (!key || !KINDS.has(kind) || !validId(eventId)) return false;
      const participant = validId(rsvpId) ? ['rsvp', rsvpId] : validId(userId) ? ['user', userId] : null;
      if (!participant) return false;
      const eventSubject = subject('event-subject', [eventId, ...participant]);
      const repeatSubject = kind === 'page_open' && validId(userId) ? subject('repeat-subject', [userId]) : null;
      const repeatAnchor = repeatSubject ? subject('repeat-anchor', [userId, eventId]) : null;
      const current = new Date(now());
      const expiration = new Date(current.getTime() + RETENTION_MS);
      try {
        // The dedup claim and aggregate update are atomic. A separate,
        // event-independent digest records the first distinct event and a
        // return bit in the active window; it cannot join to the samples table.
        const { rowCount } = await db.query(
          `WITH first_seen AS (
             INSERT INTO transit_ride_samples(event_id,metric,subject_key,expires_at)
             VALUES ($1,$2,$3,$6)
             ON CONFLICT DO NOTHING RETURNING event_id,metric
           ), repeat_seen AS (
             INSERT INTO transit_ride_repeat_subjects(subject_key,first_event_key,expires_at,returned)
             SELECT $4::text,$5::text,$6,false FROM first_seen WHERE $4::text IS NOT NULL
             ON CONFLICT (subject_key) DO UPDATE SET
               returned=CASE WHEN transit_ride_repeat_subjects.expires_at <= $7 THEN false
                 ELSE transit_ride_repeat_subjects.returned OR transit_ride_repeat_subjects.first_event_key <> EXCLUDED.first_event_key END,
               first_event_key=CASE WHEN transit_ride_repeat_subjects.expires_at <= $7
                 THEN EXCLUDED.first_event_key ELSE transit_ride_repeat_subjects.first_event_key END,
               expires_at=CASE WHEN transit_ride_repeat_subjects.expires_at <= $7
                 THEN EXCLUDED.expires_at ELSE transit_ride_repeat_subjects.expires_at END
             RETURNING first_event_key
           ), increments AS (
             SELECT event_id,metric FROM first_seen
             UNION ALL SELECT $1,'repeat_open' FROM repeat_seen WHERE first_event_key<>$5
           )
           INSERT INTO transit_ride_totals(event_id,metric,unique_count)
           SELECT event_id,metric,1 FROM increments ORDER BY metric
           ON CONFLICT (event_id,metric) DO UPDATE SET unique_count=transit_ride_totals.unique_count+1`,
          [eventId, kind, eventSubject, repeatSubject, repeatAnchor, expiration, current]
        );
        return rowCount > 0;
      } catch {
        // Optional measurement must never block reading the route, sending an
        // email, or claiming an already accepted reminder outcome.
        return false;
      }
    },

    async prune() {
      try {
        const { rows } = await db.query(
          `WITH samples AS (DELETE FROM transit_ride_samples WHERE expires_at <= $1 RETURNING 1),
                subjects AS (DELETE FROM transit_ride_repeat_subjects WHERE expires_at <= $1 RETURNING 1)
           SELECT (SELECT COUNT(*) FROM samples)::int + (SELECT COUNT(*) FROM subjects)::int AS deleted`,
          [new Date(now())]
        );
        return rows[0]?.deleted || 0;
      } catch {
        return 0;
      }
    }
  };
}

const REPORT_COUNTS = Object.freeze({
  page_open: 'pageOpens', route_selected: 'routeSelections', bus_click: 'busClicks', uber_click: 'uberClicks',
  lyft_click: 'lyftClicks', repeat_open: 'repeatOpens'
});
const reportKinds = Object.keys(REPORT_COUNTS);
const reportCounts = row => Object.fromEntries(reportKinds.map(kind => [REPORT_COUNTS[kind], Math.max(0, Number(row?.[kind]) || 0)]));
const eventCountsSql = reportKinds.map(kind => `COALESCE(SUM(t.unique_count) FILTER (WHERE t.metric='${kind}'),0) AS ${kind}`).join(',\n');
const sumCountsSql = reportKinds.map(kind => `COALESCE(SUM(${kind}),0) AS ${kind}`).join(',\n');

// Only authorized admin callers use this aggregate. Never select a subject
// key or expose contact, network, destination or route data through the report.
async function getTransportationAnalytics({ db, now = Date.now } = {}) {
  const { rows: [row] } = await db.query(`WITH event_usage AS (
    SELECT e.id,e.title,e.event_date,e.organizer_id AS host_id,
           COALESCE(NULLIF(btrim(o.org_name),''),NULLIF(btrim(o.name),''),'Host') AS host_name,
           ${eventCountsSql}
      FROM transit_ride_totals t
      JOIN events e ON e.id=t.event_id
      JOIN organizers o ON o.id=e.organizer_id
     WHERE t.metric=ANY($2::text[]) AND e.visibility='public' AND e.status<>'hidden'
       AND e.secret_show_enabled IS NOT TRUE AND e.hide_address_until_rsvp IS NOT TRUE
     GROUP BY e.id,e.title,e.event_date,e.organizer_id,o.org_name,o.name
  ), host_usage AS (
    SELECT host_id AS id, MAX(host_name) AS name, MAX(event_date) AS recent_date, COUNT(*) AS event_count,
           ${sumCountsSql}
      FROM event_usage GROUP BY host_id
  ), summary AS (
    SELECT COUNT(*) AS event_count, COUNT(DISTINCT host_id) AS host_count, ${sumCountsSql}
      FROM event_usage
  )
  SELECT row_to_json(summary) AS summary,
         (SELECT COUNT(*) FROM transit_ride_repeat_subjects WHERE returned AND expires_at>$1) AS returning_users,
         COALESCE((SELECT json_agg(rows ORDER BY rows.event_date DESC,rows.id DESC)
           FROM (SELECT * FROM event_usage ORDER BY event_date DESC,id DESC LIMIT 50) rows),'[]'::json) AS events,
         COALESCE((SELECT json_agg(rows ORDER BY rows.recent_date DESC,rows.id DESC)
           FROM (SELECT * FROM host_usage ORDER BY recent_date DESC,id DESC LIMIT 50) rows),'[]'::json) AS hosts
    FROM summary`, [new Date(now()), reportKinds]);

  return {
    summary: {
      eventCount: Number(row?.summary?.event_count) || 0, hostCount: Number(row?.summary?.host_count) || 0,
      returningUsers45d: Number(row?.returning_users) || 0, ...reportCounts(row?.summary)
    },
    events: (row?.events || []).map(event => ({
      id: event.id, title: event.title, eventDate: event.event_date, hostId: event.host_id,
      hostName: event.host_name, ...reportCounts(event)
    })),
    hosts: (row?.hosts || []).map(host => ({ id: host.id, name: host.name, eventCount: Number(host.event_count) || 0, ...reportCounts(host) }))
  };
}

module.exports = { createRideMetrics, getTransportationAnalytics, TRANSPORTATION_INTERACTION_KINDS };
