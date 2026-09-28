const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('admin identity controls keep verification with the recipient', () => {
  const html = read('src/views/admin-accounts.html');
  const script = read('public/js/admin-accounts.js');
  const styles = read('public/css/admin-accounts.css');

  assert.match(html, /The recipient controls verification/);
  assert.match(html, /Support can send a change request, but cannot verify an email or phone for someone else/);
  assert.match(html, /id="request-email-change"/);
  assert.match(html, /id="request-phone-change"/);
  assert.match(html, /id="account-identity-trust-note"[^>]*hidden/);
  assert.match(html, /id="account-identity-actions"[^>]*hidden/);
  assert.match(html, /id="account-pending-identity-list"/);
  assert.match(html, /id="identity-change-dialog"[^>]*aria-labelledby="identity-change-title"[^>]*aria-describedby="identity-change-description"/);
  assert.match(html, /Support cannot complete this step/);
  assert.match(html, /id="identity-change-reason"[^>]*minlength="8"/);
  assert.doesNotMatch(html, /id="identity-change-(?:code|token)"/);

  assert.match(script, /identityChangeRequests/);
  assert.match(script, /identity_change_requests/);
  assert.match(script, /session\?\.capabilities\?\.manageIdentities === true/);
  assert.match(script, /if \(!state\.canManageIdentities\) \{[\s\S]*?section\.hidden = true;[\s\S]*?list\.replaceChildren\(\);/);
  assert.match(script, /actions\.hidden = !state\.canManageIdentities/);
  assert.match(script, /trustNote\.hidden = !state\.canManageIdentities/);
  assert.match(script, /state\.canManageIdentities[\s\S]*?audit\.filter[\s\S]*?includes\('identity_change'\)/);
  assert.match(script, /\/api\/admin\/accounts\/\$\{encodeURIComponent\(state\.selectedId\)\}\/identity-changes/);
  assert.match(script, /identity-changes\/\$\{encodeURIComponent\(changeId\)\}\/\$\{resend \? 'resend' : 'cancel'\}/);
  assert.match(script, /body:\{ type:state\.identityChangeType, value, reason \}/);
  assert.match(script, /delivery_failed/);
  assert.match(script, /conflict/);
  assert.match(script, /expired/);
  assert.match(script, /Only its recipient can complete the change/);
  assert.doesNotMatch(script, /identity-changes[^\n]{0,100}\/verify/);
  assert.doesNotMatch(script, /identity-changes[^\n]{0,260}body:\{[^}]*\b(?:token|code)\b[^}]*\}/);

  assert.match(styles, /\.accounts-identity-actions \.sg-btn \{[^}]*min-height:44px/);
  assert.match(styles, /\.accounts-identity-trust-note\[hidden\],\.accounts-identity-actions\[hidden\] \{ display:none; \}/);
  assert.match(styles, /@media \(max-width:879px\)[\s\S]*\.accounts-identity-actions \.sg-btn \{[^}]*min-height:52px/);
  assert.match(styles, /@media \(max-width:560px\)[\s\S]*\.accounts-pending-identity \{ grid-template-columns:1fr/);
});

test('public identity verification page confirms ownership without creating a session', () => {
  const html = read('src/views/account-verify-change.html');
  const script = read('public/js/account-verify-change.js');
  const styles = read('public/css/account-verify-change.css');

  assert.match(html, /id="identity-email-confirm"/);
  assert.match(html, /id="identity-phone-code"[^>]*autocomplete="one-time-code"/);
  assert.match(html, /id="identity-phone-target"/);
  assert.match(html, /Only the recipient can complete this change/);
  assert.match(html, /this confirmation did not sign you in/);
  assert.match(html, /id="identity-error-title"[^>]*tabindex="-1"/);

  assert.match(script, /window\.history\.replaceState\(\{\}, '', '\/account\/verify-change'\)/);
  assert.match(script, /request\(`\/api\/account\/identity-change\?token=\$\{encodeURIComponent\(token\)\}`\)/);
  assert.match(script, /request\('\/api\/account\/identity-change\/verify', \{ method:'POST',body:\{ token \} \}\)/);
  assert.match(script, /body:\{ token, code \}/);
  assert.match(script, /\['maskedValue', 'masked_value', 'value'\]/);
  assert.doesNotMatch(script, /body:\{ phone, code \}/);
  assert.match(script, /\['expired', 'cancelled', 'canceled', 'conflict', 'delivery_failed', 'superseded'\]/);
  assert.match(script, /code\.includes\('delivery'\)/);
  assert.doesNotMatch(script, /\/api\/(?:auth\/verify-code|me\/identities)/);
  assert.doesNotMatch(script, /(?:session|cookie|localStorage)\s*=/);

  assert.match(styles, /min-height:100dvh/);
  assert.match(styles, /@media \(max-width:879px\)/);
  assert.match(styles, /\.identity-verify-card \.sg-btn \{[^}]*min-height:58px/);
  assert.match(styles, /@media \(prefers-reduced-motion:reduce\)/);
});
