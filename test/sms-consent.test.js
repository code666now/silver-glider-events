const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SMS_CONSENT_DISCLOSURE,
  SMS_CONSENT_SOURCE,
  SMS_CONSENT_VERSION,
  prepareRsvpSmsConsent,
  smsConsentCopy,
  smsConsentHeading
} = require('../src/lib/sms-consent');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('RSVP SMS consent is explicit, normalized, and auditable', () => {
  const now = new Date('2026-09-09T20:00:00.000Z');
  const consent = prepareRsvpSmsConsent({
    optedIn: true,
    phone: '(415) 555-1234',
    hostName: '  Heatwave   Booking ',
    now
  });

  assert.equal(consent.phone, '+14155551234');
  assert.equal(consent.optedIn, true);
  assert.equal(consent.consentedAt, now);
  assert.equal(consent.source, SMS_CONSENT_SOURCE);
  assert.equal(consent.version, SMS_CONSENT_VERSION);
  assert.equal(consent.text, `${smsConsentHeading('Heatwave Booking')} ${SMS_CONSENT_DISCLOSURE}`);
  assert.match(consent.text, /Consent isn’t required to RSVP/);
  assert.match(consent.text, /Reply STOP to opt out/);
});

test('phone collection alone never becomes SMS permission', () => {
  const noConsent = prepareRsvpSmsConsent({
    optedIn: false,
    phone: '415-555-1234',
    hostName: 'Heatwave Booking'
  });
  assert.deepEqual(noConsent, {
    phone: '415-555-1234',
    optedIn: false,
    consentedAt: null,
    source: null,
    version: null,
    text: null
  });
  assert.throws(
    () => prepareRsvpSmsConsent({ optedIn: true, phone: '', hostName: 'Heatwave Booking' }),
    /valid phone number/
  );
});

test('SMS consent stays separate from Follow Host and exposes only an eligibility preview', () => {
  const migration = read('src/db/migrations/031_rsvp_sms_consent.sql');
  const standard = read('src/views/event-public.html');
  const flyer = read('src/views/event-public-flyer.html');
  const client = read('public/js/public-event.js');
  const manage = read('src/views/event-manage.html');
  const manageClient = read('public/js/manage.js');
  const host = read('src/routes/public-hosts.js');
  const publicRoute = read('src/routes/public.js');

  for (const field of ['sms_optin', 'sms_consent_at', 'sms_consent_source', 'sms_consent_version', 'sms_consent_text', 'sms_opted_out_at']) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${field}`));
  }
  assert.match(migration, /rsvps_event_sms_eligible_idx/);
  for (const view of [standard, flyer]) {
    assert.match(view, /\{\{SMS_REMINDER_OPTIN_HTML\}\}/);
  }
  assert.match(publicRoute, /id=\"sms_optin\"/);
  assert.doesNotMatch(publicRoute, /id=\"sms_optin\"[^>]*checked/);
  assert.match(publicRoute, /event\.sms_reminder_enabled/);
  assert.match(client, /phoneInput\.required = smsOptin\.checked/);
  assert.match(client, /sms_optin: Boolean\(smsOptin\?\.checked\)/);
  assert.match(manage, /id="sms-audience-count"/);
  assert.match(manageClient, /event\.sms_eligible_count/);
  assert.match(manageClient, /!event\.sms_reminder_enabled/);
  assert.doesNotMatch(host, /sms_optin|SMS_CONSENT/);
  assert.match(smsConsentCopy('Test Host'), /through Silver Glider/);
});
