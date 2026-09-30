const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('a lineup invitation is one email to an address the host typed, and never shares guests', () => {
  const lib = read('src/lib/lineup-claims.js');
  const routes = read('src/routes/events.js');
  const mailer = read('src/lib/mailer.js');

  // One row per slot; an invitation is only created when the email changes.
  assert.match(lib, /CONSTRAINT|INSERT INTO event_artist_claims/);
  assert.match(lib, /current && current\.email === email/);
  assert.match(lib, /current\?\.status === 'claimed'/, 'a claimed slot is never re-invited');
  assert.match(lib, /returnPath: `\/lineup\/\$\{invite\.claimId\}`/);
  assert.match(lib, /withCode: false/);
  assert.match(routes, /await deliverLineupClaimInvites\(/,
    'the save response waits for the one invitation attempt to finish');
  assert.match(mailer, /async function sendLineupClaim\(/);
  assert.doesNotMatch(lib, /rsvps|guest/i, 'claims never touch the guest list');

  // The claim endpoints are authenticated and check the email owner.
  assert.match(routes, /router\.use\('\/api\/lineup', requireOrganizer\)/);
  assert.match(routes, /identity\.verification_scope='account'/);
  assert.match(routes, /identity\.verified_at IS NOT NULL/);
  assert.match(routes, /identity\.revoked_at IS NULL/);
  assert.match(routes, /This invitation was sent to a different email address/);
  assert.match(routes, /notifyHostOfClaim\(claim, rows\[0\]\.status\)/);
  assert.match(routes, /WHERE id=\$1 AND status <> \$2 RETURNING status/,
    'repeating the same answer is idempotent and does not notify the host again');
});

test('a declined artist disappears from the public page, and the editor keeps the saved email', () => {
  const publicRoutes = read('src/routes/public.js');
  const routes = read('src/routes/events.js');
  const form = read('src/views/event-form.html');
  const formJs = read('public/js/event-form.js');

  assert.match(publicRoutes, /\.filter\(entry => !declinedSlots\.has\(entry\.slot\)\)/);
  assert.match(publicRoutes, /declinedLineupSlots\(pool, event\.id\)/);
  assert.match(routes, /SELECT slot, email, status, artist_name FROM event_artist_claims/);
  assert.match(form, /id="event_vibe_email"/);
  assert.match(form, /never shares your guest list/);
  assert.match(formJs, /event_vibe_email: \$\('event_vibe_email'\)\.value\.trim\(\) \|\| null/);
  assert.match(formJs, /event\.lineup\?\.\[1\]\?\.email/);
});

test('the claim screen offers both answers and never assumes yes', () => {
  const view = read('src/views/lineup-claim.html');
  assert.match(view, /That's me/);
  assert.match(view, /Not me/);
  assert.match(view, /api\(`\/api\/lineup\/\$\{encodeURIComponent\(claimId\)\}\/\$\{action\}`, \{ method: 'POST' \}\)/);
  assert.match(view, /never shares the host's guest list/);
});

test('a claimed night shows up as Playing, on Home and in My Events', () => {
  const routes = read('src/routes/events.js');
  const events = read('src/views/events.html');
  const dashboard = read('src/views/dashboard.html');
  const claim = read('src/views/lineup-claim.html');

  // Going covers both what you RSVP'd to and what you claimed; playing wins.
  assert.match(routes, /SELECT c\.event_id, TRUE AS playing, c\.claimed_at AS joined_at/);
  assert.match(routes, /WHERE c\.organizer_id=\$1 AND c\.status='claimed'/);
  assert.match(routes, /ORDER BY e\.id, mine\.playing DESC, mine\.joined_at DESC/);

  assert.match(events, /ev\.playing[\s\S]*playing-label">Playing/);
  // Home counts a night you're playing, but its stats stay about events you host.
  assert.match(dashboard, /item\.playing && item\.status === 'published'/);
  assert.match(dashboard, /ev\.isPlaying \? 'Your next night\.' : 'Your next event\.'/);
  assert.match(dashboard, /getElementById\('upcoming-count'\)\.textContent = String\(hostedUpcoming\.length\)/);
  assert.match(claim, /See it in my events/);
});

test('admin traction measures the loops read-only and tolerates the legacy test flag', () => {
  const routes = read('src/routes/admin.js');
  const view = read('src/views/admin-overview.html');
  const script = read('public/js/admin-overview.js');

  assert.match(routes, /router\.get\('\/api\/admin\/traction'/);
  // A missing legacy column must read as "not a test account", never fail.
  assert.match(routes, /to_jsonb\(u\) ->> 'is_test_account'/);
  assert.match(routes, /AS hosts_with_second_event/);
  assert.match(routes, /AS invites_answered/);
  assert.match(routes, /AS rsvps_returning/);
  assert.match(routes, /prior\.start_time < c\.start_time/,
    'same-day earlier events use the shared returning-guest definition');
  assert.match(routes, /AS artists_claimed/);
  assert.doesNotMatch(routes.slice(routes.indexOf("router.get('/api/admin/traction'"), routes.indexOf("// GET /api/admin/hosts")),
    /INSERT|UPDATE|DELETE/, 'the traction endpoint only reads');

  assert.match(view, /id="traction-second"/);
  assert.match(view, /id="traction-claims"/);
  assert.match(script, /api\('\/api\/admin\/traction'\)/);
});
