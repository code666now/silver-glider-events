const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderRsvpConfirmationEmail, renderPreviousGuestInvitationEmail } = require('../src/lib/mailer');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Familiar Faces replaces CRM rows while preserving search and CSV export', () => {
  const view = read('src/views/event-manage.html');
  const client = read('public/js/manage.js');
  const styles = read('public/css/familiar-faces.css');

  assert.match(view, />Familiar Faces</);
  assert.match(view, /id="familiar-faces-grid"/);
  assert.match(view, /id="search"[^>]+Search people/);
  assert.match(view, /id="export-csv"[^>]*>Export CSV/);
  assert.doesNotMatch(view, /<th>Attendee<\/th>|Attendee email|Guest email/);
  assert.match(client, /face\.avatarUrl/);
  assert.match(client, /face\.avatarEmoji \|\| familiarInitials/);
  assert.match(client, /class="familiar-face-name"/);
  assert.match(client, /face\.status/);
  assert.doesNotMatch(client, /guest-inline-email/);
  assert.match(styles, /border-radius:50%/);
  assert.match(styles, /\.familiar-face-emoji/);
  assert.match(styles, /@media \(max-width:720px\)/);
});

test('old-event invitation flow selects faces, chooses an upcoming event, reviews, and sends', () => {
  const view = read('src/views/event-manage.html');
  const client = read('public/js/manage.js');
  const routes = read('src/routes/events.js');
  const migration = read('src/db/migrations/035_familiar_faces.sql');

  assert.match(view, />Invite to another event</);
  assert.match(view, /id="familiar-select-all"[^>]*>Select all/);
  assert.match(view, /Invite them to…/);
  assert.match(client, /Invite \$\{count\}/);
  assert.match(client, /Review invitation/);
  assert.match(client, /Send \$\{target\.eligibleCount\}/);
  assert.match(client, /familiar-faces\/preview/);
  assert.match(client, /familiar-faces\/invite/);
  assert.match(routes, /router\.get\('\/api\/events\/:id\/familiar-faces'/);
  assert.match(routes, /router\.post\('\/api\/events\/:id\/familiar-faces\/preview'/);
  assert.match(routes, /router\.post\('\/api\/events\/:id\/familiar-faces\/invite'/);
  const recipientHelper = routes.slice(
    routes.indexOf('async function selectedFamiliarFaceRecipients'),
    routes.indexOf('async function targetRecipientState')
  );
  assert.match(recipientHelper, /r\.status='confirmed'/);
  assert.doesNotMatch(recipientHelper, /organizer_optin/);
  assert.match(routes, /follower_optouts/);
  assert.match(routes, /targetRecipientState/);
  assert.match(routes, /faceIds\.length > 500/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS previous_guest_invitation_batches_target_event_id_key/);
  assert.match(migration, /message_log_previous_guest_target_recipient_uq/);
});

test('Familiar Faces photo identity is verified, reusable, and never attached by arbitrary email alone', () => {
  const routes = read('src/routes/events.js');
  const publicRoutes = read('src/routes/public.js');
  const index = read('src/index.js');
  const page = read('src/views/add-photo.html');
  const client = read('public/js/add-photo.js');

  assert.match(routes, /LEFT JOIN organizers o ON o\.id=r\.account_id/);
  assert.match(routes, /attendeeAvatar\(`email:/);
  assert.doesNotMatch(routes, /JOIN organizers o ON LOWER\(o\.email\)=LOWER\(r\.email\)/);
  // The confirmation's photo link is a photo-only grant, never an account
  // session: /add-photo accepts it, the dashboard does not.
  assert.match(index, /app\.get\('\/add-photo', requirePhotoAccess/);
  assert.match(index, /app\.get\('\/dashboard', requireOrganizer/);
  assert.match(page, />Add your photo</);
  assert.match(page, /Help friends recognize you\./);
  assert.match(page, /Skip for now/);
  assert.match(client, /api\/uploads\/avatar/);
  assert.match(client, /scope === 'photo'/);
  assert.doesNotMatch(client, /userId|organizerId/);
  assert.match(publicRoutes, /intent: 'add_photo'/);
  assert.match(publicRoutes, /returnPath: `\/add-photo\?event=/);
  assert.match(publicRoutes, /ttlMinutes: 7 \* 24 \* 60/);
  assert.match(publicRoutes, /withCode: false/);
});

test('RSVP confirmation asks for a photo only when a secure URL is supplied', () => {
  const event = {
    title: 'Familiar Night', slug: 'familiar-night', event_date: '2030-10-10', start_time: '20:00',
    venue_name: 'Test Hall', venue_address: '1 Test Way', presentation_mode: 'standard',
    cover_image_url: null, comments_enabled: false, artwork_accent_color: '#1CC5BE'
  };
  const rsvp = { first_name: 'Maya', manage_token: 'private-token', wants_reminders: true };
  const withoutPhotoAsk = renderRsvpConfirmationEmail({ event, rsvp });
  const withPhotoAsk = renderRsvpConfirmationEmail({
    event,
    rsvp,
    addPhotoUrl: 'https://silvergliderevents.com/auth/verify?token=one-time-token'
  });
  assert.doesNotMatch(withoutPhotoAsk, /Help friends recognize you|>Add photo<\/a>/);
  assert.match(withPhotoAsk, /Add your photo/);
  assert.match(withPhotoAsk, /Help friends recognize you\./);
  assert.match(withPhotoAsk, />Add photo<\/a>/);
  assert.match(withPhotoAsk, /token=one-time-token/);
});

test('reusable guest invitation keeps artwork and uses one RSVP call to action', () => {
  const html = renderPreviousGuestInvitationEmail({
    event: {
      title: 'Next Night', slug: 'next-night', event_date: '2030-10-10', start_time: '20:00',
      venue_name: 'Test Hall', venue_address: '1 Test Way', presentation_mode: 'standard',
      cover_image_url: 'https://images.example.test/art.jpg'
    },
    recipientName: 'Maya Lopez',
    organizerLabel: 'Heatwave Booking',
    sourceEventTitle: 'Summer Party',
    unsubscribeUrl: 'https://silvergliderevents.com/unsubscribe?token=safe'
  });
  assert.match(html, />RSVP<\/a>/);
  assert.doesNotMatch(html, />View event<\/a>/);
  assert.match(html, /art\.jpg/);
  assert.match(html, /RSVP’d to Summer Party, hosted by Heatwave Booking/);
  assert.match(html, /Unsubscribe from invitations from this host/);
});

test('SMS lifecycle copy is untouched by the photo opportunity', () => {
  const smsLifecycle = read('src/lib/sms-lifecycle.js');
  assert.doesNotMatch(smsLifecycle, /Add (?:your |a )?photo|friends recognize/);
});
