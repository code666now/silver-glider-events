const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EVENT_EMAIL_CONSENT_VERSION,
  EVENT_EMAIL_CONSENT_LABEL,
  EVENT_EMAIL_CONSENT_HELPER,
  prepareEventEmailConsent
} = require('../src/lib/event-email-consent');

test('event email permission records the disclosed scope only for an explicit current-version choice', () => {
  const now = new Date('2026-11-02T20:00:00Z');
  const consent = prepareEventEmailConsent({
    enabled: true, version: EVENT_EMAIL_CONSENT_VERSION, source: 'event_rsvp', now
  });
  assert.equal(consent.optedIn, true);
  assert.equal(consent.consentedAt, now);
  assert.equal(consent.source, 'event_rsvp');
  assert.equal(consent.version, EVENT_EMAIL_CONSENT_VERSION);
  assert.equal(consent.text, `${EVENT_EMAIL_CONSENT_LABEL} ${EVENT_EMAIL_CONSENT_HELPER}`);
  for (const input of [
    { enabled: true },
    { enabled: true, version: 'old-reminders-only' },
    { enabled: false, version: EVENT_EMAIL_CONSENT_VERSION },
    { enabled: 'true', version: EVENT_EMAIL_CONSENT_VERSION }
  ]) {
    const result = prepareEventEmailConsent({ ...input, source: 'event_rsvp', now });
    assert.equal(result.optedIn, false);
    assert.equal(result.consentedAt, null);
    assert.equal(result.version, null);
  }
});
