const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

test('Done For You detail hides its loading skeleton after the client request settles', () => {
  const css = read('public/css/admin-done-for-you.css');
  const script = read('public/js/admin-done-for-you-detail.js');

  assert.match(script, /finally \{[\s\S]*dfyDetailLoading\.hidden = true/);
  assert.match(css, /\.dfy-detail-loading\[hidden\] \{ display: none; \}/);
});

function intakeSwitchFixture({ allowed = true, active = false, save } = {}) {
  const script = read('public/js/admin-done-for-you.js');
  const start = script.indexOf('async function dfyToggleIntake()');
  const end = script.indexOf('\nasync function dfyCopyFlyerLink()', start);
  assert.ok(start >= 0 && end > start, 'the existing intake action must remain available');
  const attributes = { 'aria-checked': String(active) };
  const toggle = { disabled: false, setAttribute(name, value) { attributes[name] = value; } };
  const state = { canManageIntake: allowed, acceptingSubmissions: active };
  const caption = { textContent: active ? 'On · the 24-hour promise is visible' : 'Off · the public page shows submissions paused' };
  const status = { className: '', textContent: '' };
  const calls = [];
  const context = vm.createContext({
    dfyState: state, dfyIntakeToggle: toggle, dfyIntakeCaption: caption, dfyIntakeStatus: status,
    api: async (url, options) => { calls.push({ url, options }); return save(options); }
  });
  vm.runInContext(script.slice(start, end), context);
  return { toggle, state, caption, status, attributes, calls, click: () => context.dfyToggleIntake() };
}

test('Done For You tactile intake switch keeps native button semantics and a stable accessible name', () => {
  const html = read('src/views/admin-done-for-you.html');
  const button = html.match(/<button\b[^>]*id="dfy-intake-toggle"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.ok(button);
  assert.match(button, /class="[^"]*\bsg-switch-button\b/);
  assert.match(button, /type="button"/);
  assert.match(button, /role="switch"/);
  assert.match(button, /aria-checked="false"/);
  assert.match(button, /aria-label="Accepting Submissions"/);
  assert.match(button, /<span class="sg-switch-track" aria-hidden="true"><\/span>/);
  assert.doesNotMatch(button, /tabindex="-1"/);
  assert.match(read('public/js/admin-done-for-you.js'), /dfyIntakeToggle\.addEventListener\('click', dfyToggleIntake\)/);
});

test('Done For You intake switch keeps confirmed state while pending and prevents duplicate submissions', async () => {
  let finish;
  const fixture = intakeSwitchFixture({ save: () => new Promise(resolve => { finish = resolve; }) });
  const first = fixture.click();
  await fixture.click();
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].url, '/api/admin/done-for-you/flyer-intake/settings');
  assert.equal(fixture.calls[0].options.method, 'PATCH');
  assert.equal(fixture.calls[0].options.body.acceptingSubmissions, true);
  assert.equal(fixture.toggle.disabled, true);
  assert.equal(fixture.attributes['aria-checked'], 'false');
  assert.equal(fixture.state.acceptingSubmissions, false);
  assert.match(fixture.status.textContent, /Opening submissions/);
  finish({ settings: { acceptingSubmissions: true } });
  await first;
  assert.equal(fixture.toggle.disabled, false);
  assert.equal(fixture.attributes['aria-checked'], 'true');
  assert.equal(fixture.state.acceptingSubmissions, true);
  assert.match(fixture.caption.textContent, /^On/);
  assert.equal(fixture.status.textContent, 'Flyer submissions are open.');
});

test('Done For You failed intake changes retain the original state and can be retried', async () => {
  let attempts = 0;
  const fixture = intakeSwitchFixture({ active: true, save: async () => {
    if (++attempts === 1) throw new Error('Connection lost');
    return { settings: { acceptingSubmissions: false } };
  } });
  await fixture.click();
  assert.equal(fixture.toggle.disabled, false);
  assert.equal(fixture.attributes['aria-checked'], 'true');
  assert.equal(fixture.state.acceptingSubmissions, true);
  assert.match(fixture.caption.textContent, /^On/);
  assert.equal(fixture.status.textContent, 'Connection lost');
  assert.match(fixture.status.className, /error/);
  await fixture.click();
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.calls[1].options.body.acceptingSubmissions, false);
  assert.equal(fixture.attributes['aria-checked'], 'false');
  assert.equal(fixture.state.acceptingSubmissions, false);
  assert.equal(fixture.status.textContent, 'Flyer submissions are paused.');
});

test('Done For You intake switch cannot submit without the existing manage-intake capability', async () => {
  const fixture = intakeSwitchFixture({ allowed: false, save: () => { throw new Error('Must not submit'); } });
  await fixture.click();
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.attributes['aria-checked'], 'false');
});
