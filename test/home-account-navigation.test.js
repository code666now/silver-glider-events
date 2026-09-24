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
  assert.match(home, /src="\/js\/api\.js" defer/);
  assert.match(home, /src="\/js\/home-account-nav\.js" defer/);

  assert.match(client, /fetch\('\/api\/auth\/me'/);
  assert.match(client, /credentials: 'same-origin'/);
  assert.match(client, /cache: 'no-store'/);
  assert.match(client, /if \(!response\.ok\) return null/);
  assert.doesNotMatch(client, /api\('\/api\/auth\/me'/, 'optional homepage auth must not redirect signed-out visitors');
  assert.match(client, /sgAccountMenuMarkup\('sg-home-account'\)/);
  assert.match(client, /class="sg-home-mobile-profile" href="\/profile"/);
  assert.match(client, /openMenuSheet\(menuToggle\)/);
  assert.match(client, /signOutDestination: '\/'/);
});

test('desktop and phone account menus use current Silver Glider destinations and account state', () => {
  const shell = read('public/js/api.js');
  const styles = read('public/css/main.css');

  for (const destination of ['/dashboard', '/events', '/events/new', '/following', '/settings/messaging', '/profile', '/settings']) {
    assert.match(shell, new RegExp(`href="${destination.replaceAll('/', '\\/')}"`));
  }
  assert.match(shell, /account\.public_slug/);
  assert.match(shell, /Create Host Page/);
  assert.match(shell, /sgPaintAvatar\(el, sgCurrentAccount\)/);
  assert.match(shell, /fetch\('\/api\/admin\/auth\/me'/);
  assert.match(shell, /document\.body\.classList\.contains\('sg-home-page'\)/);
  assert.match(shell, /homePrimaryLinks/);
  assert.match(styles, /\.sg-account-trigger-name/);
  assert.match(styles, /width: min\(310px, calc\(100vw - 32px\)\)/);
  assert.match(styles, /max-height: calc\(100dvh - 100px\)[\s\S]*overflow-y: auto/);
  assert.match(styles, /\.sg-account-popover a,\.sg-account-popover button \{[\s\S]*min-height: 44px/);
  assert.match(shell, /menuSheetMedia\.addEventListener\('change', event => \{[\s\S]*mobileTrigger/);
  assert.match(shell, /visibleReturnFocus \|\| visibleDesktopTrigger/);
  assert.match(shell, /document\.body\.classList\.contains\('sg-home-page'\) \? '\/' : '\/login'/);
});
