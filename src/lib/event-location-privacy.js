const { isFreeRsvp } = require('./admission');
const LocationUtils = require('../../public/js/location-utils');

const HIDDEN_LOCATION_MESSAGE = 'Exact location shared after RSVP';

function addressPrivacyEnabled(event) {
  return Boolean(
    event?.hide_address_until_rsvp === true &&
    event?.visibility === 'private' &&
    isFreeRsvp(event)
  );
}

function locationForViewer(event, { canViewExact = false } = {}) {
  const hidden = addressPrivacyEnabled(event) && !canViewExact;
  if (!hidden) {
    const display = LocationUtils.displayParts(event?.venue_name, event?.venue_address);
    const query = LocationUtils.locationQuery(event?.venue_name, event?.venue_address);
    return {
      name: display.name,
      address: display.address,
      mapsUrl: query ? `https://maps.google.com/?q=${encodeURIComponent(query)}` : null,
      hidden: false
    };
  }

  const generalLocation = [event?.venue_city, event?.venue_state]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(', ');
  return {
    name: generalLocation || HIDDEN_LOCATION_MESSAGE,
    address: generalLocation ? HIDDEN_LOCATION_MESSAGE : '',
    mapsUrl: null,
    hidden: true
  };
}

function calendarEventForViewer(event, options = {}) {
  const location = locationForViewer(event, options);
  if (!location.hidden) return event;
  return {
    ...event,
    venue_name: location.name,
    venue_address: ''
  };
}

module.exports = {
  HIDDEN_LOCATION_MESSAGE,
  addressPrivacyEnabled,
  calendarEventForViewer,
  locationForViewer
};
