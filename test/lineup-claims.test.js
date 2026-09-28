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
  assert.match(mailer, /async function sendLineupClaim\(/);
  assert.doesNotMatch(lib, /rsvps|guest/i, 'claims never touch the guest list');

  // The claim endpoints are authenticated and check the email owner.
  assert.match(routes, /router\.use\('\/api\/lineup', requireOrganizer\)/);
  assert.match(routes, /const mine = Boolean\(email\) && email === String\(claim\.email \|\| ''\)/);
  assert.match(routes, /This invitation was sent to a different email address/);
  assert.match(routes, /notifyHostOfClaim\(claim, rows\[0\]\.status\)/);
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
