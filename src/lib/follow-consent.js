const { normalizeE164, SmsDeliveryError } = require('./sms');

const FOLLOW_EMAIL_CONSENT_SOURCE = 'host_page_follow';
const FOLLOW_EMAIL_CONSENT_VERSION = 'host_follow_email_v1';
const FOLLOW_SMS_CONSENT_SOURCE = 'host_page_follow';
const FOLLOW_SMS_CONSENT_VERSION = 'host_follow_sms_v1';

function cleanHostLabel(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120) || 'this host';
}

function followEmailConsentCopy(hostName) {
  return `Email me when ${cleanHostLabel(hostName)} shares a new event. I can unsubscribe anytime.`;
}

function followSmsConsentCopy(hostName) {
  return `Text me when ${cleanHostLabel(hostName)} shares a new event. Msg & data rates may apply. Reply STOP to opt out. Texts are optional.`;
}

function prepareFollowSmsConsent({ phone, hostName, now = new Date() }) {
  let normalizedPhone;
  try {
    normalizedPhone = normalizeE164(phone);
  } catch (_) {
    throw new SmsDeliveryError('Enter a valid phone number to receive text updates', {
      code: 'invalid_follow_sms_phone', status: 400
    });
  }
  return {
    phone: normalizedPhone,
    consentedAt: now,
    source: FOLLOW_SMS_CONSENT_SOURCE,
    version: FOLLOW_SMS_CONSENT_VERSION,
    text: followSmsConsentCopy(hostName)
  };
}

module.exports = {
  FOLLOW_EMAIL_CONSENT_SOURCE,
  FOLLOW_EMAIL_CONSENT_VERSION,
  FOLLOW_SMS_CONSENT_SOURCE,
  FOLLOW_SMS_CONSENT_VERSION,
  followEmailConsentCopy,
  followSmsConsentCopy,
  prepareFollowSmsConsent
};
