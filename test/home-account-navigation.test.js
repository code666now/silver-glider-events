const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderHomeOrbit } = require('../src/lib/home-orbit-html');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('homepage gives returning users an account entry and keeps both real auth routes available without scripts', () => {
  const home = read('src/views/index.html');
  const styles = read('public/css/home-orbit.css');
  const client = read('public/js/home-account-nav.js');

  assert.match(home, /class="sg-home-page"/);
  assert.match(home, /href="\/css\/home-orbit\.css"/);
  assert.match(home, /data-home-account-shell data-loading="true"/);
  assert.match(styles, /\.sg-home-account-shell \[hidden\] \{ display: none !important; \}/);
  assert.doesNotMatch(styles, /data-loading="true"[^}]*visibility: hidden/);
  assert.match(home, /data-home-signin href="\/login\?next=%2Fdashboard">Sign in/);
  assert.match(renderHomeOrbit(home, []), /class="sg-btn sg-btn-primary home-orbit-cta" href="\/login\?next=%2Fevents%2Fnew">Create your event<\/a>/);
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

test('How it works is a standalone public page with the original features, plane and Familiar Faces', () => {
  const home = read('src/views/index.html');
  const how = read('src/views/how-it-works.html');
  assert.match(read('src/index.js'), /app\.get\('\/how-it-works', view\('how-it-works\.html'\)\)/);
  assert.match(home, /href="\/how-it-works">How it works<\/a>/);
  assert.doesNotMatch(home + how, /<dialog|home-how-dialog/);
  assert.match(how, /class="home-how-back" href="\/"/);
  assert.match(how, /<img src="\/logo\.png"[^>]*alt="">\s*<h1>How it works<\/h1>/);
  assert.match(how, /data-home-motion-controls hidden[\s\S]*type="checkbox" data-home-orbit-motion[\s\S]*Animate homepage photos/);
  assert.match(how, /<section class="feature-list" aria-labelledby="feature-list-title">/);
  assert.match(how, /id="feature-list-title">The good stuff<\/h2>/);
  assert.match(how, /<span class="feature-list-range" aria-hidden="true">01 — 04<\/span>/);
  assert.match(how, /<ol class="features" role="list">/);
  for (const number of ['01', '02', '03', '04']) {
    assert.ok(how.includes('<span class="feature-number" aria-hidden="true">' + number + '</span>'));
  }
  assert.match(how, /<strong>Your own follow page\.<\/strong> Fans follow you and hear about the next show by email or text\./);
  assert.ok(how.indexOf('<section class="home-regulars"') > how.indexOf('<section class="feature-list"'));
  assert.match(how, /<h2 id="home-regulars-title">Familiar Faces, remembered\.<\/h2>/);
  assert.match(how, /See who keeps coming back\. Invite them again in a tap\./);
  assert.equal([...how.matchAll(/<span class="home-face-avatar">([A-Z])<\/span>/g)].map(match => match[1]).join(''), 'GLIDE');
  assert.match(how, /href="\/login\?next=%2Fevents%2Fnew">Create your event<\/a>/);
});

test('homepage keeps the orbit composition without shipping prototype controls or embedded media', () => {
  const home = read('src/views/index.html');
  const styles = read('public/css/home-orbit.css');
  const hero = home.indexOf('class="home-orbit-hero"');
  const photos = home.indexOf('<!-- HOME_ORBIT_PHOTOS -->');
  assert.ok(hero > 0 && photos > hero && photos < home.indexOf('</main>'));
  assert.match(home, /<h1 id="home-orbit-title">You have a&nbsp;personality\.<br><span>Your events should&nbsp;too\.<\/span><\/h1>/);
  assert.equal((renderHomeOrbit(home, []).split('</main>')[0].match(/href="\/login\?next=%2Fevents%2Fnew"/g) || []).length, 1);
  assert.match(home, /aria-label="Event photos"><!-- HOME_ORBIT_PHOTOS -->/);
  assert.match(home, /<summary>Photo credits<\/summary>[\s\S]*<!-- HOME_ORBIT_CREDITS -->/);
  assert.doesNotMatch(home, /data-home-orbit-pause|data-home-orbit-motion|home-orbit-footer-tools/);
  assert.match(home, /src="\/js\/home-orbit\.js" defer/);
  assert.doesNotMatch(home, /<style>|<script>|style=|onerror=|data:image|type="file"|Concept ·|Try your own photos|home-hero-tilt|home-glide/i);
  assert.match(styles, /@media \(hover: hover\) and \(pointer: fine\) \{\s*\.is-orbit-enhanced \.home-orbit-photo:not\(:disabled\) \{ cursor: url\("\/img\/home\/orbit-cursor\.png"\) 29 6, pointer/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(styles, /data:image/);
  for (const href of ['/recs', '/privacy', '/terms', '/accessibility']) {
    assert.ok(home.includes('href="' + href + '"'));
  }
});

test('the homepage uses the shared logo, typography and pills with teal pointer, keyboard and press feedback', () => {
  const home = read('src/views/index.html');
  const styles = read('public/css/home-orbit.css');
  assert.match(home, /<img class="home-orbit-hero-plane" src="\/logo\.png" width="54" height="54" alt="">\s*<h1/);
  assert.doesNotMatch(home, /home-orbit-hero-label|San Francisco \/ Los Angeles|↗/);
  assert.match(home, /<span class="home-orbit-weekly">Get weekly picks<\/span>/);
  assert.match(home, /class="sg-btn sg-btn-ghost sg-home-signin"/);
  assert.match(home, /class="sg-btn sg-btn-primary home-orbit-cta"/);
  assert.match(styles, /\.sg-home-page \{[^}]*font-family: var\(--sg-font-body\)/);
  assert.match(styles, /\.home-orbit-hero h1 \{[^}]*font: 750 [^;]*var\(--sg-font-display\);\s*letter-spacing: -\.068em/);
  assert.match(styles, /\.home-orbit-cta \{[^}]*background: #f2f2ef/);
  assert.match(styles, /\.home-orbit-cta:active \{ background: var\(--sg-accent\); transition: none;/);
  assert.match(styles, /\.home-orbit-cta:focus-visible \{ background: var\(--sg-accent\)/);
  assert.match(styles, /@media \(hover: hover\) \{[^\n]*\n[^\n]*\n\s*\.home-orbit-cta:hover \{ background: var\(--sg-accent\)/);
});

test('the web app shares the local Arial stack, including the theme swatches', () => {
  const brand = read('public/css/brand.css');
  assert.match(brand, /--sg-font-body: Arial, Helvetica, sans-serif;/);
  assert.match(brand, /--sg-font-display: var\(--sg-font-body\);/);
  assert.match(brand, /\.sg-swatch-name \{[^}]*font-family: var\(--sg-font-body\);/);
  assert.doesNotMatch(brand, /Montserrat|Sulphur Point|fonts\.googleapis\.com/);
});

test('both public pages reuse the app gradient and legal-footer typography', () => {
  const sharedStyles = read('public/css/home-orbit.css');
  for (const page of ['index', 'how-it-works', 'login']) {
    const html = read(`src/views/${page}.html`);
    assert.match(html, /class="sg-aurora" aria-hidden="true"/);
    assert.match(html, /class="sg-aurora-veil" aria-hidden="true"/);
    if (page === 'login') continue; // Signed-in app shell mounts these same classes automatically.
    assert.match(html, /<nav class="sg-legal-links" aria-label="Legal links">/);
    for (const href of ['/privacy', '/terms', '/accessibility']) assert.ok(html.includes(`class="sg-legal-link" href="${href}"`));
  }
  assert.match(sharedStyles, /\.sg-home-page \.sg-aurora \{ animation: none;/);
  assert.doesNotMatch(sharedStyles, /\.home-orbit-legal/);
});

test('the weekly recs signup lives on /recs, and the homepage links to it quietly', () => {
  const homepage = read('src/views/index.html');
  const server = read('src/index.js');
  assert.match(server, /app\.get\('\/recs', view\('recs\.html'\)\)/);
  assert.match(homepage, /<a href="\/recs">Going out instead\?/);
  assert.doesNotMatch(homepage, /data-sg-email-signup|home-email-signup/);

  const home = read('src/views/recs.html');
  const client = read('public/js/home-email-signup.js');
  const styles = read('public/css/home-email-signup.css');
  const signupIndex = home.indexOf('data-sg-email-signup');
  const footerIndex = home.indexOf('<footer class="sg-social-footer"');

  assert.ok(signupIndex > 0 && footerIndex > signupIndex);
  assert.match(home, /data-endpoint="https:\/\/line\.silvergliderevents\.com\/api\/email\/subscribe"/);
  assert.match(home, /<h1 id="sg-recs-title">Going out instead\?<\/h1>/);
  assert.match(home, /aria-labelledby="sg-recs-title"/);
  assert.match(home, /class="sg-label sg-display sg-recs-kicker"/);
  assert.match(home, /<form class="sg-recs-form" method="post">/, 'without JavaScript, email must not be sent in the URL');
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
