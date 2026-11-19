const { createHash } = require('node:crypto');
const { eventEndAtSql } = require('./post-event');
const { externalTicketLink } = require('./ticket-links');

const TRACKING_MIGRATION = '088_external_ticket_clicks.sql';
const VISITOR_KEY = /^[0-9a-f]{32}$/;
const UNAVAILABLE = Object.freeze({ totalTicketClicks: null, uniqueTicketClicks: null });

function validTicketVisitorKey(browserKey) {
  return typeof browserKey === 'string' && VISITOR_KEY.test(browserKey);
}

function ticketVisitorSlot(eventId, browserKey) {
  if (!validTicketVisitorKey(browserKey)) return null;
  // Include the event even if a client sends the same random key on both.
  return createHash('sha256').update(`sge-ticket-click-v1:${eventId}:${browserKey}`).digest().readUInt16BE(0);
}

async function loadExternalTicketClickTarget(db, slug) {
  const { rows } = await db.query(
    `SELECT id, organizer_id, admission_type, ticket_url, secret_show_enabled, secret_show_version
       FROM events
      WHERE slug=$1 AND status='published' AND event_date >= (CURRENT_TIMESTAMP AT TIME ZONE timezone)::date`,
    [slug]
  );
  return rows[0] || null;
}

async function recordExternalTicketClick(db, event, browserKey) {
  const slot = ticketVisitorSlot(event.id, browserKey);
  if (slot === null || !externalTicketLink(event)) return false;
  const { rowCount } = await db.query(
    `INSERT INTO external_ticket_clicks (event_id,total_clicks,unique_clicks,visitor_slots)
     SELECT id,1,1,set_bit(0::bit(65536),$2::int,1) FROM events
      WHERE id=$1 AND status='published' AND ticket_url=$3 AND admission_type=$4
        AND secret_show_enabled=$5 AND secret_show_version=$6
        AND event_date >= (CURRENT_TIMESTAMP AT TIME ZONE timezone)::date
     ON CONFLICT (event_id) DO UPDATE SET
       total_clicks=external_ticket_clicks.total_clicks+1,
       unique_clicks=external_ticket_clicks.unique_clicks+1-get_bit(external_ticket_clicks.visitor_slots,$2::int),
       visitor_slots=set_bit(external_ticket_clicks.visitor_slots,$2::int,1)`,
    [event.id, slot, event.ticket_url, event.admission_type, event.secret_show_enabled, event.secret_show_version]
  );
  return rowCount === 1;
}

async function loadExternalTicketImpact(db, { eventId, organizerId }) {
  const { rows: [row] } = await db.query(
    `SELECT e.admission_type,e.ticket_url,counts.total_clicks,counts.unique_clicks,
            (e.first_published_at IS NOT NULL AND (${eventEndAtSql('e')})>migration.applied_at
             AND e.status='published') AS tracking_available
       FROM events e LEFT JOIN external_ticket_clicks counts ON counts.event_id=e.id
       LEFT JOIN schema_migrations migration ON migration.filename=$3
      WHERE e.id=$1 AND e.organizer_id=$2`,
    [eventId, organizerId, TRACKING_MIGRATION]
  );
  if (!row) return UNAVAILABLE;
  // Once recorded, interest remains historical even if the host later changes
  // or removes the destination. Pre-tracking or door-sale events don't fake 0s.
  if (row.total_clicks != null) {
    return { totalTicketClicks: Number(row.total_clicks), uniqueTicketClicks: Number(row.unique_clicks) };
  }
  return row.tracking_available && externalTicketLink(row)
    ? { totalTicketClicks: 0, uniqueTicketClicks: 0 }
    : UNAVAILABLE;
}

module.exports = { loadExternalTicketClickTarget, loadExternalTicketImpact, recordExternalTicketClick, ticketVisitorSlot, validTicketVisitorKey };
