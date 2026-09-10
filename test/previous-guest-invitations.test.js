const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderPreviousGuestInvitationEmail } = require('../src/lib/mailer');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('previous-guest invitation storage is nullable, retryable, and one-shot per target event', () => {
  const migration = read('src/db/migrations/029_previous_guest_invitations.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS previous_guest_invitation_batches/);
  assert.match(migration, /target_event_id\s+INT NOT NULL UNIQUE REFERENCES events\(id\) ON DELETE CASCADE/);
  assert.match(migration, /source_event_id\s+INT REFERENCES events\(id\) ON DELETE SET NULL/);
  assert.match(migration, /previous_guest_invitation_batch_id BIGINT/);
  assert.match(migration, /recipient_name TEXT/);
  assert.match(migration, /'previous_guest_invite'/);
  assert.match(migration, /message_log_previous_guest_invitation_dedupe_uq/);
});

test('manage page reviews one past crowd in a responsive, non-interruptive dialog', () => {
  const view = read('src/views/event-manage.html');
  const client = read('public/js/manage.js');
  const styles = read('public/css/previous-guest-invites.css');
  const promotion = view.slice(view.indexOf('<section class="promotion-card"'), view.indexOf('<div class="guest-head">'));

  assert.match(promotion, /id="invite-previous-guests"/);
  assert.match(view, /<dialog class="previous-guests-dialog"/);
  assert.match(view, /Bring this crowd back/);
  assert.match(view, /Choose a past event/);
  assert.match(client, /previous-guests\?sourceEventId=/);
  assert.match(client, /data-previous-guest/);
  assert.match(client, /Send \$\{selected\.length\}/);
  assert.match(client, /Named \+1s are never added automatically/);
  assert.match(client, /method: 'POST'/);
  assert.match(styles, /@media \(max-width:620px\)/);
  assert.match(styles, /margin:auto 0 0/);
  assert.ok(promotion.indexOf('download-qr') < promotion.indexOf('invite-previous-guests'));
  assert.ok(promotion.indexOf('invite-previous-guests') < promotion.indexOf('announce'));
});

test('invitation email is artwork-led, escaped, unsubscribable, and one-way', () => {
  const html = renderPreviousGuestInvitationEmail({
    event: {
      slug: 'next-night', title: 'Next <Night>', event_date: '2030-11-14', start_time: '20:00',
      venue_name: 'Test Hall', venue_address: '1 Test Way', presentation_mode: 'standard',
      cover_image_url: 'https://images.example.test/next-night.jpg'
    },
    recipientName: 'Ari <Guest>',
    organizerLabel: 'Host & Friends',
    unsubscribeUrl: 'https://silvergliderevents.com/unsubscribe?token=safe&host=1'
  });
  assert.match(html, /An invitation from Host &amp; Friends/);
  assert.match(html, /Hi Ari. Host &amp; Friends thought you’d like this next event./);
  assert.match(html, /Next &lt;Night&gt;/);
  assert.match(html, /next-night\.jpg/);
  assert.match(html, /View event/);
  assert.match(html, /Unsubscribe from this host/);
  assert.match(html, /token=safe&amp;host=1/);
  assert.doesNotMatch(html, /<Night>/);

  const mailer = read('src/lib/mailer.js');
  const sender = mailer.slice(
    mailer.indexOf('async function sendPreviousGuestInvitation'),
    mailer.indexOf('function photoRequestArtwork')
  );
  assert.doesNotMatch(sender, /replyTo/);
});

test('future-event consent language is explicit in both public RSVP modes', () => {
  for (const template of ['src/views/event-public.html', 'src/views/event-public-flyer.html']) {
    const view = read(template);
    assert.match(view, /id="sms_optin"/);
    assert.match(view, /id="organizer_optin"/);
    assert.match(view, /\{\{EMAIL_CONSENT_HEADING\}\}/);
    assert.match(view, /<small>Unsubscribe anytime\.<\/small>/);
    assert.equal((view.match(/class="channel-consent-copy"/g) || []).length, 2);
    assert.doesNotMatch(view, /Invite me to future events from this host/);
  }
});

test('server eligibility excludes opt-outs, +1s, existing attendees, duplicates, and Secret Shows', () => {
  const routes = read('src/routes/events.js');
  const helper = routes.slice(routes.indexOf('async function eligiblePreviousGuests'), routes.indexOf('// GET /api/events/:id/previous-guests'));
  assert.match(helper, /r\.status='confirmed' AND r\.organizer_optin=TRUE/);
  assert.match(helper, /follower_optouts/);
  assert.match(helper, /target_rsvp\.status='confirmed'/);
  assert.match(helper, /message_type IN \('announcement','previous_guest_invite'\)/);
  assert.doesNotMatch(helper, /guest_email/);
  assert.match(routes, /target\.secret_show_enabled/);
  assert.match(routes, /rsvpIds\.length > 500/);
  assert.match(routes, /Previous guests were already invited to this event/);
});
