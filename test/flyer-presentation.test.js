const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  renderRsvpConfirmationEmail,
  renderFlyerReminderEmail
} = require('../src/lib/mailer');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const flyerEvent = {
  title: 'Night Garden',
  event_date: '2026-09-05',
  start_time: '21:00',
  venue_name: 'The Conservatory',
  venue_address: '1 Garden Way, San Francisco, CA',
  slug: 'night-garden',
  comments_enabled: true,
  presentation_mode: 'flyer',
  flyer_image_url: 'https://res.cloudinary.com/demo/image/upload/sg-events/flyers/night-garden.webp',
  org_name: 'Heat Wave Booking',
  organizer_public_slug: 'heat-wave-booking'
};

const rsvp = {
  first_name: 'Avery',
  manage_token: 'attendee-secret-token',
  wants_reminders: true
};

test('migration safely defaults and constrains flyer presentation on the existing events table', () => {
  const migration = read('src/db/migrations/016_flyer_presentation_mode.sql');
  assert.match(migration, /ALTER TABLE events/);
  assert.match(migration, /presentation_mode TEXT NOT NULL DEFAULT 'standard'/);
  assert.match(migration, /flyer_image_url TEXT/);
  assert.match(migration, /presentation_mode IN \('standard', 'flyer'\)/);
  assert.match(migration, /presentation_mode <> 'flyer'/);
  assert.match(migration, /SET presentation_mode = 'standard'/);
});

test('flyer uploads and event writes reuse authenticated, size-limited infrastructure', () => {
  const uploads = read('src/routes/uploads.js');
  const cloudinary = read('src/lib/cloudinary.js');
  const events = read('src/routes/events.js');
  assert.match(uploads, /router\.post\('\/api\/uploads\/flyer', requireOrganizer, handleUpload/);
  assert.match(uploads, /fileSize: 5 \* 1024 \* 1024/);
  assert.match(cloudinary, /folder: flyerFolder/);
  assert.match(cloudinary, /crop: 'limit'/);
  assert.match(events, /A flyer image is required for Flyer presentation/);
  assert.match(events, /isManagedFlyerUrl/);
  assert.match(events, /presentation_mode, flyer_image_url/);
  assert.match(events, /e\.presentation_mode \|\| 'standard', e\.flyer_image_url \|\| null/);
});

test('create and edit form default to Standard and require an uploaded flyer in Flyer mode', () => {
  const html = read('src/views/event-form.html');
  const js = read('public/js/event-form.js');
  assert.match(html, /<legend>Page style<\/legend>/);
  assert.match(html, /type="radio" name="presentation_mode" id="presentation-standard" value="standard" checked/);
  assert.match(html, /type="radio" name="presentation_mode" id="presentation-flyer" value="flyer"/);
  assert.match(html, /id="page-style-help"/);
  assert.match(html, /id="flyer-input"[^>]+image\/jpeg,image\/png,image\/webp,image\/gif/);
  assert.match(js, /xhr\.open\('POST', '\/api\/uploads\/flyer'\)/);
  assert.match(js, /presentation_mode: presentationMode/);
  assert.match(js, /flyer_image_url: \$\('flyer_image_url'\)\.value \|\| null/);
  assert.match(js, /setPresentationMode\(event\.presentation_mode === 'flyer'/);
  assert.match(js, /Upload a flyer before publishing this event/);
});

test('Standard artwork actions keep local upload separate from free-photo browsing', () => {
  const html = read('src/views/event-form.html');
  const js = read('public/js/event-form.js');
  assert.match(html, /id="btn-upload"[^>]*>Choose image<\/button>/);
  assert.match(html, /id="btn-search"[^>]*>Browse free photos<\/button>/);
  assert.match(js, /drop\.addEventListener\('click', event => \{\s*if \(event\.target !== fileInput\) fileInput\.click\(\);\s*\}\)/);
  assert.match(js, /\$\('btn-upload'\)\.addEventListener\('click', \(\) => fileInput\.click\(\)\)/);
  assert.match(js, /\$\('btn-search'\)\.addEventListener\('click', openImageModal\)/);
  assert.doesNotMatch(js, /drop\.addEventListener\('click', openImageModal\)/);
  assert.doesNotMatch(js, /\$\('btn-upload'\)\.addEventListener\('click', openImageModal\)/);
});

test('flyer public rendering uses an isolated poster-first template without replacing the existing event flow', () => {
  const route = read('src/routes/public.js');
  const standardTemplate = read('src/views/event-public.html');
  const flyerTemplate = read('src/views/event-public-flyer.html');
  const flyerStyles = read('public/css/event-public-flyer.css');

  assert.match(route, /const flyerPublicTemplate = fs\.readFileSync/);
  assert.match(route, /const isFlyerPresentation = event\.presentation_mode === 'flyer' && Boolean\(event\.flyer_image_url\)/);
  assert.match(route, /const activePublicTemplate = isFlyerPresentation \? flyerPublicTemplate : publicTemplate/);
  assert.match(route, /class="hero flyer-hero"/);
  assert.match(route, /const primaryImageUrl = flyerImageUrl \|\| event\.cover_image_url/);
  assert.match(flyerStyles, /\.flyer-layout[\s\S]*width: min\(720px, calc\(100% - 32px\)\)/);
  assert.match(flyerStyles, /\.hero\.flyer-hero img[\s\S]*height: auto;[\s\S]*object-fit: contain/);
  assert.doesNotMatch(flyerStyles, /\.flyer-layout\s*\{[^}]*grid-template-columns/);
  assert.match(standardTemplate, /grid-template-columns: minmax\(0, 5fr\) minmax\(0, 6fr\)/);

  const markers = [
    '{{HERO}}',
    '{{TITLE}}',
    '{{HOST_IDENTITY_HTML}}',
    '{{DATE_STR}}',
    '{{VENUE_SUMMARY_HTML}}',
    '<div class="rsvp-zone">',
    '{{PRIMARY_ACTION_HTML}}',
    '{{ADDITIONAL_DETAILS_HTML}}',
    '{{GUEST_LIST_HTML}}',
    '{{COMMENTS_HTML}}',
    'id="share-btn"',
    '{{PRESENTER_HTML}}',
    'Powered by <a href="/">Silver Glider</a>'
  ];
  const flyerLayout = flyerTemplate.slice(flyerTemplate.indexOf('<main class="flyer-layout">'));
  for (let index = 1; index < markers.length; index += 1) {
    assert.ok(
      flyerLayout.indexOf(markers[index - 1]) < flyerLayout.indexOf(markers[index]),
      `${markers[index - 1]} should precede ${markers[index]}`
    );
  }

  for (const existingPart of ['id="rsvp-form"', '{{GUEST_LIST_HTML}}', '{{COMMENTS_HTML}}', 'id="cal-btn"', '{{PRESENTER_HTML}}', 'Powered by']) {
    assert.match(flyerTemplate, new RegExp(existingPart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(flyerTemplate, /<p class="sg-label cat">/);
  assert.match(route, /flyerPrimaryAction\(event\)/);
  assert.match(route, /primaryActionType: flyerAction\.type/);
});

test('locked Secret Shows do not render or query flyer assets before unlock', () => {
  const route = read('src/routes/public.js');
  const accessQuery = route.slice(route.indexOf('async function loadEventAccessEnvelope'), route.indexOf('function secretShowLocked'));
  assert.doesNotMatch(accessQuery, /flyer_image_url/);
  const publicHandler = route.slice(route.indexOf("router.get('/e/:slug'"), route.indexOf('function render404'));
  assert.ok(publicHandler.indexOf('secretShowTemplate') < publicHandler.indexOf('loadEventBySlug(req.params.slug)'));
  assert.doesNotMatch(read('src/views/secret-show.html'), /flyer_image_url|flyer-hero/);
});

test('flyer RSVP confirmation is selected without changing Standard confirmation output', () => {
  const standardHtml = renderRsvpConfirmationEmail({
    event: { ...flyerEvent, presentation_mode: 'standard' },
    rsvp
  });
  assert.match(standardHtml, /You're on the list\./);
  assert.doesNotMatch(standardHtml, /Night Garden flyer/);

  const flyerHtml = renderRsvpConfirmationEmail({ event: flyerEvent, rsvp });
  assert.match(flyerHtml, /See you there\./);
  assert.match(flyerHtml, /Night Garden flyer/);
  assert.match(flyerHtml, /height:auto/);
  assert.match(flyerHtml, /Add to Calendar/);
  assert.match(flyerHtml, /View event &amp; comments/);
  assert.match(flyerHtml, /Heat Wave Booking/);
  assert.match(flyerHtml, /Powered by Silver Glider/);
});

test('existing reminder senders select the flyer-focused template and attendee calendar link', () => {
  const mailer = read('src/lib/mailer.js');
  const reminders = read('src/jobs/reminders.js');
  const html = renderFlyerReminderEmail({ event: flyerEvent, rsvp, kicker: 'Reminder', headline: 'Tomorrow.' });
  assert.match(html, /Night Garden flyer/);
  assert.match(html, /Tomorrow\./);
  assert.match(html, /\/r\/attendee-secret-token\/calendar\.ics/);
  assert.match(mailer, /isFlyerEvent\(event\) \? renderFlyerReminderEmail/);
  assert.match(reminders, /SELECT e\.\*, o\.org_name, o\.public_slug AS organizer_public_slug/);
  assert.equal((reminders.match(/cron\.schedule/g) || []).length, 1);
});

test('flyer events remain in the existing dashboard, event list, host page, and management screen', () => {
  assert.match(read('src/views/dashboard.html'), /ev\.presentation_mode === 'flyer'/);
  assert.match(read('src/views/events.html'), /ev\.presentation_mode === 'flyer'/);
  assert.match(read('public/js/manage.js'), /event\.presentation_mode === 'flyer'/);
  const publicRoute = read('src/routes/public.js');
  assert.match(publicRoute, /SELECT slug, title, cover_image_url, presentation_mode, flyer_image_url/);
  assert.match(publicRoute, /class="flyer-art"/);
});
