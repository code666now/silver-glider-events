'use strict';

const { createHmac } = require('node:crypto');

const RETENTION_MS = 45 * 24 * 60 * 60 * 1000;
const KINDS = new Set(['page_open', 'route_selected', 'reminder_requested', 'reminder_sent', 'email_link_open', 'text_link_open']);
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
        // event-independent digest records only the first distinct event in
        // the active measurement window; it cannot join to the samples table.
        const { rowCount } = await db.query(
          `WITH first_seen AS (
             INSERT INTO transit_ride_samples(event_id,metric,subject_key,expires_at)
             VALUES ($1,$2,$3,$6)
             ON CONFLICT DO NOTHING RETURNING event_id,metric
           ), repeat_seen AS (
             INSERT INTO transit_ride_repeat_subjects(subject_key,first_event_key,expires_at)
             SELECT $4::text,$5::text,$6 FROM first_seen WHERE $4::text IS NOT NULL
             ON CONFLICT (subject_key) DO UPDATE SET
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

module.exports = { createRideMetrics };
