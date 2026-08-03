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
  const client = source('public/js/public-event.js');

  assert.equal((view.match(/id="share-btn"/g) || []).length, 1);
  assert.equal((view.match(/id="cal-btn"/g) || []).length, 1);
  assert.doesNotMatch(view, /success-share|success-cal/);
  assert.match(client, /\$\('cal-btn'\)\.href = icsUrl/);
  assert.match(client, /\$\('share-btn'\)\.addEventListener\('click', share\)/);
});

test('host and Silver Glider attribution center only on mobile', () => {
  const view = source('src/views/event-public.html');
  assert.match(view, /@media \(max-width: 879px\) \{\s*\.host-attribution \{ justify-content: center; \}\s*\.powered-by \{ text-align: center; \}/);
  assert.match(view, /@media \(min-width: 880px\)/);
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
    assert.doesNotMatch(form, /<details class="rsvp-options"\s+open/);
    assert.match(options, /Phone and host updates/);
    assert.match(options, /id="phone"/);
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
  assert.equal((standardView.match(/id="mobile-rsvp-cta"/g) || []).length, 1);
  assert.match(standardView, /aria-controls="rsvp-form-box"/);
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
});

test('public RSVP success state clearly confirms the RSVP without implying guest-list access', () => {
  for (const templatePath of ['src/views/event-public.html', 'src/views/event-public-flyer.html']) {
    const view = source(templatePath);
    assert.match(view, /Your RSVP is confirmed\./);
    assert.doesNotMatch(view, /You're on the list\./);
  }
});
