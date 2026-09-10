const { normalizeE164, SmsDeliveryError } = require('./sms');

const SMS_CONSENT_SOURCE = 'event_rsvp';
const SMS_CONSENT_VERSION = 'rsvp_sms_v1';
const SMS_CONSENT_DISCLOSURE = 'Message frequency varies. Msg & data rates may apply. Reply STOP to opt out. Consent isn’t required to RSVP.';

function cleanHostLabel(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120) || 'this host';
}

function smsConsentHeading(hostName) {
  return `Text me event updates and future invitations from ${cleanHostLabel(hostName)} through Silver Glider.`;
}

function smsConsentCopy(hostName) {
  return `${smsConsentHeading(hostName)} ${SMS_CONSENT_DISCLOSURE}`;
}

function prepareRsvpSmsConsent({ optedIn, phone, hostName, now = new Date() }) {
  const submittedPhone = String(phone || '').trim().slice(0, 30) || null;
  if (!optedIn) {
    return {
      phone: submittedPhone,
      optedIn: false,
      consentedAt: null,
      source: null,
      version: null,
      text: null
    };
  }

  let normalizedPhone;
  try {
    normalizedPhone = normalizeE164(submittedPhone);
  } catch (_) {
    throw new SmsDeliveryError('Enter a valid phone number to receive text messages', {
      code: 'invalid_sms_phone',
      status: 400
    });
  }

  const consentedAt = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(consentedAt.getTime())) {
    throw new SmsDeliveryError('SMS consent could not be recorded', {
      code: 'invalid_sms_consent_time',
      status: 500
    });
  }

  return {
    phone: normalizedPhone,
    optedIn: true,
    consentedAt,
    source: SMS_CONSENT_SOURCE,
    version: SMS_CONSENT_VERSION,
    text: smsConsentCopy(hostName)
  };
}

module.exports = {
  SMS_CONSENT_DISCLOSURE,
  SMS_CONSENT_SOURCE,
  SMS_CONSENT_VERSION,
  prepareRsvpSmsConsent,
  smsConsentCopy,
  smsConsentHeading
};
