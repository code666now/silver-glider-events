const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('customer navigation uses the warmer page, Home base, and Following language', () => {
  const shell = read('public/js/api.js');
  const dashboard = read('src/views/dashboard.html');
  const publicHosts = read('src/routes/public-hosts.js');
  const following = read('src/views/following.html');

  assert.match(shell, /data-sg-account-host-label>Your page/);
  assert.match(shell, /\['following', '\/following', 'Following'\]/);
  assert.match(dashboard, /dashboard-eyebrow dashboard-desktop-only">Home base</);
  assert.match(publicHosts, /aria-label="Return to Home base">← Home base<\/a>/);
  assert.match(following, /<h1 class="sg-page-title">Following<\/h1>/);
  assert.match(following, /The people and places you follow\./);
  assert.match(following, /You’re not following anyone yet\./);
  assert.match(following, /Follow people and places you like\. They’ll show up here\./);
});

test('page settings and first-event creation ask who is hosting in human language', () => {
  const settings = read('src/views/settings-v2.html');
  const quickCreate = read('src/views/event-create.html');
  const quickCreateClient = read('public/js/event-create.js');
  const fullForm = read('src/views/event-form.html');
  const fullFormClient = read('public/js/event-form.js');
  const eventsRoute = read('src/routes/events.js');
  const hostProfile = read('src/lib/host-profile.js');

  assert.match(settings, /id="host-page-title">Your page<\/h2>/);
  assert.match(settings, /Give guests one public home for your events and host identity\./);
  assert.match(settings, /<label for="org_name">Who’s hosting\?<\/label>/);
  assert.match(quickCreate, /id="create-host-field" hidden>[\s\S]*Who’s hosting this\?/);
  assert.match(quickCreate, /This is the name guests will see\./);
  assert.match(quickCreateClient, /requiresHostName = !hostName \|\| !organizer\.public_slug/);
  assert.match(quickCreateClient, /await organizerProfileReady/);
  assert.match(quickCreateClient, /presenter_name: requiresHostName \? \$\('create-host-name'\)\.value\.trim\(\) : null/);
  assert.match(fullForm, /id="presenter-field" hidden[\s\S]*Who’s hosting this\?/);
  assert.match(fullFormClient, /const needsHostName = !organizer\.org_name \|\| !organizer\.public_slug/);
  assert.match(eventsRoute, /Tell guests who’s hosting this event\./);
  assert.match(eventsRoute, /effectiveOrganizer = await ensureHostProfile/);
  assert.match(hostProfile, /WHERE id=\$1 AND \(org_name IS NULL OR BTRIM\(org_name\)=''\)/);
});

test('My Events keeps Hosting while guest-facing cards never invent a generic host', () => {
  const events = read('src/views/events.html');
  const hostPage = read('src/views/host-public.html');

  assert.match(events, /data-view="hosting">Hosting<\/button>/);
  assert.doesNotMatch(events, /Silver Glider host/);
  assert.match(events, /going && hostName \? `<p style="margin-top:6px">Hosted by \$\{sgEscapeHtml\(hostName\)\}<\/p>` : ''/);
  assert.match(hostPage, /Events presented by/);
});
