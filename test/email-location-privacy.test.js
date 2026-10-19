const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://silvergliderevents.com';

const {
  devOutbox,
  renderEventCancellationEmail,
  renderEventUpdateEmail,
  renderPreviousGuestInvitationEmail,
  sendDayBeforeReminder,
  sendEventAnnouncement,
  sendLineupClaim,
  sendLineupClaimOutcome
} = require('../src/lib/mailer');

const hiddenPrivateEvent = Object.freeze({
  id: 42,
  slug: 'hidden-location-night',
  title: 'Hidden Location Night',
  event_date: '2030-11-14',
  start_time: '20:00',
  venue_name: 'Secret Warehouse',
  venue_address: '123 Hidden Street, Oakland, CA 94607',
  venue_city: 'Oakland',
  venue_state: 'CA',
  visibility: 'private',
  admission_type: 'free_rsvp',
  hide_address_until_rsvp: true,
  presentation_mode: 'standard',
  comments_enabled: true,
  artwork_accent_color: '#1CC5BE'
});

function latestHtml() {
  const message = [...devOutbox].reverse().find(entry => entry.html);
  assert.ok(message?.html, 'expected a rendered development email');
  return message.html;
}

async function captureEmail(sendEmail) {
  devOutbox.length = 0;
  await sendEmail();
  return latestHtml();
}

function assertExactLocationHidden(html, label) {
  assert.match(html, /Oakland, CA/, `${label} keeps useful city and state context`);
  assert.doesNotMatch(html, /Secret Warehouse/, `${label} does not reveal the venue`);
  assert.doesNotMatch(html, /123 Hidden Street|Hidden%20Street/, `${label} does not reveal the street address`);
  assert.doesNotMatch(html, /maps\.google\.com/, `${label} does not include a maps link`);
}

function assertExactLocationVisible(html, label) {
  assert.match(html, /Secret Warehouse/, `${label} keeps the exact venue`);
  assert.match(html, /maps\.google\.com/, `${label} keeps the maps link`);
  assert.match(html, /Hidden%20Street/, `${label} keeps the exact address in the maps destination`);
}

test('pre-RSVP announcement, lineup, and Familiar Faces emails hide exact private-event location', async () => {
  const announcement = await captureEmail(() => sendEventAnnouncement({
    to: 'follower@example.test',
    event: hiddenPrivateEvent,
    organizerLabel: 'Night Host',
    unsubscribeUrl: 'https://silvergliderevents.com/unsubscribe?token=safe'
  }));
  assertExactLocationHidden(announcement, 'announcement');

  const lineupClaim = await captureEmail(() => sendLineupClaim({
    to: 'artist@example.test',
    event: hiddenPrivateEvent,
    artistName: 'The Artist',
    hostLabel: 'Night Host',
    link: 'https://silvergliderevents.com/lineup/safe-token'
  }));
  assertExactLocationHidden(lineupClaim, 'lineup claim');

  const previousGuestInvitation = renderPreviousGuestInvitationEmail({
    event: hiddenPrivateEvent,
    recipientName: 'Maya Lopez',
    organizerLabel: 'Night Host',
    sourceEventTitle: 'Last Party',
    unsubscribeUrl: 'https://silvergliderevents.com/unsubscribe?token=safe'
  });
  assertExactLocationHidden(previousGuestInvitation, 'Familiar Faces invitation');
});

test('location privacy stays inactive for public and external-ticket events', () => {
  for (const [label, event] of [
    ['public event', { ...hiddenPrivateEvent, visibility: 'public' }],
    ['external-ticket event', { ...hiddenPrivateEvent, admission_type: 'external_tickets' }]
  ]) {
    const html = renderPreviousGuestInvitationEmail({
      event,
      recipientName: 'Maya Lopez',
      organizerLabel: 'Night Host',
      sourceEventTitle: 'Last Party',
      unsubscribeUrl: 'https://silvergliderevents.com/unsubscribe?token=safe'
    });
    assertExactLocationVisible(html, label);
  }
});

test('confirmed-attendee and host emails retain the exact private-event location', async () => {
  const rsvp = { manage_token: 'confirmed-rsvp-token' };
  const reminder = await captureEmail(() => sendDayBeforeReminder({
    to: 'attendee@example.test',
    event: hiddenPrivateEvent,
    rsvp
  }));
  assertExactLocationVisible(reminder, 'confirmed-attendee reminder');

  assertExactLocationVisible(renderEventUpdateEmail({
    event: hiddenPrivateEvent,
    rsvp,
    changes: []
  }), 'confirmed-attendee update');
  assertExactLocationVisible(renderEventCancellationEmail({
    event: hiddenPrivateEvent,
    rsvp
  }), 'confirmed-attendee cancellation');

  const hostOutcome = await captureEmail(() => sendLineupClaimOutcome({
    to: 'host@example.test',
    event: hiddenPrivateEvent,
    artistName: 'The Artist',
    status: 'claimed'
  }));
  assertExactLocationVisible(hostOutcome, 'host lineup outcome');
});
