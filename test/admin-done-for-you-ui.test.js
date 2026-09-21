const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Done For You pages require a dedicated admin session and live in the shared admin shell', () => {
  const index = read('src/index.js');
  const shell = read('public/js/admin-shell.js');
  const overview = read('src/views/admin-overview.html');
  const overviewScript = read('public/js/admin-overview.js');

  assert.match(index, /app\.get\('\/admin\/done-for-you', requireAdmin, requireAdmin\.requireDedicatedAdmin, view\('admin-done-for-you\.html'\)\)/);
  assert.match(index, /app\.get\('\/admin\/done-for-you\/:id', requireAdmin, requireAdmin\.requireDedicatedAdmin/);
  assert.match(shell, /'done-for-you', '\/admin\/done-for-you', 'Done For You'/);
  assert.match(shell, /capabilities\.manageDoneForYou === true/);
  assert.match(shell, /data-admin-link="done-for-you"/);
  assert.doesNotMatch(shell, /\/admin\/line/);
  assert.match(overview, /id="overview-done-for-you"[^>]*hidden/);
  assert.match(overviewScript, /capabilities\?\.manageDoneForYou !== true/);
});

test('client provisioning checks exact ownership before creating or reusing a permanent User ID', () => {
  const html = read('src/views/admin-done-for-you.html');
  const script = read('public/js/admin-done-for-you.js');

  assert.match(html, /id="client-host-name"/);
  assert.match(html, /id="client-contact-name"/);
  assert.match(html, /id="client-email"[^>]*type="email"/);
  assert.match(html, /for="client-phone">Mobile number <span>Optional<\/span>[\s\S]*id="client-phone"/);
  assert.match(html, /Administrators prepare\. Recipients verify\./);
  assert.match(html, /\/css\/admin-done-for-you\.css/);
  assert.match(html, /\/js\/admin-done-for-you\.js/);
  assert.doesNotMatch(html, /<script>(?!\s*<\/script>)/);

  assert.match(script, /api\('\/api\/admin\/done-for-you\/lookup'/);
  assert.match(script, /api\('\/api\/admin\/done-for-you',/);
  assert.match(script, /expectedUserId: expectedUserId == null \? null : Number\(expectedUserId\)/);
  assert.match(script, /Use User ID \$\{expectedUserId\} and create Host Page/);
  assert.match(script, /Reactivate User ID/);
  assert.match(script, /No existing account found/);
  assert.match(script, /function dfyFocusPreflight\(\)/);
  assert.match(script, /dfyPreflight\.focus\(\{ preventScroll: true \}\)/);
  for (const errorCode of ['split_identity_owners', 'identity_projection_conflict', 'unverified_phone_requires_manual_review']) {
    assert.match(script, new RegExp(errorCode));
  }
  assert.match(script, /\/admin\/accounts\?q=\$\{encodeURIComponent\(id\)\}/);
  assert.match(script, /Nothing was created or merged/);
  assert.doesNotMatch(`${html}\n${script}`, /impersonat|setSessionCookie|\/api\/auth\/login|\/events\/new/i);
});

test('client detail clearly separates account trust, public Host Page data, claim handoff, and events', () => {
  const html = read('src/views/admin-done-for-you-detail.html');
  const script = read('public/js/admin-done-for-you-detail.js');

  for (const heading of ['Account owner', 'Claim access', 'Host Page', 'Events']) {
    assert.match(html, new RegExp(heading));
  }
  assert.match(html, /id="host-contact-email"/);
  assert.match(html, /separate from the owner’s private sign-in email and is never copied automatically/);
  assert.match(script, /Verified sign-in method/);
  assert.match(script, /Unverified contact/);
  assert.match(script, /Not available/);
  assert.match(script, /for \(const contact of dfyDetailState\.contacts\)/);
  assert.match(script, /for \(const type of \['email', 'phone'\]\)/);
  assert.match(script, /Only the recipient can verify ownership/);
  assert.match(script, /id="claim-recipient-email"/);
  assert.match(script, /verified sign-in/);
  assert.match(script, /unverified contact/);
  assert.match(script, /body: \{ email \}/);
  assert.match(script, /No email is attached to this prepared client/);
  assert.match(script, /\/api\/admin\/done-for-you\/\$\{encodeURIComponent\(dfyDetailState\.id\)\}\/claim-invitation/);
  assert.match(script, /\/api\/admin\/hosts\/\$\{encodeURIComponent\(hostId\)\}\/profile/);
  assert.match(script, /\/api\/admin\/uploads\/hosts\/\$\{encodeURIComponent\(hostId\)\}\/\$\{kind\}/);
  assert.match(script, /contact_email: document\.getElementById\('host-contact-email'\)\.value\.trim\(\)/);
  assert.match(script, /function dfyDetailApplyHostResponse\(payload\)/);
  assert.match(script, /\['orgName', 'org_name'\]/);
  assert.doesNotMatch(script, /dfyDetailState\.host\s*=\s*\{\s*\.\.\.dfyDetailState\.host,\s*\.\.\.data\.(?:host|organizer)/);
  assert.match(script, /No events belong to this Host Page yet/);
  assert.match(html, /id="create-client-event"[^>]*>Create event</);
  assert.match(script, /data-event-id=/);
  assert.match(script, />Continue setup<\/button>/);
  assert.match(script, /\/editor-workspaces/);
  assert.doesNotMatch(`${html}\n${script}`, /(?:href|location(?:\.href|\.assign)?)\s*=\s*["'`]\/events\/new|impersonat|customer session/i);
});

test('Done For You layout keeps touch targets and responsive single-column detail flows', () => {
  const css = read('public/css/admin-done-for-you.css');
  assert.match(css, /\.dfy-dialog-actions \.sg-btn \{ min-height: 44px/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /\.dfy-dialog \{ width: 100vw; max-height: 100dvh/);
  assert.match(css, /\.dfy-detail-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.dfy-preflight-links a \{ min-height: 44px/);
  assert.match(css, /\.dfy-text-link \{ min-height: 44px/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});
