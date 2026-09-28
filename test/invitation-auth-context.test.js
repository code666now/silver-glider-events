const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('phone authentication accepts safe Silver Glider destinations and rejects unsafe redirects', () => {
  const auth = read('src/routes/auth.js');
  const destinationHelpers = auth.slice(
    auth.indexOf('function safeNext'),
    auth.indexOf('// In-memory limits')
  );

  assert.match(destinationHelpers, /next\.startsWith\('\/'\)/);
  assert.match(destinationHelpers, /next\.startsWith\('\/\/'\)/);
  assert.match(destinationHelpers, /next\.includes\('\\\\'\)/);
  assert.match(destinationHelpers, /\/%5c\/i/);
  assert.match(destinationHelpers, /const normalized =/);
  assert.match(destinationHelpers, /normalized\.startsWith\('\/\/'\)/);
  assert.match(destinationHelpers, /function phoneSignInNext/);
  assert.match(destinationHelpers, /return requested \? safeNext\(requested\) : '\/dashboard'/);
});

test('invitation sign-in reuses one auth UI with device-aware emphasis and both methods', () => {
  const login = read('src/views/login.html');

  assert.ok(login.includes(
    'const invitationAuthFlow = /^\\/host-invitation\\/[a-z0-9-]{12,220}$/.test(next);'
  ));
  assert.match(login, /matchMedia\('\(max-width: 879px\)'\)\.matches/);
  assert.match(login, /const initialPhoneState = phoneSizedDevice/);
  assert.match(login, /if \(initialPhoneState\) \{[\s\S]*showState\('phone-state'\)/);
  assert.match(login, /id="use-phone-instead" hidden>Use phone instead<\/button>/);
  assert.match(login, /usePhoneInstead\.hidden = false/);
  assert.match(login, /usePhoneInstead\.addEventListener\('click', showPhoneLogin\)/);
  assert.match(login, /class="auth-secondary use-email-instead"[^>]*>Use email instead<\/button>/);
  assert.match(login, /document\.getElementById\('restart-phone'\)\.hidden = false/);
  assert.match(login, /id="phone-progress">Sign in<\/p>/);
  assert.match(login, /id="phone-heading">Sign in with your phone<\/h1>/);
  assert.match(login, /else if \(eventCreationAuthFlow\) \{[\s\S]*Create your event[\s\S]*Start with your phone/);
});

test('invitation sign-in explains the Host Page journey with approved product copy', () => {
  const login = read('src/views/login.html');

  assert.match(login, /Accept your invitation/);
  assert.match(login, /Sign in to create your Host Page\. Publish unique event pages and collect RSVPs\./);
  assert.match(login, /fetch\(`\/api\/public\/host-invitations\/\$\{encodeURIComponent\(invitationToken\)\}`/);
  assert.match(login, /Host invitation · \$\{hostName\}/);
  assert.doesNotMatch(login, /Publish beautiful event pages and collect RSVPs/);
});
