const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('Follow Host migration extends the shared identity and magic-link models safely', () => {
  const migration = source('src/db/migrations/020_follow_host_v1.sql');
  assert.match(migration, /ALTER TABLE magic_link_tokens/);
  assert.match(migration, /intent TEXT NOT NULL DEFAULT 'sign_in'/);
  assert.match(migration, /target_organizer_id INT REFERENCES organizers\(id\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS host_follows/);
  assert.match(migration, /UNIQUE \(follower_organizer_id, host_organizer_id\)/);
  assert.match(migration, /host_follows_not_self/);
  assert.match(migration, /unsubscribed_at\s+TIMESTAMPTZ/);
  assert.match(migration, /source_event_id\s+INT REFERENCES events\(id\) ON DELETE SET NULL/);
  assert.doesNotMatch(migration, /CREATE TABLE (?:users|fans|hosts)/i);
});

test('follow intent is stored server-side and verification completes it transactionally', () => {
  const auth = source('src/routes/auth.js');
  const challenges = source('src/lib/sign-in-challenges.js');
  assert.match(auth, /intent === 'follow_host'/);
  assert.match(auth, /findPublicHost\(pool, body\.host_slug\)/);
  assert.match(auth, /await signInIntent\(req\.body\)/);
  assert.match(challenges, /intent, target_organizer_id, return_path/);
  assert.match(challenges, /PENDING_COLUMNS = '[^']*email, intent, target_organizer_id, return_path, phone_auth_challenge_id[^']*'/);
  assert.match(challenges, /RETURNING \$\{PENDING_COLUMNS\}/);
  assert.match(auth, /await client\.query\('BEGIN'\)/);
  assert.match(auth, /await followHost\(client, organizer\.id, pending\.target_organizer_id\)/);
  assert.match(auth, /await client\.query\('COMMIT'\)/);
  assert.doesNotMatch(auth, /intent=\$\{|host_id=\$\{/);
});

test('public Host Page uses the shared contextual sign-in and notification-preference flow', () => {
  const view = source('src/views/host-public.html');
  const route = source('src/routes/public-hosts.js');
  const flow = source('public/js/follow-flow.js');
  const styles = source('public/css/follow-flow.css');
  assert.match(view, /data-host-follow/);
  assert.match(view, /\/css\/follow-flow\.css/);
  assert.match(view, /\/js\/follow-flow\.js/);
  assert.match(view, /SGFollowFlow\.mount/);
  assert.match(flow, /<dialog class="sg-follow-dialog"/);
  assert.match(flow, /Sign in once to follow \$\{hostName\}/);
  assert.match(flow, /Continue with phone/);
  assert.match(flow, /Continue with email/);
  assert.match(flow, /matchMedia\('\(max-width: 879px\)'\)/);
  assert.match(flow, /\/api\/auth\/phone\/start/);
  assert.match(flow, /\/api\/auth\/phone\/verify/);
  assert.match(flow, /\/api\/auth\/magic-link/);
  assert.match(flow, /\/api\/auth\/guest-magic-link/);
  assert.match(flow, /\/api\/me\/identities/);
  assert.match(flow, /\/api\/me\/identities\/phone\/start/);
  assert.match(flow, /\/api\/me\/identities\/phone\/verify/);
  assert.match(flow, /data-channel="text"/);
  assert.match(flow, /data-channel="email"/);
  assert.match(flow, /Reply STOP to opt out/);
  assert.match(flow, /Your RSVP confirmations and event reminders stay separate/);
  assert.match(flow, /method: 'PATCH'/);
  assert.match(styles, /\.sg-follow-dialog::backdrop/);
  assert.match(styles, /@media \(max-width:640px\)/);
  assert.doesNotMatch(view, /id="follow-modal"/);
  assert.match(route, /Choose email, text, or both/);
  assert.match(route, /: 'Follow'/);
  assert.match(route, /Following <span aria-hidden="true">✓<\/span>/);
  assert.match(view, /Upcoming Events/);
  assert.match(view, /Past Events/);
});

test('Follow preferences are independent, use verified identity, and do not depend on host credits', () => {
  const follows = source('src/lib/host-follows.js');
  const routes = source('src/routes/follows.js');
  assert.match(follows, /async function setFollowPreferences/);
  assert.match(follows, /async function verifiedFollowPhone/);
  assert.match(follows, /identity\.verification_scope='account'/);
  assert.match(follows, /const wantsEmail = emailEnabled === true/);
  assert.match(follows, /const wantsText = textEnabled === true/);
  assert.match(follows, /smsAvailable: true/);
  assert.match(follows, /hostHasSmsCredits/);
  assert.doesNotMatch(follows, /No text credits available/);
  assert.match(routes, /router\.get\('\/api\/hosts\/:slug\/follow'/);
  assert.match(routes, /router\.patch\('\/api\/hosts\/:slug\/follow'/);
  assert.match(routes, /sourceEventSlug/);
  assert.match(routes, /setFollowPreferences/);
});

test('RSVP success optionally offers Follow without changing RSVP reminder consent', () => {
  const publicRoute = source('src/routes/public.js');
  const browser = source('public/js/public-event.js');
  for (const viewPath of ['src/views/event-public.html', 'src/views/event-public-flyer.html']) {
    const view = source(viewPath);
    assert.match(view, /\/css\/follow-flow\.css/);
    assert.match(view, /\/js\/follow-flow\.js/);
    assert.doesNotMatch(view, /id="organizer_optin"/);
  }
  assert.match(publicRoute, /id="rsvp-follow-host" hidden/);
  assert.match(publicRoute, /Get the next invite\. Texts are optional\./);
  assert.match(publicRoute, /id="rsvp-follow-host-button"[^>]*>Follow<\/button>/);
  assert.match(publicRoute, /hostSlug: event\.organizer_public_slug/);
  assert.match(browser, /async function prepareFollowAfterRsvp/);
  assert.match(browser, /organizer_optin: false/);
  assert.match(browser, /sourceEventSlug: EVENT\.slug/);
  assert.match(browser, /eventUrlParams\.get\('follow'\) === '1'/);
});

test('a fresh Going confirmation offers Follow or notification settings without promising delivery', async () => {
  const browser = source('public/js/public-event.js');
  const followCardFunctions = browser.slice(browser.indexOf('function setFollowCardState('), browser.indexOf('const icsUrl'));
  for (const [following, open, fresh, editing, response, cardVisible] of [
    [false, true, true, false, 'going', true],
    [true, true, true, false, 'going', true],
    [false, true, false, false, 'going', false],
    [true, true, true, true, 'going', false],
    [false, true, true, false, 'not_going', false],
    [true, false, true, false, 'going', false]
  ]) {
    const classes = new Set();
    const card = { hidden: true, classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } } };
    const button = { setAttribute(name, value) { this[name] = value; } };
    const copy = {};
    await vm.runInNewContext(`${followCardFunctions}\nprepareFollowAfterRsvp()`, {
      EVENT: { hostName: 'Test Host', returningGuest: { response } },
      confirmationDialog: { open }, confirmationFresh: fresh, confirmationEditing: editing,
      getEventFollowFlow: () => ({ status: async () => ({ following, emailOn: false, textOn: false }) }),
      $: id => ({ 'rsvp-follow-host': card, 'rsvp-follow-host-button': button, 'rsvp-follow-host-copy': copy })[id]
    });
    assert.equal(card.hidden, !cardVisible);
    if (cardVisible) {
      assert.equal(classes.has('is-following'), following);
      assert.equal(button.textContent, following ? 'Following ✓' : 'Follow');
      assert.match(button['aria-label'], new RegExp(`^${following ? 'Following' : 'Follow'} Test Host\\b`));
      assert.equal(copy.textContent, following ? 'Manage notifications for future events.' : 'Get the next invite. Texts are optional.');
    }
  }
});

function followDialogFixture(state, identities, sourceOptions = { sourceEventSlug: 'test-show' }) {
  let focused = null;
  let errorMessage = '';
  const requests = [];
  const elements = new Map();
  const body = {
    set innerHTML(markup) {
      elements.clear();
      for (const [, channel, attributes] of markup.matchAll(/<input[^>]+data-channel="(email|text)"([^>]*)>/g)) {
        const selector = `[data-channel="${channel}"]`;
        elements.set(selector, { checked: /\bchecked\b/.test(attributes), focus() { focused = channel; } });
      }
    },
    querySelector(selector) {
      if (selector === '.sg-follow-error') return null;
      if (!elements.has(selector)) elements.set(selector, {
        dataset: {}, focus() {}, setAttribute() {},
        addEventListener(event, handler) { this[event] = handler; }
      });
      return elements.get(selector);
    },
    prepend(error) { errorMessage = error.textContent; }
  };
  const dialog = {
    showModal() { this.open = true; },
    addEventListener() {},
    querySelector: selector => selector === '[data-follow-body]' ? body : { addEventListener() {} }
  };
  const window = {
    location: { href: 'https://example.test/e/test-show' },
    confirm() { assert.fail('a guest who has not followed should not see an unfollow prompt'); }
  };
  vm.runInNewContext(source('public/js/follow-flow.js'), {
    window, URL,
    document: {
      createElement: () => ({ firstElementChild: dialog, setAttribute() {} }),
      body: { appendChild() {}, classList: { add() {} } }
    },
    requestAnimationFrame: callback => callback(),
    fetch: async (url, { method = 'GET', body }) => {
      requests.push({ method, url, data: body && JSON.parse(body) });
      assert.ok(['/api/hosts/test-host/follow', '/api/me/identities'].includes(url));
      return { ok: true, json: async () => url === '/api/me/identities' ? { identities } : state };
    }
  });
  const flow = window.SGFollowFlow.mount({ hostSlug: 'test-host', hostName: 'Test Host', ...sourceOptions });
  return {
    flow, requests,
    channel: name => elements.get(`[data-channel="${name}"]`).checked,
    focus: () => focused,
    error: () => errorMessage,
    save: () => elements.get('[data-save]').click({ currentTarget: elements.get('[data-save]') })
  };
}

const followEmailIdentity = { type: 'email', value: 'guest@example.test', isPrimary: true };
const followPhoneIdentity = { type: 'phone', value: '+14155550101' };

test('new followers with a verified phone must actively opt in to texts', async () => {
  const fixture = followDialogFixture({ following: false, emailOn: false, textOn: false }, [followEmailIdentity, followPhoneIdentity]);
  await fixture.flow.open();
  assert.equal(fixture.channel('email'), true);
  assert.equal(fixture.channel('text'), false);
  assert.equal(fixture.focus(), 'email');
  assert.ok(fixture.requests.every(request => request.method === 'GET'));
  await fixture.save();
  assert.deepEqual(fixture.requests.at(-1), {
    method: 'PATCH', url: '/api/hosts/test-host/follow',
    data: { email: true, text: false, sourceEventSlug: 'test-show' }
  });
});

test('only an event Follow transmits its rendered attribution marker', async () => {
  const state = { following: false, emailOn: false, textOn: false };
  const marker = 'e'.repeat(64);
  const fromEvent = followDialogFixture(state, [followEmailIdentity], {
    sourceEventSlug: 'test-show', sourceAttribution: marker
  });
  await fromEvent.flow.open();
  await fromEvent.save();
  assert.deepEqual(fromEvent.requests.at(-1).data, {
    email: true, text: false, sourceEventSlug: 'test-show', sourceAttribution: marker
  });

  const fromHostPage = followDialogFixture(state, [followEmailIdentity], {});
  await fromHostPage.flow.open();
  await fromHostPage.save();
  assert.deepEqual(fromHostPage.requests.at(-1).data, { email: true, text: false });
});

test('existing followers keep their saved channels instead of new-follower defaults', async () => {
  const fixture = followDialogFixture({ following: true, emailOn: false, textOn: true }, [followEmailIdentity, followPhoneIdentity]);
  await fixture.flow.open();
  assert.equal(fixture.channel('email'), false);
  assert.equal(fixture.channel('text'), true);
  assert.ok(fixture.requests.every(request => request.method === 'GET'));
});

test('new phone-only followers may choose a channel without a false unfollow prompt', async () => {
  const fixture = followDialogFixture({ following: false, emailOn: false, textOn: false }, [followPhoneIdentity]);
  await fixture.flow.open();
  assert.equal(fixture.channel('email'), false);
  assert.equal(fixture.channel('text'), false);
  await fixture.save();
  assert.match(fixture.error(), /Choose email or text notifications/);
  assert.ok(fixture.requests.every(request => request.method === 'GET'));
});

test('Following is a lightweight authenticated list in the shared navigation', () => {
  const view = source('src/views/following.html');
  const nav = source('public/js/api.js');
  const routes = source('src/routes/follows.js');
  const customerNav = nav.slice(nav.indexOf('function renderNav(active)'), nav.indexOf('async function sgExitAdminEditorWorkspace'));
  assert.match(customerNav, /\['following', '\/following', 'Following'\]/);
  assert.match(view, /renderNav\('following'\)/);
  assert.match(view, /You’re not following anyone yet\./);
  assert.match(view, /Follow people and places you like\. They’ll show up here\./);
  assert.match(view, /upcoming.*show/);
  assert.match(view, /id="following-list" aria-busy="true"/);
  assert.equal((view.match(/following-card following-card-skeleton/g) || []).length, 2);
  assert.match(view, /list\.setAttribute\('aria-busy', 'false'\)/);
  assert.doesNotMatch(view, /Create Event/);
  assert.match(routes, /e\.status='published' AND e\.visibility='public'/);
  assert.match(routes, /eventEndAtSql\('e'\)/);
});

test('new-event updates combine legacy consent and explicit Host follows without changing RSVP', () => {
  const events = source('src/routes/events.js');
  const announcements = source('src/lib/follow-announcement.js');
  const migration = source('src/db/migrations/040_unified_follow_notifications.sql');
  const follows = source('src/lib/host-follows.js');
  assert.match(announcements, /r\.organizer_optin=TRUE/);
  assert.match(announcements, /host_follows/);
  assert.match(announcements, /follower_optouts/);
  assert.match(announcements, /MAX\(r\.created_at\) AS consent_at/);
  assert.match(announcements, /candidate\.consent_at DESC/);
  assert.match(announcements, /createFollowerAnnouncementBatch/);
  assert.match(events, /includeTexts/);
  assert.match(events, /SEND_FOLLOWER_UPDATE/);
  assert.match(migration, /Existing rows are intentionally not backfilled/);
  assert.match(migration, /email_opted_in_at TIMESTAMPTZ/);
  assert.match(migration, /sms_opted_in_at TIMESTAMPTZ/);
  assert.match(follows, /DELETE FROM follower_optouts/);
  assert.match(follows, /INSERT INTO follower_optouts/);
  assert.match(follows, /prepareFollowSmsConsent/);
});

test('settings share the public page before asking visitors to follow', () => {
  const view = source('src/views/settings-v2.html');
  const browser = source('public/js/settings.js');
  assert.match(view, /Share your public page/);
  assert.match(view, /Let people see your events and follow when they’re ready\./);
  assert.match(browser, /\/h\/\$\{encodeURIComponent\(organizer\.public_slug\)\}`/);
  assert.doesNotMatch(browser, /public_slug\)}\?follow=1/);
  assert.match(browser, /Page link copied\./);
  assert.match(browser, /navigator\.share/);
  assert.doesNotMatch(`${view}\n${browser}`, /text-signup|text_signup|signup-for-text/i);
});

test('Follow sharing uses the native mobile sheet and an accessible desktop menu', () => {
  const view = source('src/views/settings-v2.html');
  const browser = source('public/js/settings.js');
  const styles = source('public/css/settings.css');

  assert.match(view, /<dialog class="host-share-dialog" id="host-follow-share-dialog" aria-modal="true" aria-labelledby="host-follow-share-dialog-title">/);
  assert.match(view, /class="host-share-options" role="group" aria-label="Share your public page"/);
  for (const option of ['Email', 'Pinterest', 'Facebook', 'X', 'Copy link']) {
    assert.match(view, new RegExp(`>${option}<`));
  }
  assert.match(browser, /matchMedia\('\(hover: none\) and \(pointer: coarse\)'\)/);
  assert.match(browser, /hostFollowNativeShareMedia\.matches[\s\S]*typeof navigator\.share === 'function'/);
  assert.match(browser, /function openHostFollowShareDialog\(\)/);
  assert.match(browser, /https:\/\/www\.pinterest\.com\/pin\/create\/button/);
  assert.match(browser, /https:\/\/www\.facebook\.com\/sharer\/sharer\.php/);
  assert.match(browser, /https:\/\/twitter\.com\/intent\/tweet/);
  assert.match(browser, /document\.execCommand\('copy'\)/);
  assert.match(browser, /window\.requestAnimationFrame\(\(\) => \{[\s\S]*host-follow-share-url'[\s\S]*\.select\(\)/);
  assert.match(browser, /event\.target !== hostFollowShareDialog/);
  assert.match(browser, /event\.key !== 'Escape' \|\| !hostFollowShareDialog\.open/);
  assert.match(browser, /hostFollowShareReturnFocus\?\.focus\(\)/);
  assert.doesNotMatch(browser, /Sharing is unavailable/);
  assert.match(styles, /\.host-share-dialog::backdrop/);
  assert.match(styles, /\.host-share-dialog\[open\] \{ display:flex;flex-direction:column; \}/);
  assert.match(styles, /\.host-share-options \{ min-height:0;overflow-y:auto;/);
  assert.match(styles, /\.host-share-option \{[\s\S]*min-height:72px/);
});

test('follower texts reuse paid batches and STOP disables both RSVP and Follow consent', () => {
  const migration = source('src/db/migrations/040_unified_follow_notifications.sql');
  const job = source('src/jobs/sms-notifications.js');
  const webhook = source('src/routes/sms-notifications.js');
  assert.match(migration, /follower_announcement/);
  assert.match(migration, /host_follow_id BIGINT REFERENCES host_follows/);
  assert.match(job, /batch\.kind === 'follower_announcement'/);
  assert.match(job, /sms_opted_out_at=COALESCE/);
  assert.match(webhook, /UPDATE host_follows SET sms_opted_out_at/);
});
