const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('day-before texting automation is additive, event-scoped, and off by default', () => {
  const migration = read('src/db/migrations/034_texting_fulfillment_v1.sql');
  const form = read('src/views/event-form.html');
  const formClient = read('public/js/event-form.js');
  const events = read('src/routes/events.js');

  assert.match(migration, /sms_reminder_enabled BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(migration, /access_token_expires_at TIMESTAMPTZ/);
  assert.match(migration, /sms_phone_verified_at TIMESTAMPTZ/);
  assert.match(form, /id="automatic-text-title">Automatic texts/);
  assert.match(form, /id="sms_reminder_enabled" role="switch"/);
  assert.doesNotMatch(form, /id="sms_reminder_enabled"[^>]*checked/);
  assert.match(form, /Uses your texting balance\. The cost depends on how many guests opt in\./);
  assert.match(formClient, /sms_reminder_enabled: \$\('sms_reminder_enabled'\)\.checked/);
  assert.match(formClient, /event\.sms_reminder_enabled === true/);
  assert.match(events, /Day-before text reminders are not available for Secret Shows yet/);
});

test('RSVP reminder consent is conditional, unchecked, and separate from host marketing', () => {
  const publicRoute = read('src/routes/public.js');
  const client = read('public/js/public-event.js');
  const standard = read('src/views/event-public.html');
  const flyer = read('src/views/event-public-flyer.html');

  assert.match(publicRoute, /if \(!event\.sms_reminder_enabled \|\| event\.secret_show_enabled\) return ''/);
  assert.match(publicRoute, /id=\"sms_optin\"/);
  assert.doesNotMatch(publicRoute, /id=\"sms_optin\"[^>]*checked/);
  assert.match(publicRoute, /event\.sms_reminder_enabled && requestedSmsOptin/);
  assert.match(client, /smsPhoneField\.hidden = !smsOptin\.checked/);
  for (const template of [standard, flyer]) {
    assert.match(template, /\{\{SMS_REMINDER_OPTIN_HTML\}\}/);
    assert.ok(template.indexOf('{{SMS_REMINDER_OPTIN_HTML}}') < template.indexOf('<details class="rsvp-options">'));
  }
});

test('automatic fulfillment is all-or-nothing, retry-safe, and gives each guest a private event link', () => {
  const fulfillment = read('src/lib/sms-reminder-fulfillment.js');
  const job = read('src/jobs/sms-notifications.js');
  const publicRoute = read('src/routes/public.js');
  const manage = read('public/js/manage.js');

  assert.match(fulfillment, /const PREVIEW_ACCESS_TOKEN = 'x'\.repeat\(32\)/);
  assert.match(fulfillment, /crypto\.randomBytes\(16\)\.toString\('hex'\)/);
  assert.match(fulfillment, /r\.sms_consent_version=\$2/);
  assert.match(fulfillment, /reserveSendCredits\(client/);
  assert.match(fulfillment, /NOW\(\)\+INTERVAL '8 days'/);
  assert.match(job, /runAutomaticReminderPass/);
  assert.match(job, /NOT EXISTS \([\s\S]*sms_notification_batches/);
  assert.match(job, /event_date=\(\(CURRENT_TIMESTAMP AT TIME ZONE e\.timezone\)::date \+ 1\)/);
  assert.match(publicRoute, /router\.get\('\/t\/:token'/);
  assert.match(publicRoute, /sms_phone_verified_at=COALESCE\(sms_phone_verified_at,NOW\(\)\)/);
  assert.match(publicRoute, /setAttendeeCookie\(res, row\.event_id, row\.manage_token\)/);
  assert.match(manage, /No guests have opted in to text reminders yet/);
  assert.match(manage, /textContent = 'Add funds'/);
  assert.match(manage, /smsPreviewState\?\.needsFunds/);
  assert.doesNotMatch(manage, /SEND_TOMORROW_SMS/);
});
