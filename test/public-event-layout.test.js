const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('public event sections follow the guest-first vertical hierarchy', () => {
  const view = source('src/views/event-public.html');
  const layout = view.slice(view.indexOf('<div class="layout">'));
  const markers = [
    '{{HERO}}',
    '{{CATEGORY}}',
    '{{TITLE}}',
    '{{DATE_STR}}',
    '{{VENUE_NAME}}',
    '{{TICKET_HTML}}',
    '{{DESCRIPTION_HTML}}',
    '{{VIBE_HTML}}',
    '<div class="rsvp-zone">',
    '{{RECAP_GALLERY_HTML}}',
    '{{GUEST_LIST_HTML}}',
    '{{COMMENTS_HTML}}',
    'id="share-btn"',
    '{{PRESENTER_HTML}}',
    'Powered by <a href="/">Silver Glider</a>'
  ];

  for (let index = 1; index < markers.length; index += 1) {
    assert.ok(layout.indexOf(markers[index - 1]) < layout.indexOf(markers[index]), `${markers[index - 1]} should precede ${markers[index]}`);
  }
  assert.match(view, /legal-footer\.js/);
});

test('guest-list attendance copy uses past tense after an event passes', () => {
  const route = source('src/routes/public.js');
  assert.match(route, /AS is_past/);
  assert.match(route, /event\.is_past[\s\S]*'person'[\s\S]*'people'[\s\S]*went/);
  assert.match(route, /'person is'[\s\S]*'people are'[\s\S]*going/);
});

test('guest list uses an inline mobile expansion and an accessible desktop modal', () => {
  const route = source('src/routes/public.js');
  const client = source('public/js/public-event.js');
  const standard = source('src/views/event-public.html');
  const flyer = source('public/css/event-public-flyer.css');

  assert.match(route, /class="guest-avatar-stack"/);
  assert.match(route, /names\.length > 0 && names\.length <= 5/);
  assert.match(route, /data-preview-style="\$\{showPreviewNames \? 'named' : 'compact'\}"/);
  assert.match(route, /class="guest-avatar-label"/);
  assert.match(route, /class="guest-avatar-more"/);
  assert.match(route, /aria-controls="guest-list-inline guest-list-modal"/);
  assert.match(route, /class="guest-list-inline" id="guest-list-inline" hidden/);
  assert.match(route, /class="guest-list-modal-card" role="dialog" aria-modal="true"/);
  assert.match(route, /<ul class="guest-name-list">\$\{modalItems\}<\/ul>/);
  assert.match(route, /\$\{avatar\(entry\)\}<span>\$\{esc\(entry\.firstName\)\}<\/span>/);

  assert.match(client, /function openGuestList\(\)/);
  assert.match(client, /function closeGuestList\(\{ restoreFocus = true \} = \{\}\)/);
  assert.match(client, /function toggleInlineGuestList\(\)/);
  assert.match(client, /guestListMobileMedia\.matches/);
  assert.match(client, /event\.key === 'Escape'/);
  assert.match(client, /event\.key !== 'Tab'/);
  assert.match(client, /event\.target === guestListModal/);
  assert.match(client, /guest-list-modal-open/);

  for (const styles of [standard, flyer]) {
    assert.match(styles, /\.guest-avatar-stack li \+ li \{ margin-left: -12px; \}/);
    assert.match(styles, /\.guest-avatar-stack\[data-preview-style="named"\] \{[\s\S]*align-items: flex-start;[\s\S]*overflow: visible;/);
    assert.match(styles, /\.guest-avatar-stack\[data-preview-style="named"\] li \+ li \{ margin-left: 0; \}/);
    assert.match(styles, /\.guest-avatar-label \{[\s\S]*text-overflow: ellipsis;[\s\S]*white-space: nowrap;/);
    assert.match(styles, /\.guest-list-modal \{[\s\S]*position: fixed;[\s\S]*z-index: 100;/);
    assert.match(styles, /\.guest-list-modal \.guest-avatar \{[\s\S]*width: 80px;[\s\S]*height: 80px;/);
    assert.match(styles, /@media \(max-width: 599px\)[\s\S]*\.guest-list-modal \{ display: none !important; \}/);
    assert.match(styles, /\.guest-list-inline \.guest-avatar \{ width: 64px; height: 64px;/);
  }
});

test('QR stays available to hosts but is removed from the public event page', () => {
  const view = source('src/views/event-public.html');
  const client = source('public/js/public-event.js');
  const publicRoutes = source('src/routes/public.js');
  const manager = source('public/js/manage.js');

  assert.doesNotMatch(view, /qr-footer|qr-img|Scan to share/);
  assert.doesNotMatch(client, /qr-img|\/qr\.png/);
  assert.match(publicRoutes, /\/e\/:slug\/qr\.png/);
  assert.match(manager, /fetch\(`\/e\/\$\{eventData\.slug\}\/qr\.png`\)/);
});

test('share and calendar remain available after RSVP confirmation', () => {
  const view = source('src/views/event-public.html');
  const flyerView = source('src/views/event-public-flyer.html');
  const client = source('public/js/public-event.js');

  assert.equal((view.match(/id="share-btn"/g) || []).length, 1);
  assert.equal((view.match(/id="cal-btn"/g) || []).length, 1);
  assert.match(view, /id="share-btn" type="button"/);
  assert.match(flyerView, /id="share-btn" type="button"/);
  assert.doesNotMatch(view, /success-share|success-cal/);
  assert.match(client, /\$\('cal-btn'\)\.href = icsUrl/);
  assert.match(client, /shareBtn\.addEventListener\('click', share\)/);
});

test('desktop sharing copies the link and native mobile sharing cannot overlap calendar navigation', () => {
  const client = source('public/js/public-event.js');

  assert.match(client, /matchMedia\('\(pointer: coarse\)'\)/);
  assert.match(client, /nativeShareMedia\.matches[\s\S]*typeof navigator\.share === 'function'/);
  assert.match(client, /async function copyEventLink\(url\)/);
  assert.match(client, /navigator\.clipboard\?\.writeText/);
  assert.match(client, /document\.execCommand\('copy'\)/);
  assert.match(client, /let shareInFlight = false/);
  assert.match(client, /if \(shareInFlight\) return/);
  assert.match(client, /if \(error\?\.name === 'AbortError'\) return/);
  assert.match(client, /calendarBtn\.addEventListener\('click', event => \{[\s\S]*if \(shareInFlight\) event\.preventDefault\(\)/);
  assert.doesNotMatch(client, /if \(navigator\.share\) \{/);
});

test('host and Silver Glider attribution center only on mobile', () => {
  const view = source('src/views/event-public.html');
  assert.match(view, /@media \(max-width: 879px\) \{\s*\.host-attribution \{ justify-content: center; \}\s*\.powered-by \{ text-align: center; \}/);
  assert.match(view, /@media \(min-width: 880px\)/);
});

test('Standard mobile artwork preserves portrait covers while desktop and Flyer rendering stay unchanged', () => {
  const view = source('src/views/event-public.html');
  const flyerView = source('src/views/event-public-flyer.html');
  const client = source('public/js/public-event.js');
  const route = source('src/routes/public.js');

  assert.match(route, /coverFitMode = \['contain', 'cover'\]\.includes\(event\.cover_fit_mode\)/);
  assert.match(route, /standard-hero cover-fit-\$\{coverFitMode\}/);
  assert.match(view, /@media \(max-width: 879px\)[\s\S]*cover-fit-auto:not\(\.cover-fit-resolved-cover\)[\s\S]*object-fit: contain/);
  assert.match(view, /cover-fit-contain\.cover-image-portrait[\s\S]*aspect-ratio: 4 \/ 5/);
  assert.match(view, /@media \(min-width: 880px\)[\s\S]*\.hero \{[\s\S]*aspect-ratio: 4 \/ 5/);
  assert.match(client, /function applyStandardMobileCoverFit\(\)/);
  assert.match(client, /const isPortrait = img\.naturalHeight > img\.naturalWidth/);
  assert.match(client, /hero\.style\.setProperty\('--hero-bg-a'/);
  assert.doesNotMatch(flyerView, /cover-fit-contain|cover-fit-auto|standard-hero/);
});

test('legal footer mounts inside both isolated public event presentations', () => {
  const client = source('public/js/legal-footer.js');
  assert.match(client, /document\.querySelector\('\.col-details \.wrap'\) \|\| document\.querySelector\('\.flyer-details'\)/);
});

test('RSVP keeps essential identity fields visible and progressively discloses only optional controls', () => {
  for (const templatePath of ['src/views/event-public.html', 'src/views/event-public-flyer.html']) {
    const view = source(templatePath);
    const form = view.slice(view.indexOf('<form id="rsvp-form">'), view.indexOf('</form>'));
    const options = form.slice(form.indexOf('<details class="rsvp-options">'), form.indexOf('</details>'));

    assert.ok(form.indexOf('id="full_name"') < form.indexOf('id="email"'));
    assert.ok(form.indexOf('id="email"') < form.indexOf('<details class="rsvp-options">'));
    assert.ok(form.indexOf('id="wants_reminders"') < form.indexOf('<details class="rsvp-options">'));
    assert.ok(form.indexOf('{{SMS_REMINDER_OPTIN_HTML}}') < form.indexOf('<details class="rsvp-options">'));
    assert.doesNotMatch(form, /<details class="rsvp-options"\s+open/);
    assert.match(options, /Host updates/);
    assert.doesNotMatch(options, /id="phone"|id="sms_optin"/);
    assert.match(options, /id="organizer_optin"/);
    assert.doesNotMatch(options, /id="full_name"|id="email"|id="wants_reminders"/);
  }
});

test('expanded RSVP forms can be collapsed without resetting the shared form', () => {
  const client = source('public/js/public-event.js');
  for (const templatePath of ['src/views/event-public.html', 'src/views/event-public-flyer.html']) {
    const view = source(templatePath);
    assert.match(view, /id="rsvp-close"/);
    assert.match(view, /aria-label="Close RSVP form"/);
  }
  assert.match(client, /function closeRsvpForm\(\)/);
  assert.match(client, /show\('cta-state'\)/);
  assert.match(client, /\$\('rsvp-close'\)\.addEventListener\('click', closeRsvpForm\)/);
  assert.match(client, /setAttribute\('aria-expanded', 'false'\)/);
  assert.doesNotMatch(client, /closeRsvpForm[\s\S]{0,300}reset\(\)/);
});

test('mobile primary-action dock reuses the active Flyer action and avoids the footer', () => {
  const client = source('public/js/public-event.js');
  const route = source('src/routes/public.js');
  const flyerStyles = source('public/css/event-public-flyer.css');

  const standardView = source('src/views/event-public.html');
  const flyerView = source('src/views/event-public-flyer.html');
  assert.equal((standardView.match(/id="mobile-rsvp-dock"/g) || []).length, 1);
  assert.match(standardView, /{{STANDARD_MOBILE_ACTION_HTML}}/);
  assert.equal((flyerView.match(/id="mobile-rsvp-dock"/g) || []).length, 1);
  assert.match(flyerView, /{{MOBILE_PRIMARY_ACTION_HTML}}/);
  assert.match(route, /id="mobile-rsvp-cta" href=/);
  assert.match(route, /id="mobile-rsvp-cta" data-open-rsvp/);

  assert.match(client, /matchMedia\('\(max-width: 767px\)'\)/);
  assert.match(client, /document\.querySelector\('\[data-primary-action\]'\)/);
  assert.match(client, /inlineCtaRect\.bottom > 0 && inlineCtaRect\.top < window\.innerHeight/);
  assert.match(client, /&& !inlineCtaIsVisible/);
  assert.match(client, /&& !footerIsNear/);
  assert.match(client, /activeRsvpState === 'cta-state'/);
  assert.match(client, /openRsvpForm\(\{ scrollToForm: trigger === mobileRsvpCta, trigger \}\)/);
  assert.doesNotMatch(client, /cloneNode|rsvp\/sticky/);
  assert.match(flyerStyles, /body\.flyer-public-page,[\s\S]*padding-bottom: calc\(78px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(flyerStyles, /\.mobile-rsvp-dock \{[\s\S]*background: rgba\(8,8,8,\.97\);[\s\S]*backdrop-filter: none;[\s\S]*contain: paint/);
  assert.match(flyerStyles, /\.vibe-embed \{ touch-action: pan-y; \}/);
  assert.match(flyerStyles, /\.flyer-public-page > \.event-bg,[\s\S]*\.flyer-public-page > \.fx-veil[\s\S]*height: 100lvh;[\s\S]*contain: paint/);
  assert.match(flyerStyles, /\.public-guest-list,[\s\S]*\.event-wall \{[\s\S]*backdrop-filter: none;/);
});

test('past events replace RSVP with photos when available and reject new submissions', () => {
  const route = source('src/routes/public.js');
  const standardView = source('src/views/event-public.html');
  const client = source('public/js/public-event.js');

  assert.match(route, /const recapHref = featuredPhotos\.length \? '#event-recap' : ''/);
  assert.match(route, /class="event-recap" id="event-recap"/);
  assert.match(route, /event\.is_past[\s\S]*View event photos/);
  assert.match(route, /event\.is_past[\s\S]*This event has ended\./);
  assert.match(route, /event\.is_past[\s\S]*status\(409\)\.json\(\{ error: 'event_ended'/);
  assert.match(standardView, /{{STANDARD_PRIMARY_ACTION_HTML}}/);
  assert.match(client, /!EVENT\.isPast && EVENT\.isFull/);
});

test('secondary text and form focus use readable shared contrast tokens', () => {
  const brand = source('public/css/brand.css');
  assert.match(brand, /--sg-text-faint: #787878/);
  assert.match(brand, /\.sg-input:focus[\s\S]*outline: 2px solid rgba\(28, 197, 190, 0\.32\)/);
});

test('public descriptions and essential RSVP surfaces stay readable over artwork', () => {
  for (const templatePath of ['src/views/event-public.html', 'public/css/event-public-flyer.css']) {
    const styles = source(templatePath);
    assert.match(styles, /\.desc \{[\s\S]*color: rgba\(255,255,255,\.8\);[\s\S]*font-weight: 500;[\s\S]*white-space: pre-line;/);
    assert.match(styles, /\.when \{[\s\S]*background: rgba\(255,255,255,\.065\);[\s\S]*backdrop-filter: blur\(10px\);/);
    assert.match(styles, /#rsvp-form-box \.sg-input \{[\s\S]*background-color: rgba\(255,255,255,\.07\);[\s\S]*border-color: rgba\(255,255,255,\.16\);/);
  }
});

test('public RSVP success state clearly confirms the RSVP without implying guest-list access', () => {
  for (const templatePath of ['src/views/event-public.html', 'src/views/event-public-flyer.html']) {
    const view = source(templatePath);
    assert.match(view, /Your RSVP is confirmed\./);
    assert.doesNotMatch(view, /You're on the list\./);
  }
});
