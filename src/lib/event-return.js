const { eventEndAtSql } = require('./post-event');
const { esc, fmtDate } = require('./public-html');

function canInviteFriend(event) {
  return Boolean(event && event.status === 'published' && event.visibility === 'public' &&
    !event.secret_show_enabled && event.starts_in_future === true &&
    (event.capacity == null || Number(event.total_attendance) < Number(event.capacity)));
}

// Re-read capacity after an RSVP, including its +1. A stale pre-RSVP page must
// not encourage sharing after the final place has just been taken.
async function friendShareAvailable(db, eventId) {
  try {
    const { rows } = await db.query(`
    SELECT e.status,e.visibility,e.secret_show_enabled,e.capacity,
           (e.event_date + e.start_time) AT TIME ZONE e.timezone > NOW() AS starts_in_future,
           (SELECT COUNT(*) + COUNT(guest_first_name) FROM rsvps
             WHERE event_id=e.id AND status='confirmed')::int AS total_attendance
      FROM events e WHERE e.id=$1`, [eventId]);
    return canInviteFriend(rows[0]);
  } catch (_) {
    // Sharing is optional. A failed read must never turn a committed RSVP into
    // an error or encourage the guest to submit it twice.
    return false;
  }
}

async function nextPublicEvent(db, event) {
  if (!event.post_event_ended || event.status !== 'published' || !event.organizer_public_slug) return null;
  const { rows } = await db.query(`
    SELECT e.slug,e.title,e.event_date,e.cover_image_url,e.flyer_image_url,e.presentation_mode
      FROM events e JOIN organizers o ON o.id=e.organizer_id
      JOIN users u ON u.id=o.user_id
     WHERE e.organizer_id=$1 AND e.id<>$2 AND e.status='published'
       AND e.visibility='public' AND e.secret_show_enabled=FALSE
       AND u.account_status='active'
       AND (e.event_date + e.start_time) AT TIME ZONE e.timezone > NOW()
       AND ${eventEndAtSql('e')} > NOW()
     ORDER BY (e.event_date + e.start_time) AT TIME ZONE e.timezone,e.id
     LIMIT 1`, [event.organizer_id, event.id]);
  return rows[0] || null;
}

function renderEventReturn(event, next) {
  if (!event.post_event_ended || event.status !== 'published' || !event.organizer_public_slug) return '';
  const host = String(event.org_name || 'this host');
  if (next) {
    const image = next.presentation_mode === 'flyer' ? next.flyer_image_url || next.cover_image_url : next.cover_image_url;
    return `<section class="event-return" aria-labelledby="event-return-title">
      <p class="event-return-kicker">Keep the good nights going</p>
      <h2 id="event-return-title">Next from ${esc(host)}</h2>
      <a class="event-return-next" href="/e/${encodeURIComponent(next.slug)}">
        ${image ? `<img src="${esc(image)}" alt="" loading="lazy">` : ''}
        <span><small>${esc(fmtDate(next.event_date))}</small><strong>${esc(next.title)}</strong><b>View event <span aria-hidden="true">→</span></b></span>
      </a>
    </section>`;
  }
  return `<section class="event-return" aria-labelledby="event-return-title">
    <p class="event-return-kicker">Until the next one</p>
    <h2 id="event-return-title">Want the next invite?</h2>
    <p>Follow ${esc(host)} and choose how you hear about future events.</p>
    <button class="sg-btn sg-btn-ghost" id="event-return-follow" type="button">Follow ${esc(host)}</button>
    <a class="event-return-host" href="/h/${encodeURIComponent(event.organizer_public_slug)}">View Host Page <span aria-hidden="true">→</span></a>
  </section>`;
}

module.exports = { canInviteFriend, friendShareAvailable, nextPublicEvent, renderEventReturn };
