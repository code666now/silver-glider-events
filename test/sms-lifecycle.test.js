const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTomorrowMessage,
  buildFollowerAnnouncementMessage,
  assertSingleSegmentMessage,
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
  assert.equal(body, 'Heatwave Booking: Your event is tomorrow. Details: https://silvergliderevents.com/e/the-mummies Reply STOP to opt out.');
  assert.equal(smsSegments(body).segments, 1);

  const personal = buildTomorrowMessage({
    organizer_label: 'Heatwave Booking',
    title: 'The Mummies',
    venue_name: 'Make Out Room',
    slug: 'the-mummies'
  }, 'https://silvergliderevents.com/', 'a'.repeat(32));
  assert.match(personal, /https:\/\/silvergliderevents\.com\/t\/a{32}/);
  assert.doesNotMatch(personal, /\/e\/the-mummies/);
  assert.equal(smsSegments(personal).segments, 1);
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
  assert.match(fulfillment, /reserveSendCreditsDetailed\(client/);
  assert.match(route, /confirm !== 'SEND_TOMORROW_SMS'/);
  assert.match(fulfillment, /event\.is_tomorrow/);
  assert.match(fulfillment, /r\.sms_optin=TRUE/);
  assert.match(job, /runAutomaticReminderPass/);
  assert.match(job, /minimumLocalHour = 16/);
  assert.match(route, /twilio\.webhook/);
  assert.doesNotMatch(client, /SEND_TOMORROW_SMS/);
  assert.doesNotMatch(client, /body:\s*\{[^}]*messageBody/);
});

test('controlled SMS stays one GSM-7 segment with long or decorative host names', () => {
  for (const organizer_label of ['Adrian Martinez', 'Call Me A Taxi Booking', 'A'.repeat(1000), 'DJ 🎉 José’s — Night', '東京音楽', '^{}[]'.repeat(100), '\n\t  ']) {
    const event = { id: 2147483647, organizer_label, slug: 'x'.repeat(2000) };
    const reminder = buildTomorrowMessage(event, 'https://silvergliderevents.com', 'a'.repeat(32));
    const announcement = buildFollowerAnnouncementMessage(event, 'https://silvergliderevents.com');
    for (const body of [reminder, announcement]) {
      assert.equal(smsSegments(body).encoding, 'GSM-7');
      assert.equal(smsSegments(body).segments, 1);
      assert.match(body, /Reply STOP to opt out\.$/);
    }
    assert.ok(reminder.includes(`/t/${'a'.repeat(32)}`), 'all 128 token bits are preserved');
    assert.ok(announcement.includes('/s/e/2147483647'), 'unbounded slug never leaks into the SMS budget');
  }
});

test('oversized or invalid link configurations fail closed, never truncate a link', () => {
  const event = { id: 42, organizer_label: 'Host' };
  for (const root of ['https://example.com/' + 'a'.repeat(200), 'https://user:pass@example.com', 'javascript:alert(1)', 'https://example.com?query=1']) {
    assert.throws(() => buildTomorrowMessage(event, root, 'a'.repeat(32)), { code: 'sms_single_segment_required' });
    assert.throws(() => buildFollowerAnnouncementMessage(event, root), { code: 'sms_single_segment_required' });
  }
  assert.throws(() => buildTomorrowMessage(event, undefined, 'short'), { code: 'sms_single_segment_required' });
  assert.throws(() => buildFollowerAnnouncementMessage({ id: '../private' }), { code: 'sms_single_segment_required' });
  assert.throws(() => assertSingleSegmentMessage('☃ Reply STOP to opt out.'), { code: 'sms_single_segment_required' });
  assert.throws(() => assertSingleSegmentMessage('A'.repeat(200) + ' Reply STOP to opt out.'), { code: 'sms_single_segment_required' });
});
