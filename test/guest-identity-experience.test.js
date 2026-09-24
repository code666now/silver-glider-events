const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('large guest photos are resized without stretching before the bounded avatar upload', () => {
  const optimizer = read('public/js/image-optimizer.js');
  const addPhoto = read('public/js/add-photo.js');
  const settings = read('public/js/settings.js');
  const uploads = read('src/routes/uploads.js');

  assert.match(optimizer, /MAX_SOURCE_BYTES = 20 \* 1024 \* 1024/);
  assert.match(optimizer, /Math\.min\(1, MAX_AVATAR_DIMENSION \/ Math\.max\(loaded\.width, loaded\.height\)\)/);
  assert.match(optimizer, /imageSmoothingQuality = 'high'/);
  assert.match(optimizer, /canvasBlob\(canvas, 'image\/webp', 0\.88\)/);
  assert.match(addPhoto, /SGImageOptimizer\.optimizeAvatar\(file\)/);
  assert.match(settings, /SGImageOptimizer\.optimizeAvatar\(file\)/);
  assert.match(uploads, /handleAvatarUpload/);
  assert.match(uploads, /max 20 MB/);
});

test('photo return context is derived from an RSVP-owned identity, not an arbitrary URL', () => {
  const index = read('src/index.js');
  const page = read('src/views/add-photo.html');

  assert.match(index, /JOIN rsvps r ON r\.event_id=e\.id/);
  assert.match(index, /e\.slug=\$1[\s\S]*r\.user_id=\$3 OR \(r\.user_id IS NULL AND r\.account_id=\$2\)/);
  assert.match(index, /\[requestedSlug, req\.organizer\.id, req\.organizer\.user_id\]/);
  assert.match(index, /event \? `\/e\/\$\{encodeURIComponent\(event\.slug\)\}`/);
  assert.match(page, /id="add-photo-back" href="\{\{RETURN_URL\}\}"/);
  assert.match(page, /id="add-photo-success" hidden/);
  assert.match(page, /Returning you automatically/);
});

test('My Events opens on Going unless a host has nothing upcoming there, and preserves the Hosting workspace', () => {
  const routes = read('src/routes/events.js');
  const page = read('src/views/events.html');

  assert.match(routes, /router\.get\('\/api\/events\/going'/);
  assert.match(routes, /r\.user_id=\$2 OR \(r\.user_id IS NULL AND r\.account_id=\$1\)[\s\S]*r\.status='confirmed'/);
  assert.match(routes, /e\.status IN \('published','cancelled'\)/);
  assert.doesNotMatch(routes, /LOWER\(r\.email\).*api\/events\/going/s);
  assert.match(page, /data-view="going">Going</);
  assert.match(page, /data-view="hosting">Hosting</);
  assert.match(page, /const validRequestedView = normalizeView\(requestedView\)/);
  assert.match(page, /let activeView = resolveInitialView\(requestedView, rememberedView\)/);
  assert.match(page, /const chooseInitialView = validRequestedView \|\| validRememberedView \? Promise\.resolve\(\)/);
  assert.match(page, /const hasUpcoming = list => \(list \|\| \[\]\)\.some\(e => isUpcomingEventDate\(e\.event_date\)\)/);
  assert.match(page, /const upcoming = events\.filter\(e => isUpcomingEventDate\(e\.event_date\)\)\.reverse\(\)/);
  assert.match(page, /const past = events\.filter\(e => !isUpcomingEventDate\(e\.event_date\)\)/);
  assert.match(page, /const requestedLoadView = activeView/);
  assert.match(page, /const requestId = \+\+loadRequestId/);
  assert.match(page, /if \(requestId !== loadRequestId \|\| requestedLoadView !== activeView\) return/);
  assert.match(page, /if \(!userSelectedView\) load\(\)/);
  assert.ok(page.indexOf('userSelectedView = true;') < page.indexOf("if (tab.dataset.view === activeView) return;"));
  assert.ok(page.indexOf('localStorage.setItem(VIEW_KEY, tab.dataset.view)') < page.indexOf("if (tab.dataset.view === activeView) return;"));
  assert.match(page, /if \(!hasUpcoming\(going\.events\) && \(hosting\.events \|\| \[\]\)\.length\) activeView = 'hosting'/);
  assert.match(page, /localStorage\.setItem\(VIEW_KEY, tab\.dataset\.view\)/);
  assert.match(page, /api\('\/api\/events\/going'\)/);
  assert.match(page, /api\('\/api\/events\?archived=1'\)/);
  assert.match(page, /Events you RSVP to will appear here/);
});

test('phone feedback returns focus to the menu while desktop feedback returns to its visible launcher', () => {
  const api = read('public/js/api.js');
  const footer = read('public/js/legal-footer.js');
  const styles = read('public/css/main.css');
  const manage = read('public/js/manage.js');

  assert.match(api, /\[bubble, document\.querySelector\('\.sg-legal-feedback'\), document\.querySelector\('\.sg-nav-toggle'\), document\.querySelector\('\.sg-account-trigger'\)\]/);
  assert.match(api, /document\.querySelector\('\.sg-legal-feedback'\)/);
  assert.match(api, /candidate\.getClientRects\(\)\.length/);
  assert.match(api, /style\.display !== 'none' && style\.visibility !== 'hidden'/);
  assert.doesNotMatch(api, /bubble\.offsetParent/);
  assert.match(footer, /class="sg-legal-feedback" type="button">Send feedback/);
  assert.match(footer, /document\.getElementById\('feedback-bubble'\)\?\.click\(\)/);
  assert.match(styles, /body\.sg-app-page:not\(\.quick-create-mobile-flow\):not\(\.event-mobile-flow-enabled\):not\(\.manage-mobile-custom-nav\) \.sg-global-footer \{ display: none; \}/);
  assert.match(styles, /body\.sg-app-page\.manage-mobile-custom-nav \.sg-legal-feedback/);
  assert.match(manage, /document\.body\.classList\.toggle\('manage-mobile-custom-nav', mobileManageLayout\.matches\)/);
});

test('phone tab bar is limited to top-level destinations and preserves focused task docks', () => {
  const api = read('public/js/api.js');
  const styles = read('public/css/main.css');
  const settings = read('src/views/settings-v2.html');

  assert.match(api, /function topLevelTabForPath\(pathname\)/);
  assert.match(api, /topLevelTabForPath\(window\.location\.pathname\) === active/);
  assert.match(api, /TAB_BAR_TABS\.find\(\(\[, href\]\) => href === normalized\)/);
  assert.match(api, /if \(normalized === '\/settings'\) return 'settings';/);
  assert.match(api, /return TAB_BAR_KEYS\.includes\(tab\) \? tab : null;/);
  assert.match(api, /className = 'sg-tab-bar'/);
  assert.match(api, /setAttribute\('aria-label', 'Main'\)/);
  assert.match(styles, /@media \(max-width: 879px\)[\s\S]*body\.has-tab-bar \{ --sg-tab-bar-height: 62px; \}/);
  assert.match(styles, /padding:[^;]*env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(settings, /settings-feedback/, 'Feedback lives in the ☰ panel');
});

test('only a signed-in matching identity receives the public avatar edit affordance', () => {
  const routes = read('src/routes/public.js');
  const identities = read('src/lib/private-events.js');

  assert.match(routes, /SELECT r\.id, r\.account_id, r\.first_name/);
  assert.match(identities, /identityId: row\.account_id \|\| null/);
  assert.match(routes, /Number\(entry\.identityId\) === Number\(viewerIdentityId\) && viewerIdentityId/);
  assert.match(routes, /class="guest-avatar guest-avatar-edit" href="\/add-photo\?event=/);
  assert.match(routes, /viewerIdentityId: req\.sessionAccount\?\.id/);
});

test('phone tab bar puts Create and your avatar in the bar and the ☰ opens a full-screen menu', () => {
  const api = read('public/js/api.js');
  const styles = read('public/css/main.css');
  const profile = read('src/views/profile.html');
  const index = read('src/index.js');
  const auth = read('src/routes/auth.js');

  assert.match(api, /\['create', '\/events\/new', 'Create'/);
  assert.match(api, /\['following', '\/following', 'Hosts'/);
  assert.match(api, /\['profile', '\/profile', 'You', null\]/);
  assert.match(api, /if \(usesMenuSheet\(\)\) \{\s*openMenuSheet\(toggle\);/);
  assert.match(api, /setAttribute\('aria-modal', 'true'\)/);
  assert.match(api, /data-menu-feedback/);
  assert.match(api, /data-menu-signout/);
  assert.match(styles, /body\.has-tab-bar \.sg-mobile-sticky-action \{ display: none !important; \}/);
  assert.match(styles, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 879px\) \{[\s\S]*?\.sg-account-menu \{ display: none; \}/);
  const tabletNavigation = styles.match(/@media \(max-width: 1023px\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.doesNotMatch(tabletNavigation, /\.sg-account-menu/, 'Profile remains reachable from the account menu above the phone breakpoint');
  assert.match(api, /if \(menuSheet\) fillMenuSheet\(menuSheet, sgCurrentAccount\)/);
  assert.match(api, /ev\.presentation_mode === 'flyer'[\s\S]*?ev\.flyer_image_url \|\| ev\.cover_image_url/);
  assert.match(api, /const tryArtwork = \(\) => \{/);
  assert.match(api, /image\.onload = \(\) => \{ art\.hidden = false; \}/);
  assert.match(api, /image\.onerror = \(\) => \{[\s\S]*?tryArtwork\(\)/);
  assert.match(api, /image\.onerror = \(\) => \{[\s\S]*?initials\.hidden = false/);
  assert.match(index, /app\.get\('\/profile', requireOrganizer, view\('profile\.html'\)\)/);
  assert.match(auth, /router\.get\('\/api\/me\/stats', requireOrganizer/);
  assert.match(profile, /renderNav\('profile'\)/);
  assert.match(profile, /data-sg-avatar aria-hidden="true"/);
  assert.match(profile, /profile-stats-status/);
  assert.match(profile, /profile'\)\.setAttribute\('aria-busy', 'false'\)/);
  assert.match(profile, /fetch\('\/api\/uploads\/avatar'/);
});
