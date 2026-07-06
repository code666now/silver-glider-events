const { createEvent } = require('ics');

// Build an .ics string for an event. Times are floating local times —
// correct for in-person events regardless of the attendee's device timezone.
function buildIcs(event) {
  // pg returns DATE columns as JS Date objects (local midnight)
  const dt = event.event_date instanceof Date ? event.event_date : new Date(event.event_date);
  const [y, mo, d] = [dt.getFullYear(), dt.getMonth() + 1, dt.getDate()];
  const [h, mi] = String(event.start_time).split(':').map(Number);

  const attrs = {
    start: [y, mo, d, h, mi],
    startInputType: 'local',
    startOutputType: 'local',
    title: event.title,
    description: event.description || undefined,
    location: [event.venue_name, event.venue_address].filter(Boolean).join(', '),
    url: `${process.env.APP_URL}/e/${event.slug}`,
    status: event.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED',
    calName: 'Silver Glider Events'
  };

  if (event.end_time) {
    const [eh, emi] = String(event.end_time).split(':').map(Number);
    // End time before start time means the event runs past midnight
    const endsNextDay = eh < h || (eh === h && emi <= mi);
    const endDate = new Date(Date.UTC(y, mo - 1, d + (endsNextDay ? 1 : 0)));
    attrs.end = [endDate.getUTCFullYear(), endDate.getUTCMonth() + 1, endDate.getUTCDate(), eh, emi];
  } else {
    attrs.duration = { hours: 2 };
  }

  const { error, value } = createEvent(attrs);
  if (error) throw error;
  return value;
}

module.exports = { buildIcs };
