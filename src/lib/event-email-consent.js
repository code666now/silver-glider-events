const EVENT_EMAIL_CONSENT_VERSION = 'event_communications_v1';
const EVENT_EMAIL_CONSENT_LABEL = 'Email me reminders and messages about this event.';
const EVENT_EMAIL_CONSENT_HELPER = 'Includes reminders before the event and one thank-you afterward. Unsubscribe anytime.';

// The previous reminder checkbox did not disclose post-event messages. A new
// permission therefore requires an explicit checked value and the exact copy
// version that was presented, rather than inferring consent from a legacy flag.
function prepareEventEmailConsent({ enabled, version, source, now = new Date() }) {
  if (enabled !== true || version !== EVENT_EMAIL_CONSENT_VERSION) {
    return { optedIn: false, consentedAt: null, source: null, version: null, text: null };
  }
  const consentedAt = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(consentedAt.getTime())) throw new Error('Event email consent could not be recorded');
  return {
    optedIn: true,
    consentedAt,
    source,
    version: EVENT_EMAIL_CONSENT_VERSION,
    text: `${EVENT_EMAIL_CONSENT_LABEL} ${EVENT_EMAIL_CONSENT_HELPER}`
  };
}

module.exports = {
  EVENT_EMAIL_CONSENT_VERSION,
  EVENT_EMAIL_CONSENT_LABEL,
  EVENT_EMAIL_CONSENT_HELPER,
  prepareEventEmailConsent
};
