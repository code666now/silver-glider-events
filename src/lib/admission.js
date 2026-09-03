const ADMISSION_TYPES = Object.freeze({
  FREE_RSVP: 'free_rsvp',
  SILVER_GLIDER_TICKETS: 'silver_glider_tickets',
  EXTERNAL_TICKETS: 'external_tickets'
});

const LEGACY_EXTERNAL_TICKETS = 'paid';
const ACCEPTED_ADMISSION_TYPES = Object.freeze([
  ADMISSION_TYPES.FREE_RSVP,
  ADMISSION_TYPES.SILVER_GLIDER_TICKETS,
  ADMISSION_TYPES.EXTERNAL_TICKETS,
  LEGACY_EXTERNAL_TICKETS
]);

function normalizeAdmissionType(value) {
  if (value === LEGACY_EXTERNAL_TICKETS) return ADMISSION_TYPES.EXTERNAL_TICKETS;
  return Object.values(ADMISSION_TYPES).includes(value) ? value : null;
}

function isFreeRsvp(eventOrValue) {
  const value = typeof eventOrValue === 'object' ? eventOrValue?.admission_type : eventOrValue;
  return normalizeAdmissionType(value) === ADMISSION_TYPES.FREE_RSVP;
}

function isExternalTickets(eventOrValue) {
  const value = typeof eventOrValue === 'object' ? eventOrValue?.admission_type : eventOrValue;
  return normalizeAdmissionType(value) === ADMISSION_TYPES.EXTERNAL_TICKETS;
}

function isSilverGliderTickets(eventOrValue) {
  const value = typeof eventOrValue === 'object' ? eventOrValue?.admission_type : eventOrValue;
  return normalizeAdmissionType(value) === ADMISSION_TYPES.SILVER_GLIDER_TICKETS;
}

module.exports = {
  ACCEPTED_ADMISSION_TYPES,
  ADMISSION_TYPES,
  LEGACY_EXTERNAL_TICKETS,
  isExternalTickets,
  isFreeRsvp,
  isSilverGliderTickets,
  normalizeAdmissionType
};
