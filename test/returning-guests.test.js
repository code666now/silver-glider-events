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

test('first-RSVP persistence stays separate from privileged account authentication', () => {
  const migration = read('src/db/migrations/036_returning_guest_identity.sql');
  const guestSession = read('src/lib/guest-session.js');
  const publicRoutes = read('src/routes/public.js');

  assert.match(migration, /CREATE TABLE IF NOT EXISTS guest_sessions/);
  assert.match(migration, /token_hash\s+TEXT UNIQUE NOT NULL/);
  assert.match(migration, /verified_at\s+TIMESTAMPTZ/);
  assert.match(migration, /guest_session_id BIGINT/);
  assert.match(guestSession, /COOKIE_NAME = 'sge_guest'/);
  assert.doesNotMatch(guestSession, /sge_session/);
  assert.match(publicRoutes, /guest_session_id/);
  assert.match(publicRoutes, /error: 'verification_required'/);
  assert.match(publicRoutes, /Confirm it’s you to update this RSVP\./);
  assert.match(publicRoutes, /clearSessionCookie\(res\)/);
});

test('invitation-link verification is resolved from its token and scoped to its own event', () => {
  const migration = read('src/db/migrations/037_sign_in_codes_and_session_revocation.sql');
  const guestSession = read('src/lib/guest-session.js');
  const routes = read('src/routes/public.js');
  const { guestVerifiedFor } = require('../src/lib/guest-session');

  assert.match(migration, /ADD COLUMN IF NOT EXISTS verified_event_id INT REFERENCES events\(id\)/);
  assert.match(guestSession, /verified_event_id/);
  const inviteGet = routes.slice(routes.indexOf("router.get('/g/:token'"), routes.indexOf("router.get('/api/public/guest-session'"));
  assert.match(inviteGet, /resolveGuestInvitation\(pool, invitationToken\)/);
  assert.match(inviteGet, /\?invite=\$\{encodeURIComponent\(invitationToken\)\}/);
  assert.doesNotMatch(inviteGet, /setGuestSessionCookie/);
  assert.match(routes, /resolveGuestInvitation\(db, invitationToken, \{ eventId \}\)/);

  const forwardedInvite = { verified_at: new Date(), verified_event_id: 7 };
  assert.equal(guestVerifiedFor(forwardedInvite, 7), true);
  assert.equal(guestVerifiedFor(forwardedInvite, 8), false);
  assert.equal(guestVerifiedFor({ verified_at: new Date(), verified_event_id: null }, 8), true);
  assert.equal(guestVerifiedFor({ verified_at: null, verified_event_id: null }, 8), false);
});

test('answered returning guests see a status card, and code verification stays inline', () => {
  const client = read('public/js/public-event.js');
  for (const template of ['src/views/event-public.html', 'src/views/event-public-flyer.html']) {
    const view = read(template);
    assert.match(view, /id="returning-rsvp-answer" hidden/);
    assert.match(view, />View RSVP<\/button>/);
    assert.match(view, /id="returning-rsvp-verify"/);
    assert.match(view, /\? RSVP as yourself<\/button>/);
    assert.doesNotMatch(view, /👋/);
  }
  assert.match(client, /function renderReturningState/);
  assert.match(client, /You’re going/);
  assert.match(client, /You can’t make it/);
  assert.match(client, /function confirmItsYou/);
  assert.match(client, /\/api\/auth\/guest-code/);
  assert.match(client, /\/api\/auth\/verify-code/);
  assert.match(client, /autocomplete="one-time-code"/);
  assert.match(client, /data\.confirmationResent/);
});

test('first and returning RSVPs share one responsive confirmation dialog', () => {
  const routes = read('src/routes/public.js');
  const client = read('public/js/public-event.js');
  const styles = read('public/css/rsvp-confirmation.css');
  for (const template of ['src/views/event-public.html', 'src/views/event-public-flyer.html']) {
    const view = read(template);
    assert.match(view, /\/css\/rsvp-confirmation\.css/);
    assert.match(view, /\{\{RSVP_CONFIRMATION_DIALOG\}\}/);
  }
  assert.match(routes, /function renderRsvpConfirmationDialog/);
  assert.match(routes, /id="rsvp-confirmation-dialog"/);
  assert.match(routes, /Add to calendar/);
  assert.match(routes, /Change my answer/);
  assert.match(routes, /A backup copy is also being emailed to you\./);
  assert.match(routes, /rsvpToken: rsvp\.manage_token/);
  assert.match(routes, /calendarUrl: `\/r\/\$\{encodeURIComponent\(rsvp\.manage_token\)\}\/calendar\.ics`/);
  assert.match(client, /function openRsvpConfirmation/);
  assert.match(client, /confirmationDialog\.showModal\(\)/);
  assert.match(client, /openRsvpConfirmation\(\{ fresh: !data\.alreadyRsvpd, trigger: btn \}\)/);
  assert.match(client, /EVENT\.returningGuest\?\.response && \['invitation', 'rsvp'\]\.includes\(EVENT\.returningGuest\.source\)/);
  assert.match(routes, /<dialog class="rsvp-confirmation-dialog"/);
  assert.match(styles, /\.rsvp-confirmation-dialog::backdrop/);
  assert.match(styles, /@media \(max-width:\s*640px\)/);
  assert.match(styles, /margin:\s*auto 0 0/);
  assert.match(styles, /max-height:\s*94dvh/);
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

test('returning RSVP state and owner preview preserve their distinct action contracts', () => {
  const routes = read('src/routes/public.js');
  const client = read('public/js/public-event.js');
  const eventPage = routes.slice(
    routes.indexOf("router.get('/e/:slug'"),
    routes.indexOf("router.get('/e/:slug/tickets'")
  );
  const dockSync = client.slice(
    client.indexOf('function syncMobileRsvpDock()'),
    client.indexOf('let mobileRsvpSyncQueued')
  );
  const initialState = client.slice(
    client.indexOf('if (EVENT.returningGuest) {'),
    client.indexOf('async function answerReturningRsvp')
  );

  // Anonymous viewers and owners without an RSVP keep the ordinary RSVP CTA
  // and therefore remain eligible for the generic mobile dock.
  assert.match(client, /let activeRsvpState = 'cta-state'/);
  assert.match(dockSync, /activeRsvpState === 'cta-state'/);
  assert.match(eventPage, /ownerPreview && recognizedGuestCandidate\?\.source === 'account' && !recognizedGuestCandidate\.rsvp\s*\? null/);

  // A signed-in non-owner is still a recognized one-tap viewer before they
  // answer; confirmed and cancelled answers use that same inline state. None
  // of those personalized states should fall back to the generic RSVP dock.
  assert.match(initialState, /EVENT\.rsvpEnabled !== false && !EVENT\.isPast && EVENT\.returningGuest\) show\('returning-rsvp-state'\)/);
  assert.doesNotMatch(dockSync, /activeRsvpState === 'returning-rsvp-state'/);

  // Owner recognition is no longer excluded up front. An owner who really has
  // an RSVP can see its status while the owner editor remains independently
  // mounted; only an unanswered owner candidate is reduced back to preview.
  const candidateLine = eventPage.match(/const recognizedGuestCandidate =[\s\S]*?: null;/)?.[0] || '';
  assert.ok(candidateLine, 'event page should resolve a returning-guest candidate');
  assert.doesNotMatch(candidateLine, /!ownerPreview/);
  assert.match(eventPage, /const ownerEditorHtml = ownerPreview \? renderOwnerEditor\(event\) : ''/);
  assert.match(eventPage, /returningGuest: returningGuestJson/);
});

test('personal invitation tokens are opaque, hashed, permanent, revocable, and scanner-safe', () => {
  const routes = read('src/routes/public.js');
  const worker = read('src/jobs/previous-guest-invitations.js');
  const migration = read('src/db/migrations/039_permanent_guest_invitation_tokens.sql');
  assert.equal(tokenHash('secret-token').length, 64);
  assert.equal(invitationExpiry('2032-01-01'), null);
  assert.match(migration, /ALTER COLUMN expires_at DROP NOT NULL/);
  assert.match(migration, /SET expires_at = NULL/);
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
  assert.match(auth, /const challenge = await signInIntent\(req\.body\)/);
  assert.match(auth, /await issueSignIn\(req, res, \{ email, \.\.\.challenge \}\)/);
  assert.doesNotMatch(auth.slice(auth.indexOf("router.post('/api/auth/guest-magic-link'"), auth.indexOf("router.post('/api/auth/guest-code'")), /setSessionCookie/);
  assert.match(login, /Continue as \$\{guest\.firstName\}/);
  assert.match(login, /Email my sign-in link/);
  assert.match(login, /Use a different email/);
});

test('personal URL tokens and “already on the list” both lead back to the guest’s answer', () => {
  const routes = read('src/routes/public.js');
  const client = read('public/js/public-event.js');
  const context = routes.slice(routes.indexOf('async function returningGuestContext'), routes.indexOf('const identity = req.sessionAccount;'));
  assert.match(context, /resolveGuestInvitation\(db, invitationToken, \{ eventId \}\)/);
  assert.match(context, /manage_token=\$2/);
  assert.match(context, /status IN \('confirmed','cancelled'\)/);
  for (const template of ['src/views/event-public.html', 'src/views/event-public-flyer.html']) {
    const view = read(template);
    assert.match(view, /id="success-title"/);
    assert.match(view, /id="success-manage" hidden/);
    assert.match(view, />Manage my RSVP here</);
  }
  assert.match(client, /You’re already on the list\./);
  assert.match(client, /codeRequest: \{ email: alreadyListedEmail \}/);
  assert.match(client, /\.\.\.personalAccess/);
  assert.match(client, /window\.location\.assign\(`\/e\/\$\{encodeURIComponent\(EVENT\.slug\)\}`\)/);
});
