const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('homepage gives returning users a real account entry without changing the create CTA', () => {
  const home = read('src/views/index.html');
  const client = read('public/js/home-account-nav.js');

  assert.match(home, /class="sg-home-page"/);
  assert.match(home, /\.sg-home-header \{[\s\S]*?width: 100%;[\s\S]*?padding: 14px clamp\(24px, 3vw, 64px\)/);
  assert.match(home, /data-home-account-shell data-loading="true"/);
  assert.match(home, /\.sg-home-account-shell \[hidden\] \{ display: none !important; \}/);
  assert.match(home, /data-home-signin href="\/login\?next=%2Fdashboard" hidden>Sign in/);
  assert.match(home, /href="\/login\?next=%2Fevents%2Fnew"[^>]*>Create your event/);
  assert.match(home, /class="sg-btn sg-btn-primary home-primary-cta"/);
  assert.match(home, /\.home-primary-cta \{[\s\S]*?border-radius: 12px;/);
  assert.match(home, /src="\/js\/api\.js" defer/);
  assert.match(home, /src="\/js\/home-account-nav\.js" defer/);

  assert.match(client, /fetch\('\/api\/auth\/me'/);
  assert.match(client, /credentials: 'same-origin'/);
  assert.match(client, /cache: 'no-store'/);
  assert.match(client, /if \(!response\.ok\) return null/);
  assert.doesNotMatch(client, /api\('\/api\/auth\/me'/, 'optional homepage auth must not redirect signed-out visitors');
  assert.match(client, /sgAccountMenuMarkup\('sg-home-account',\s*\{\s*includePrimaryLinks:\s*true\s*\}\)/);
  assert.match(client, /class="sg-home-mobile-profile" href="\/profile"/);
  assert.match(client, /openMenuSheet\(menuToggle\)/);
  assert.match(client, /signOutDestination: '\/'/);
});

test('homepage presents its value as a numbered editorial list', () => {
  const home = read('src/views/index.html');

  assert.match(home, /<section class="feature-list" aria-labelledby="feature-list-title">/);
  assert.match(home, /id="feature-list-title">The good stuff<\/h2>/);
  assert.match(home, /<span class="feature-list-range" aria-hidden="true">01 — 04<\/span>/);
  assert.match(home, /<ol class="features">/);
  for (const number of ['01', '02', '03', '04']) {
    assert.match(home, new RegExp(`<span class="feature-number" aria-hidden="true">${number}<\\/span>`));
  }
  assert.match(home, /<strong>Your own follow page\.<\/strong> Fans follow you and hear about the next show by email or text\./);
  // Familiar Faces has its own spotlight after the list, before the recs signup.
  const regulars = home.indexOf('<section class="home-regulars"');
  assert.ok(regulars > home.indexOf('<section class="feature-list"') && regulars < home.indexOf('data-sg-email-signup'));
  assert.match(home, /<h2 id="home-regulars-title">Familiar Faces, remembered\.<\/h2>/);
  assert.match(home, /See who keeps coming back\. Invite them again in a tap\./);
  assert.equal((home.match(/class="home-face"/g) || []).length, 5);
  assert.doesNotMatch(home, /class="tick"/);
  assert.doesNotMatch(home, /\.features\s*\{[^}]*backdrop-filter/);
});

test('homepage hero shows a real event page on a phone, after the copy and before The good stuff', () => {
  const home = read('src/views/index.html');
  const hero = home.indexOf('<div class="home-hero">');
  const phone = home.indexOf('<figure class="home-hero-phone">');
  assert.ok(hero > 0 && phone > home.indexOf('home-primary-cta'));
  assert.ok(home.indexOf('<section class="feature-list"') > phone);
  assert.match(home, /src="\/img\/home\/event-phone-party\.jpg" width="390" height="844" alt="A Silver Glider event page on a phone/);
  assert.ok(fs.existsSync(path.join(root, 'public/img/home/event-phone-party.jpg')));
  assert.match(home, /@media \(min-width: 960px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\) 300px/);
});

test('homepage phone turns toward the pointer, floats on touch screens, and respects reduced motion', () => {
  const home = read('src/views/index.html');
  const tilt = read('public/js/home-hero-tilt.js');
  assert.match(home, /src="\/js\/home-hero-tilt\.js" defer/);
  assert.match(home, /rotateX\(var\(--rx\)\) rotateY\(var\(--ry\)\) rotate\(var\(--lean\)\)/);
  assert.match(home, /@media \(hover: none\)[\s\S]*home-phone-float/);
  assert.match(home, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.home-hero-phone \{ animation: none; \}/);
  assert.match(tilt, /const MAX_TILT = 8;/);
  assert.match(tilt, /prefers-reduced-motion: reduce/);
  assert.match(tilt, /\(hover: hover\) and \(pointer: fine\)/);
  assert.match(tilt, /event\.pointerType !== 'mouse'/);
  assert.match(tilt, /requestAnimationFrame/);
  // Hidden delight: one click spins it to show the logo on the back.
  assert.match(home, /class="home-phone-back" aria-hidden="true"><img src="\/logo\.png" alt="" draggable="false">/);
  assert.match(home, /touch-action: manipulation/);
  assert.match(tilt, /setTimeout\(settle, SPIN_MS \+ SPIN_GRACE_MS\)/);
  assert.match(tilt, /list\.addListener\(onChange\)/);
  assert.match(home, /rotate\(var\(--lean\)\) rotateY\(var\(--spin\)\)/);
  assert.match(home, /\.home-phone-back \{[\s\S]*backface-visibility: hidden/);
  assert.match(tilt, /if \(spinning \|\| reducedMotion\.matches\) return;/);
  assert.match(tilt, /setProperty\('--spin', '360deg'\)/);
});

test('homepage connects the weekly recs signup to the marketing service above the footer', () => {
  const home = read('src/views/index.html');
  const client = read('public/js/home-email-signup.js');
  const styles = read('public/css/home-email-signup.css');
  const signupIndex = home.indexOf('data-sg-email-signup');
  const footerIndex = home.indexOf('<footer class="sg-social-footer"');

  assert.ok(signupIndex > home.indexOf('<section class="feature-list"'));
  assert.ok(footerIndex > signupIndex);
  assert.match(home, /data-endpoint="https:\/\/line\.silvergliderevents\.com\/api\/email\/subscribe"/);
  assert.match(home, /<h2 id="sg-recs-title">Going out instead\?<\/h2>/);
  assert.match(home, /aria-labelledby="sg-recs-title"/);
  assert.match(home, /class="sg-label sg-display sg-recs-kicker"/);
  assert.match(home, /name="email"[\s\S]*type="email"[\s\S]*maxlength="254"[\s\S]*required/);
  assert.match(home, /type="radio" name="audience" value="sf" required[\s\S]*type="radio" name="audience" value="la"/);
  assert.doesNotMatch(home, /<select name="audience"/);
  assert.match(home, /data-sg-button-label>Count me in</);
  assert.doesNotMatch(home, /&#8599;/);
  assert.match(home, /name="website" type="text" tabindex="-1" autocomplete="off"/);
  assert.match(home, /Confirm by email\. Unsubscribe anytime\./);
  assert.match(home, /data-sg-status role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(home, /href="\/css\/home-email-signup\.css"/);
  assert.match(home, /src="\/js\/home-email-signup\.js" defer/);

  assert.match(client, /method: 'POST'/);
  assert.match(client, /mode: 'cors'/);
  assert.match(client, /credentials: 'omit'/);
  assert.match(client, /consent: true/);
  assert.match(client, /website: String\(fields\.get\('website'\)/);
  assert.match(client, /new AbortController\(\)/);
  assert.match(client, /controller\.abort\(\), 12000/);
  assert.match(client, /response\.status === 429/);
  assert.match(client, /form\.reset\(\)/);
  assert.match(client, /root\.dataset\.state = 'done'/);

  // Same column, colour and shape as the rest of the homepage.
  assert.doesNotMatch(styles, /720px|translateX|#59d5d1/i);
  assert.match(styles, /background: var\(--sg-accent\)/);
  assert.match(styles, /font: 700 16px var\(--sg-font-body\)/);
  assert.match(styles, /border-radius: 12px/);
});

test('homepage desktop menu retains primary links while shared account actions match the phone menu', () => {
  const shell = read('public/js/api.js');
  const styles = read('public/css/main.css');
  const accountMenu = shell.slice(shell.indexOf('function sgAccountMenuMarkup'), shell.indexOf('function bindAccountMenu'));
  const menuSheet = shell.slice(shell.indexOf('function buildMenuSheet'), shell.indexOf('function fillMenuSheet'));

  for (const destination of ['/events/new', '/settings/messaging', '/profile', '/settings', '/privacy', '/terms']) {
    assert.match(accountMenu, new RegExp(`href="${destination.replaceAll('/', '\\/')}"`));
    assert.match(menuSheet, new RegExp(`href="${destination.replaceAll('/', '\\/')}"`));
  }
  for (const destination of ['/dashboard', '/events', '/following']) {
    assert.match(accountMenu, new RegExp(`includePrimaryLinks[\\s\\S]*href="${destination.replaceAll('/', '\\/')}"`));
  }
  assert.match(accountMenu, /includePrimaryLinks\s*=\s*false/);
  assert.match(menuSheet, /document\.body\.classList\.contains\('sg-home-page'\)/);
  assert.match(menuSheet, /homePrimaryLinks/);
  assert.match(shell, /account\.public_slug/);
  assert.match(accountMenu, /data-sg-account-host-label>My public page/);
  assert.match(accountMenu, /data-sg-account-host-value>Set up/);
  assert.match(shell, /sgPaintAvatar\(el, sgCurrentAccount\)/);
  assert.match(shell, /fetch\('\/api\/admin\/auth\/me'/);
  assert.match(styles, /\.sg-account-trigger-name/);
  assert.match(styles, /\.sg-account-popover \{[\s\S]*?width: min\(/);
  assert.match(styles, /max-height: calc\(100dvh - \d+px\)[\s\S]*overflow-y: auto/);
  assert.match(styles, /\.sg-account-popover a,\s*\.sg-account-popover button \{[\s\S]*min-height: 44px/);
  assert.match(shell, /menuSheetMedia\.addEventListener\('change', event => \{[\s\S]*mobileTrigger/);
  assert.match(shell, /visibleReturnFocus \|\| visibleDesktopTrigger/);
  assert.match(shell, /document\.body\.classList\.contains\('sg-home-page'\) \? '\/' : '\/login'/);
});
