const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderPreviousGuestInvitationEmail } = require('../src/lib/mailer');
const { invitationExpiry, tokenHash } = {
  ...require('../src/lib/guest-invitations'),
  ...require('../src/lib/guest-session')
};

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('returning guest persistence is separate from privileged account authentication', () => {
  const migration = read('src/db/migrations/036_returning_guest_identity.sql');
  const guestSession = read('src/lib/guest-session.js');
  const publicRoutes = read('src/routes/public.js');

  assert.match(migration, /CREATE TABLE IF NOT EXISTS guest_sessions/);
  assert.match(migration, /token_hash\s+TEXT UNIQUE NOT NULL/);
  assert.match(migration, /verified_at\s+TIMESTAMPTZ/);
  assert.match(migration, /guest_session_id BIGINT/);
  assert.match(guestSession, /COOKIE_NAME = 'sge_guest'/);
  assert.doesNotMatch(guestSession, /sge_session/);
  assert.match(publicRoutes, /guest_session_id=\$2/);
  assert.match(publicRoutes, /Open your personal invitation or confirmation email/);
  assert.match(publicRoutes, /clearSessionCookie\(res\)/);
});

test('both public presentations use the personalized one-tap RSVP state', () => {
  const client = read('public/js/public-event.js');
  for (const template of ['src/views/event-public.html', 'src/views/event-public-flyer.html']) {
    const view = read(template);
    assert.match(view, /id="returning-rsvp-state"/);
    assert.match(view, /Hi <span id="returning-rsvp-name"/);
    assert.match(view, /Are you going\?/);
    assert.match(view, />I’m going<\/button>/);
    assert.match(view, />I’m not going<\/button>/);
    assert.match(view, /Not <span id="returning-rsvp-switch-name"/);
  }
  assert.match(client, /returning-rsvp/);
  assert.match(client, /aria-pressed/);
  assert.match(client, /guest-session\/forget/);
  assert.match(client, /EVENT\.returningGuest\.response/);
});

test('personal invitation tokens are opaque, hashed, expiring, and scanner-safe', () => {
  const routes = read('src/routes/public.js');
  const worker = read('src/jobs/previous-guest-invitations.js');
  assert.equal(tokenHash('secret-token').length, 64);
  assert.ok(invitationExpiry('2032-01-01') > new Date());
  assert.match(worker, /createGuestInvitation/);
  assert.match(worker, /invitationUrl/);
  assert.match(routes, /router\.get\('\/g\/:token'/);
  const inviteGet = routes.slice(routes.indexOf("router.get('/g/:token'"), routes.indexOf("router.get('/api/public/guest-session'"));
  assert.doesNotMatch(inviteGet, /status='confirmed'|INSERT INTO rsvps|response='going'/);

  const personalUrl = 'https://silvergliderevents.com/g/opaque_personal_token';
  const html = renderPreviousGuestInvitationEmail({
    event: {
      title: 'Next Night', slug: 'next-night', event_date: '2030-10-10', start_time: '20:00',
      venue_name: 'Test Hall', venue_address: '1 Test Way', presentation_mode: 'standard'
    },
    recipientName: 'Lucas Moon',
    organizerLabel: 'Heatwave Booking',
    sourceEventTitle: 'First Night',
    unsubscribeUrl: 'https://silvergliderevents.com/unsubscribe?token=safe',
    invitationUrl: personalUrl
  });
  assert.match(html, /opaque_personal_token/);
  assert.doesNotMatch(html, /href="https:\/\/silvergliderevents\.com\/e\/next-night"/);
});

test('recognized guests can become creators only through the existing magic link', () => {
  const auth = read('src/routes/auth.js');
  const login = read('src/views/login.html');
  assert.match(auth, /router\.post\('\/api\/auth\/guest-magic-link'/);
  assert.match(auth, /sendMagicLink/);
  assert.match(auth, /intent,target_organizer_id,return_path/);
  assert.doesNotMatch(auth.slice(auth.indexOf("router.post('/api/auth/guest-magic-link'"), auth.indexOf('// GET /auth/verify')), /setSessionCookie/);
  assert.match(login, /Continue as \$\{guest\.firstName\}/);
  assert.match(login, /Email my sign-in link/);
  assert.match(login, /Use a different email/);
});
