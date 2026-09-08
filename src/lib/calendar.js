const { createEvent } = require('ics');
const LocationUtils = require('../../public/js/location-utils');

// Build an .ics string for an event. Times are floating local times —
// correct for in-person events regardless of the attendee's device timezone.
function buildIcs(event) {
  // pg returns DATE columns as JS Date objects; JSON/test callers use YYYY-MM-DD.
  // Parse strings directly so UTC conversion cannot shift a local event by a day.
  const dateParts = event.event_date instanceof Date
    ? [event.event_date.getFullYear(), event.event_date.getMonth() + 1, event.event_date.getDate()]
    : String(event.event_date).slice(0, 10).split('-').map(Number);
  const [y, mo, d] = dateParts;
  const [h, mi] = String(event.start_time).split(':').map(Number);

  const attrs = {
    start: [y, mo, d, h, mi],
    startInputType: 'local',
    startOutputType: 'local',
    title: event.title,
    description: event.description || undefined,
    location: LocationUtils.locationQuery(event.venue_name, event.venue_address),
    url: `${process.env.APP_URL || 'https://silvergliderevents.com'}/e/${event.slug}`,
    status: event.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED',
    calName: 'Silver Glider Events',
    productId: 'Silver Glider Events',
    uid: `event-${event.id}@silvergliderevents.com`,
    sequence: Number(event.calendar_sequence) || 0,
    method: event.status === 'cancelled' ? 'CANCEL' : 'REQUEST'
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
