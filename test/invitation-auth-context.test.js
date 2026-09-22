const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('phone authentication narrowly accepts host-invitation onboarding destinations', () => {
  const auth = read('src/routes/auth.js');
  const creatorNext = auth.slice(
    auth.indexOf('function creatorNext'),
    auth.indexOf('// In-memory limits')
  );

  assert.ok(creatorNext.includes(
    'const hostInvitation = /^\\/host-invitation\\/[a-z0-9-]{12,220}$/.test(next);'
  ));
  assert.match(creatorNext, /next === '\/events\/new'/);
  assert.match(creatorNext, /next\.startsWith\('\/events\/new\?'\)/);
  assert.equal(creatorNext.includes("startsWith('/host-invitation/"), false);
});

test('invitation sign-in reuses one auth UI with device-aware emphasis and both methods', () => {
  const login = read('src/views/login.html');

  assert.ok(login.includes(
    'const invitationAuthFlow = /^\\/host-invitation\\/[a-z0-9-]{12,220}$/.test(next);'
  ));
  assert.match(login, /matchMedia\('\(max-width: 879px\)'\)\.matches/);
  assert.match(login, /const initialPhoneState = creatorPhoneFlow && \(!invitationAuthFlow \|\| invitationPhoneFirst\)/);
  assert.match(login, /if \(initialPhoneState\) \{[\s\S]*showState\('phone-state'\)/);
  assert.match(login, /id="use-phone-instead" hidden>Use phone instead<\/button>/);
  assert.match(login, /usePhoneInstead\.hidden = !creatorPhoneFlow/);
  assert.match(login, /usePhoneInstead\.addEventListener\('click', showPhoneLogin\)/);
  assert.match(login, /class="auth-secondary use-email-instead"[^>]*>Use email instead<\/button>/);
  assert.match(login, /document\.getElementById\('restart-phone'\)\.hidden = !creatorPhoneFlow/);
});

test('invitation sign-in explains the Host Page journey with approved product copy', () => {
  const login = read('src/views/login.html');

  assert.match(login, /Accept your invitation/);
  assert.match(login, /Sign in to create your Host Page\. Publish unique event pages and collect RSVPs\./);
  assert.match(login, /fetch\(`\/api\/public\/host-invitations\/\$\{encodeURIComponent\(invitationToken\)\}`/);
  assert.match(login, /Host invitation · \$\{hostName\}/);
  assert.doesNotMatch(login, /Publish beautiful event pages and collect RSVPs/);
});
