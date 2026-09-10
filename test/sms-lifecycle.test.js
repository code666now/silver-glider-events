const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTomorrowMessage,
  maskPhone,
  previewFingerprint,
  smsSegments
} = require('../src/lib/sms-lifecycle');

test('SMS segment pricing follows GSM-7 and Unicode concatenation limits', () => {
  assert.deepEqual(smsSegments('A'.repeat(160)), { encoding: 'GSM-7', units: 160, segments: 1 });
  assert.equal(smsSegments('A'.repeat(161)).segments, 2);
  assert.deepEqual(smsSegments('☃'.repeat(70)), { encoding: 'UCS-2', units: 70, segments: 1 });
  assert.equal(smsSegments('☃'.repeat(71)).segments, 2);
  assert.equal(smsSegments('👻'.repeat(36)).segments, 2, 'astral symbols consume two UCS-2 units');
  assert.equal(smsSegments('^'.repeat(81)).segments, 2, 'GSM extended characters count as two units');
});

test('tomorrow SMS copy is fixed from event data and includes opt-out language', () => {
  const body = buildTomorrowMessage({
    organizer_label: 'Heatwave Booking',
    title: 'The Mummies',
    venue_name: 'Make Out Room',
    slug: 'the-mummies'
  }, 'https://silvergliderevents.com/');
  assert.equal(body, 'Heatwave Booking: The Mummies is tomorrow at Make Out Room. Details: https://silvergliderevents.com/e/the-mummies Reply STOP to opt out.');
  assert.equal(smsSegments(body).segments, 1);

  const personal = buildTomorrowMessage({
    organizer_label: 'Heatwave Booking',
    title: 'The Mummies',
    venue_name: 'Make Out Room',
    slug: 'the-mummies'
  }, 'https://silvergliderevents.com/', 'a'.repeat(32));
  assert.match(personal, /https:\/\/silvergliderevents\.com\/t\/a{32}/);
  assert.doesNotMatch(personal, /\/e\/the-mummies/);
});

test('SMS previews mask phone numbers and fingerprints change with audience or cost', () => {
  const event = { id: 7, updated_at: new Date('2030-01-01T00:00:00Z') };
  const first = previewFingerprint({
    event,
    recipients: [{ id: 1, phone: '+14155551234' }],
    messageBody: 'Hello',
    creditCost: 1
  });
  const changed = previewFingerprint({
    event,
    recipients: [{ id: 2, phone: '+14155555678' }],
    messageBody: 'Hello',
    creditCost: 1
  });
  assert.notEqual(first, changed);
  assert.equal(maskPhone('+14155551234'), '•••• 1234');
});

test('paid tomorrow SMS stays server-generated, explicitly confirmed, and credit-gated', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sms-notifications.js'), 'utf8');
  const fulfillment = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'sms-reminder-fulfillment.js'), 'utf8');
  const job = fs.readFileSync(path.join(__dirname, '..', 'src', 'jobs', 'sms-notifications.js'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'manage.js'), 'utf8');
  assert.match(fulfillment, /buildTomorrowMessage\(event/);
  assert.match(fulfillment, /reserveSendCredits\(client/);
  assert.match(route, /confirm !== 'SEND_TOMORROW_SMS'/);
  assert.match(fulfillment, /event\.is_tomorrow/);
  assert.match(fulfillment, /r\.sms_optin=TRUE/);
  assert.match(job, /runAutomaticReminderPass/);
  assert.match(job, /minimumLocalHour = 16/);
  assert.match(route, /twilio\.webhook/);
  assert.doesNotMatch(client, /SEND_TOMORROW_SMS/);
  assert.doesNotMatch(client, /body:\s*\{[^}]*messageBody/);
});
