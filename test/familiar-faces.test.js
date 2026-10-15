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
  assert.match(page, /Help friends recognize you\.\{\{EVENT_RETURN_NOTE\}\}/);
  assert.match(page, /Skip for now/);
  assert.match(page, /Back\{\{BACK_LABEL\}\}/);
  assert.match(page, /up to 20 MB · optimized automatically/);
  assert.match(client, /api\/uploads\/avatar/);
  assert.match(client, /SGImageOptimizer\.optimizeAvatar/);
  assert.match(client, /setTimeout\(\(\) => location\.assign\(returnUrl\), 2000\)/);
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
  assert.match(html, /Unsubscribe from Heatwave Booking/);
  assert.match(html, /Manage email settings/);
  assert.match(html, /490 Post Street, Suite 500/);
});

test('SMS lifecycle copy is untouched by the photo opportunity', () => {
  const smsLifecycle = read('src/lib/sms-lifecycle.js');
  assert.doesNotMatch(smsLifecycle, /Add (?:your |a )?photo|friends recognize/);
});

test('"Your crowd" groups filter the picker, and a public event can invite a whole group in one tap', () => {
  const routes = read('src/routes/events.js');
  const manage = read('public/js/manage.js');
  const view = read('src/views/event-manage.html');

  // The five ways a host thinks about past guests, in their words.
  for (const label of ['Regulars', 'Last time', 'Been a while', 'New faces', 'Came once']) {
    assert.ok(routes.includes(`'${label}'`), `${label} group is defined`);
  }
  assert.match(routes, /p\.event_count >= 2/);
  assert.match(routes, /p\.in_last_event/);
  assert.match(routes, /p\.first_event_id = p\.last_hosted_event_id/);
  assert.match(routes, /CURRENT_DATE - INTERVAL '6 months'/);
  assert.match(routes, /p\.event_count = 1 AND NOT p\.in_last_event/);
  // One eligibility CTE feeds the list, the counts and a group invitation.
  assert.match(routes, /const ELIGIBLE_PEOPLE_CTE/);
  assert.match(routes, /PEOPLE_GROUP_KEYS\.includes\(requestedGroup\)/);
  assert.match(routes, /LIMIT 501/, 'a group invitation still respects the 500 cap');

  // Public events get one tap; private events start with nobody selected.
  assert.match(manage, /eventData\?\.visibility === 'public' && count > 0 && !peopleSelection\.size && !peopleBulk/);
  assert.match(manage, /group: bulk\.group[\s\S]*search: peopleSearch/);
  assert.match(routes, /group && target\.visibility !== 'public'/);
  assert.match(view, /id="familiar-people-groups"/);
  assert.match(view, /id="familiar-people-bulk-btn"/);
});

test('the host sees proof the guest list works: returning counts and per-face visits', () => {
  const routes = read('src/routes/events.js');
  const editor = read('src/lib/event-editor.js');
  const manage = read('public/js/manage.js');
  const view = read('src/views/event-manage.html');

  // Returning = a confirmed RSVP to an earlier event owned by the same host.
  assert.match(editor, /AS returning_count/);
  assert.match(editor, /prior_event\.event_date < e\.event_date/);
  assert.match(editor, /prior\.status='confirmed'/);
  // From invites = they answered a Familiar Faces invitation for this event.
  assert.match(editor, /AS invited_returning_count/);
  assert.match(editor, /invitation\.message_type='previous_guest_invite'/);
  assert.match(editor, /invitation\.created_at <= current_rsvp\.created_at/);
  assert.match(routes, /visitLabel: visits > 1 \? `\$\{ordinal\(visits\)\} time` : 'First time'/);

  assert.match(manage, /returningLine\.textContent/);
  assert.match(manage, /came from your invites/);
  assert.match(manage, /returning === 1 \? 'has been' : 'have been'/);
  assert.match(manage, /\$\('stat-returning'\)\.textContent = returningStat/);
  assert.match(view, /id="manage-mobile-returning"/);
  assert.match(view, /id="stat-returning"/);
  assert.match(view, /<span>Returning guests<\/span>/);
});

test('Familiar Faces CSV is one readable row per person in the event time zone', () => {
  const { familiarFacesToCsv, csvEscape } = require('../src/lib/csv');
  const csv = familiarFacesToCsv({
    timeZone: 'America/Los_Angeles',
    going: [{
      first_name: 'Maya', last_name: 'Lopez', email: 'maya@example.test', phone: '+14155550134',
      guest_first_name: 'Sam', guest_last_name: 'Friend', visit_count: 3,
      wants_reminders: true, texts_ok: false, organizer_optin: true,
      created_at: '2030-10-11T03:05:00Z'
    }],
    invited: [{ recipient_name: 'Ari', recipient: ' ari@example.test ', created_at: '2030-10-01T17:00:00Z' }],
    declined: [{ first_name: '=HYPERLINK("x")', last_name: '', email: 'd@example.test', organizer_optin: false, created_at: '2030-10-02T17:00:00Z' }]
  });
  const lines = csv.replace(/\n$/, '').split('\n');
  assert.equal(lines[0], 'Name,Email,Phone,Status,Plus one,Times with you,Reminders,Texts OK,Updates from you,Date (America/Los_Angeles)');
  assert.equal(lines[1], `Maya Lopez,maya@example.test,+14155550134,Going,Sam Friend,3,Yes,No,Yes,2030-10-10 20:05`);
  assert.equal(lines[2], 'Ari,ari@example.test,,Invited,,,,,,2030-10-01 10:00');
  assert.match(lines[3], /^"'=HYPERLINK\(""x""\)",d@example\.test,,Can’t make it,/);
  assert.equal(lines.length, 4);
  assert.equal(csvEscape('@SUM(1)'), "'@SUM(1)");
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('+1 (415) 555-0134'), '+1 (415) 555-0134');
  assert.equal(csvEscape('+1+cmd|calc'), "'+1+cmd|calc");
});

test('Familiar Faces groups the grid into going, invited and can’t make it', () => {
  const client = read('public/js/manage.js');
  const routes = read('src/routes/events.js');
  assert.match(client, /title: 'Going'/);
  assert.match(client, /title: 'Invited, no answer yet'/);
  assert.match(client, /title: 'Can’t make it', collapsed: true/);
  assert.match(client, /\$\{data\.goingCount\} going/);
  assert.doesNotMatch(client, /RSVP’d and invited/);
  assert.match(routes, /goingCount: countOf\('going'\)/);
  assert.match(routes, /familiarFacesToCsv\(/);
});
