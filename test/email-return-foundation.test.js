const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const {
  renderEventReminderEmail,
  renderEventAnnouncementEmail,
  renderEventUpdateEmail,
  renderEventCancellationEmail,
  renderPreviousGuestInvitationEmail,
  renderSecurityEmailLayout,
  renderEmailCodeBlock,
  renderRsvpConfirmationEmail
} = require('../src/lib/mailer');

const root = path.join(__dirname, '..');
const reminderSource = fs.readFileSync(path.join(root, 'src/jobs/reminders.js'), 'utf8');
const mailerSource = fs.readFileSync(path.join(root, 'src/lib/mailer.js'), 'utf8');
const event = {
  id: 14, organizer_id: 9, title: 'Next <Night>', slug: 'next-night',
  event_date: '2030-12-12', start_time: '14:00', timezone: 'America/Los_Angeles',
  cover_image_url: 'https://images.example.test/artwork.jpg', artwork_accent_color: '#D96524',
  org_name: 'Your <Host>', organizer_public_slug: 'your-host',
  venue_name: 'Private Venue', venue_address: '123 Private Street',
  venue_city: 'San Francisco', venue_state: 'CA', visibility: 'private',
  admission_type: 'free_rsvp', comments_enabled: true
};
const rsvp = { id: 24, user_id: 8, email: 'synthetic@example.test', manage_token: 'private-token', wants_reminders: true };

function transportHarness() {
  const deliveries = [];
  const localRequire = createRequire(path.join(root, 'src/lib/mailer.js'));
  const module = { exports: {} };
  class SyntheticResend {
    constructor() {
      this.emails = {
        send: async (payload, options) => {
          deliveries.push({ payload, options });
          return { data: { id: 'synthetic-provider-id' }, error: null };
        }
      };
    }
  }
  vm.runInNewContext(mailerSource, {
    module, exports: module.exports, URL, Buffer, AbortSignal,
    process: { env: { NODE_ENV: 'test', RESEND_API_KEY: 'synthetic-not-a-provider-key' } },
    console: { log: () => {}, error: () => {} },
    require: name => name === 'resend' ? { Resend: SyntheticResend } : localRequire(name)
  });
  return { mailer: module.exports, deliveries };
}

function reminderHarness({ retry = false, eligible = true, retryClaim = true, failProvider = false } = {}) {
  const calls = [];
  const sent = [];
  const errors = [];
  const fresh = {
    ...event, title: 'Fresh event details',
    current_rsvp_id: rsvp.id, current_user_id: rsvp.user_id,
    current_email: rsvp.email, current_manage_token: 'fresh-private-token',
    current_first_name: 'Synthetic', current_last_name: 'Guest'
  };
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM message_log ml') && sql.includes("ml.status='failed'")) {
      return { rows: retry ? [{ ...event, log_id: 31, message_type: 'reminder_day_before' }] : [] };
    }
    if (sql.includes('EXTRACT(HOUR')) return { rows: !retry && params[0] === 1 ? [event] : [] };
    if (sql.includes('SELECT * FROM rsvps')) return { rows: [rsvp] };
    if (sql.includes('INSERT INTO message_log')) return { rows: [{ id: 31 }] };
    if (sql.includes("error='retried: delivery pending'")) return { rows: retryClaim ? [{ id: 31 }] : [] };
    if (sql.includes('FROM message_log ml') && sql.includes("ml.status='pending'")) {
      assert.match(sql, /r\.event_id=ml\.event_id/);
      assert.match(sql, /r\.status='confirmed' AND r\.wants_reminders=TRUE/);
      assert.match(sql, /e\.status='published'/);
      assert.match(sql, /e\.event_date \+ e\.start_time\) AT TIME ZONE e\.timezone\) > NOW\(\)/);
      assert.match(sql, /LOWER\(TRIM\(r\.email\)\)=LOWER\(TRIM\(ml\.recipient\)\)/);
      assert.match(sql, /e\.organizer_id=\$3/);
      assert.match(sql, /e\.event_date = \(\(NOW\(\) AT TIME ZONE e\.timezone\)::date \+ \$4::int\)/);
      assert.doesNotMatch(sql, /event_email_optin|organizer_optin/);
      assert.equal(params[2], event.organizer_id);
      assert.equal(params[3], 1);
      return { rows: eligible ? [fresh] : [] };
    }
    if (sql.includes('UPDATE message_log')) return { rows: [] };
    throw new Error(`Unexpected mock query: ${sql}`);
  };
  const sender = async payload => {
    calls.push({ phase: 'provider' });
    sent.push(payload);
    if (failProvider) throw new Error('synthetic provider unavailable');
    return { id: 'synthetic-message' };
  };
  const module = { exports: {} };
  vm.runInNewContext(reminderSource, {
    module, exports: module.exports, process: { env: {} },
    console: { error: (...args) => errors.push(args), log: () => {} },
    require: name => {
      if (name === 'node-cron') return { schedule: () => {} };
      if (name === '../config/db') return { query };
      if (name === '../lib/mailer') return { sendDayBeforeReminder: sender, sendDayOfReminder: sender };
      if (name === '../lib/outbound-account-status') return {
        HOST_ACCOUNT_INACTIVE: 'host_account_inactive',
        withActiveHostAccount: async (_pool, _id, deliver) => {
          calls.push({ phase: 'host-gate' });
          return { allowed: true, result: await deliver({ query }) };
        }
      };
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  return { run: module.exports.runReminderPass, calls, sent, errors };
}

test('first reminders re-read live eligibility under the active-host gate and render current details', async () => {
  const harness = reminderHarness();
  await harness.run();
  assert.equal(harness.errors.length, 0);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].event.title, 'Fresh event details');
  assert.equal(harness.sent[0].rsvp.manage_token, 'fresh-private-token');
  assert.equal(harness.sent[0].idempotencyKey, 'reminder:reminder_day_before:31');
  const eligibilityIndex = harness.calls.findIndex(call => call.sql?.includes('FROM message_log ml') && call.sql?.includes("ml.status='pending'"));
  assert.ok(harness.calls.findIndex(call => call.phase === 'host-gate') < eligibilityIndex);
  assert.ok(eligibilityIndex < harness.calls.findIndex(call => call.phase === 'provider'));
  assert.match(harness.calls.find(call => call.sql?.includes('EXTRACT(HOUR')).sql, /AT TIME ZONE e\.timezone\) > NOW\(\)/);
});

test('a stale first-reminder candidate is permanently suppressed without a provider call', async () => {
  const harness = reminderHarness({ eligible: false });
  await harness.run();
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.errors.length, 0);
  assert.ok(harness.calls.some(call => call.sql?.includes("error='cancelled: reminder no longer eligible'")));
  assert.ok(!harness.calls.some(call => call.sql?.includes("SET status='sent'")));
});

test('failed reminders claim the one retry atomically before rechecking eligibility', async () => {
  const harness = reminderHarness({ retry: true });
  await harness.run();
  assert.equal(harness.errors.length, 0);
  assert.equal(harness.sent.length, 1);
  const claim = harness.calls.findIndex(call => call.sql?.includes("error='retried: delivery pending'"));
  const gate = harness.calls.findIndex(call => call.phase === 'host-gate');
  assert.ok(claim >= 0 && claim < gate);
  assert.match(harness.calls[claim].sql, /WHERE id=\$1 AND status='failed'/);
  assert.match(harness.calls[claim].sql, /created_at > NOW\(\) - INTERVAL '20 hours'/);
  assert.match(harness.calls[claim].sql, /error NOT LIKE 'retried:%' AND error NOT LIKE 'cancelled:%'/);
});

test('a competing reminder retry claim cannot reach the provider', async () => {
  const harness = reminderHarness({ retry: true, retryClaim: false });
  await harness.run();
  assert.equal(harness.errors.length, 0);
  assert.equal(harness.sent.length, 0);
  assert.ok(!harness.calls.some(call => call.phase === 'host-gate'));
});

test('cancelled, opted-out, unpublished, moved-past or changed-recipient retries are suppressed by the final query', async () => {
  const harness = reminderHarness({ retry: true, eligible: false });
  await harness.run();
  assert.equal(harness.sent.length, 0);
  assert.ok(harness.calls.some(call => call.sql?.includes("error='cancelled: reminder no longer eligible'")));
});

test('a retry provider failure remains failed and cannot claim a third attempt', async () => {
  const harness = reminderHarness({ retry: true, failProvider: true });
  await harness.run();
  assert.equal(harness.sent.length, 1);
  const failure = harness.calls.find(call => call.sql?.includes("SET status='failed', error=$2") && call.params?.[1]?.startsWith('retried:'));
  assert.ok(failure);
});

test('guest reminder, update, cancellation and announcement use the artwork-led event family', () => {
  const variants = [
    renderEventReminderEmail({ event, rsvp, kicker: 'Today', headline: 'See you today.' }),
    renderEventUpdateEmail({ event, rsvp, changes: [{ label: 'Time', before: '1 PM', after: '2 PM' }] }),
    renderEventCancellationEmail({ event, rsvp }),
    renderEventAnnouncementEmail({ event, organizerLabel: 'Your <Host>', unsubscribeUrl: 'https://example.test/unsubscribe' })
  ];
  for (const html of variants) {
    assert.ok(html.indexOf('class="sg-event-artwork"') < html.indexOf('class="sg-event-title"'));
    assert.ok(html.indexOf('class="sg-event-title"') < html.indexOf('logo.png'));
    assert.match(html, /Next &lt;Night&gt;/);
    assert.match(html, /border-radius:12px/);
    assert.match(html, /@media only screen and \(max-width:620px\)/);
    assert.match(html, /Replies are not monitored/);
    assert.doesNotMatch(html, /Host your own event|Music vibe/);
  }
  assert.match(variants[0], /\/r\/private-token\/calendar\.ics/);
  assert.match(variants[0], /\/r\/private-token\/event/);
});

test('follower announcements redact protected venue and maps while confirmed reminders retain them', () => {
  const privateEvent = { ...event, hide_address_until_rsvp: true };
  const announcement = renderEventAnnouncementEmail({ event: privateEvent, organizerLabel: 'Host', replyTo: 'host@example.test' });
  assert.doesNotMatch(announcement, /Private Venue|123 Private Street|maps\.google/);
  assert.doesNotMatch(announcement, /Replies are not monitored/);
  const reminder = renderEventReminderEmail({ event: privateEvent, rsvp });
  assert.match(reminder, /Private Venue/);
  assert.match(reminder, /maps\.google/);
});

test('invitation explicitly explains one-way replies and event confirmation accurately describes both reminders', () => {
  const invitation = renderPreviousGuestInvitationEmail({ event, organizerLabel: 'Host', recipientName: 'Synthetic', sourceEventTitle: 'Old Night' });
  assert.match(invitation, /Replies are not monitored/);
  const confirmation = renderRsvpConfirmationEmail({ event, rsvp });
  assert.match(confirmation, /Reminders are scheduled for the day before and the day of the event\./);
  assert.doesNotMatch(confirmation, /one reminder the day before/);
  assert.match(mailerSource, /Number\(String\(event\.start_time\)\.split\(':'\)\[0\]\) >= 17 \? 'See you tonight\.' : 'See you today\.'/);
});

test('security layout is compact, escaped and keeps the code contiguous without marketing', () => {
  const html = renderSecurityEmailLayout({ kicker: 'Sign in', headline: 'Confirm <you>', sub: 'Enter your code.', bodyHtml: renderEmailCodeBlock('123456') });
  assert.match(html, /max-width:520px/);
  assert.match(html, /width="48" height="48"/);
  assert.match(html, /Confirm &lt;you&gt;/);
  assert.match(html, />123456<\/p>/);
  assert.doesNotMatch(html, /Create your event|Follow|Host your own event/);
  for (const name of ['sendMagicLink', 'sendAccountClaimInvitation', 'sendVerificationCode', 'sendAccountVerificationCode', 'sendAdminIdentityChangeVerification', 'sendAdminPasscode']) {
    const start = mailerSource.indexOf(`async function ${name}`);
    const next = mailerSource.indexOf('\nasync function ', start + 1);
    const section = mailerSource.slice(start, next < 0 ? undefined : next);
    assert.ok(section.indexOf('html: securityLayout(') >= 0, `${name} should use the compact task layout`);
  }
});

test('optional host transport requires unsubscribe and idempotency and aborts the underlying request on timeout', async () => {
  const { mailer, deliveries } = transportHarness();
  const options = {
    to: 'synthetic@example.test', subject: 'Next night', html: '<p>Next night</p>',
    unsubscribeUrl: 'https://example.test/unsubscribe', idempotencyKey: 'synthetic-next-night'
  };
  await assert.rejects(mailer.sendOptionalHostEmail({ ...options, unsubscribeUrl: 'javascript:alert(1)' }), /unsubscribe URL/);
  await assert.rejects(mailer.sendOptionalHostEmail({ ...options, idempotencyKey: '' }), /idempotency key/);
  assert.equal(deliveries.length, 0);
  await mailer.sendOptionalHostEmail(options);
  assert.equal(deliveries[0].options.idempotencyKey, options.idempotencyKey);
  assert.ok(deliveries[0].options.signal instanceof AbortSignal);
  assert.equal(deliveries[0].options.signal.aborted, false);
  assert.equal(deliveries[0].payload.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

test('day-of sender uses daytime or evening copy and keeps the stable reminder key', async () => {
  const { mailer, deliveries } = transportHarness();
  await mailer.sendDayOfReminder({ to: rsvp.email, event, rsvp, idempotencyKey: 'reminder:day-of:1' });
  await mailer.sendDayOfReminder({ to: rsvp.email, event: { ...event, start_time: '20:00' }, rsvp, idempotencyKey: 'reminder:day-of:2' });
  assert.match(deliveries[0].payload.html, /See you today\./);
  assert.doesNotMatch(deliveries[0].payload.html, /See you tonight\./);
  assert.match(deliveries[1].payload.html, /See you tonight\./);
  assert.equal(deliveries[0].options.idempotencyKey, 'reminder:day-of:1');
  assert.ok(deliveries[0].options.signal instanceof AbortSignal);
});

test('follower Reply-To preserves a real address and rejects missing or header-injected values', async () => {
  const { mailer, deliveries } = transportHarness();
  const options = { to: rsvp.email, event, organizerLabel: 'Host', unsubscribeUrl: 'https://example.test/unsubscribe' };
  await mailer.sendEventAnnouncement(options);
  await mailer.sendEventAnnouncement({ ...options, replyTo: 'Host <host@example.test>' });
  await mailer.sendEventAnnouncement({ ...options, replyTo: 'host@example.test\r\nBcc: other@example.test' });
  assert.equal(deliveries[0].payload.replyTo, undefined);
  assert.equal(deliveries[1].payload.replyTo, 'host@example.test');
  assert.equal(deliveries[2].payload.replyTo, undefined);
  assert.match(deliveries[0].payload.html, /Replies are not monitored/);
  assert.match(deliveries[2].payload.html, /Replies are not monitored/);
});
