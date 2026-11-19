const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const eventLifecycle = require('../public/js/event-lifecycle');

const client = fs.readFileSync(path.join(__dirname, '../public/js/manage.js'), 'utf8');
const view = fs.readFileSync(path.join(__dirname, '../src/views/event-manage.html'), 'utf8');

function harness({ publish, mobile = false, browserNavigator } = {}) {
  const nodes = new Map();
  const calls = [];
  const navigations = [];
  let activeElement;
  const confirmations = [];
  const timers = new Map();
  let timerId = 0;
  function node(id) {
    if (nodes.has(id)) return nodes.get(id);
    const listeners = new Map();
    const attributes = new Map();
    const element = {
      id, hidden: false, disabled: false, textContent: '', innerHTML: '', value: '',
      open: false, style: {}, dataset: {}, options: [{}], isConnected: true,
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener(name, callback) { listeners.set(name, callback); },
      setAttribute(name, value) { attributes.set(name, value); },
      getAttribute(name) { return attributes.get(name); },
      removeAttribute(name) { attributes.delete(name); },
      hasAttribute(name) { return attributes.has(name); },
      contains() { return false; },
      querySelector(selector) { return node(`${id} ${selector}`); },
      querySelectorAll() { return []; },
      insertAdjacentHTML() {}, replaceChildren() {}, append() {},
      focus() { activeElement = id; },
      showModal() { this.open = true; },
      close() { this.open = false; listeners.get('close')?.(); },
      click() { if (!this.disabled) return listeners.get('click')?.({ target: this }); },
      fire(name, event = {}) { return listeners.get(name)?.({ preventDefault() {}, ...event }); }
    };
    nodes.set(id, element);
    return element;
  }
  const location = { pathname: '/events/64/manage', search: '', origin: 'http://localhost', href: 'http://localhost/events/64/manage', assign(url) { navigations.push(url); }, replace(url) { navigations.push(url); } };
  const context = vm.createContext({
    URL, URLSearchParams, Map, Set, Number, String, Date, Promise, console,
    document: { getElementById: node, querySelectorAll() { return []; }, addEventListener() {}, body: { classList: { toggle() {} } }, visibilityState: 'visible', get activeElement() { return node(activeElement); } },
    window: { location, matchMedia(query) { return { matches: query.includes('max-width') ? mobile : !mobile, addEventListener() {} }; }, setInterval() {}, SgeEventLifecycle: eventLifecycle },
    location, history: { state: null }, renderNav() {}, toast() {}, sgSafeHttpUrl() { return ''; },
    confirm(message) { confirmations.push(message); return true; },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    navigator: browserNavigator || { clipboard: { async writeText() { throw new Error('Unexpected clipboard access'); } } },
    api: async (url, options) => { calls.push({ url, options }); return publish?.(url, options); }
  });
  vm.runInContext(client.replace('\ninitializeMobileManage();\ninitializeManagePage();', ''), context);
  vm.runInContext(`eventData = { id:64, title:'Draft party', status:'draft', slug:'draft-party', visibility:'public' };`, context);
  return { node, calls, navigations, confirmations, timers, context, run: source => vm.runInContext(source, context), active: () => activeElement };
}

test('draft Manage offers publishing on desktop and phones without sharing an unavailable link', () => {
  for (const mobile of [false, true]) {
    const h = harness({ mobile });
    h.run('syncPublicationActions(); syncMobileManageAvailability();');
    assert.equal(h.node('publish-event').hidden, false);
    assert.equal(h.node('manage-mobile-publish').hidden, false);
    assert.equal(h.node('view-link').textContent, 'Preview');
    assert.equal(h.node('copy-link').hidden, true);
    assert.equal(h.node('manage-mobile-share').hidden, true);
    assert.equal(h.node('download-qr').disabled, true);
    h.node(mobile ? 'manage-mobile-publish' : 'publish-event').click();
    assert.equal(h.node('publish-event-dialog').open, true);
    assert.equal(h.node('publish-event-name').textContent, 'Draft party');
    assert.equal(h.calls.length, 0);
    h.node('publish-event-cancel').click();
    assert.equal(h.node('publish-event-dialog').open, false);
    assert.equal(h.active(), mobile ? 'manage-mobile-publish' : 'publish-event');
    assert.equal(h.calls.length, 0);
  }
});

test('publishing needs explicit confirmation, suppresses repeat requests, and reuses the existing success route', async () => {
  let finish;
  const h = harness({ publish: () => new Promise(resolve => { finish = resolve; }) });
  await h.node('publish-event-form').fire('submit');
  assert.equal(h.calls.length, 0, 'closed dialogs cannot publish');
  h.node('publish-event').click();
  const pending = h.node('publish-event-form').fire('submit');
  assert.equal(h.node('publish-event-confirm').disabled, true);
  assert.equal(h.node('publish-event-confirm').textContent, 'Publishing…');
  await h.node('publish-event-form').fire('submit');
  h.node('publish-event-cancel').click();
  assert.equal(h.node('publish-event-dialog').open, true);
  let cancelPrevented = false;
  h.node('publish-event-dialog').fire('cancel', { preventDefault() { cancelPrevented = true; } });
  assert.equal(cancelPrevented, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, '/api/events/64/publish');
  assert.equal(h.calls[0].options.method, 'POST');
  assert.equal(h.calls[0].options.body.skip_follower_email, true, 'unverified preferences do not allow unreviewed email');
  finish({ event: { id: 64, status: 'published' } });
  await pending;
  assert.deepEqual(h.navigations, ['/events/64/manage?created=1']);
  assert.match(client, /window\.location\.replace\(`\/events\/\$\{encodeURIComponent\(eventId\)\}\/manage\?created=1`\)/);
  assert.equal(h.calls.length, 1, 'publishing does not call a second delivery endpoint');
});

test('publication validation errors retain the draft, expose editing, and restore dialog controls', async () => {
  const h = harness({ publish: async () => { throw new Error('Upload a flyer before publishing the Flyer layout'); } });
  h.node('publish-event').click();
  await h.node('publish-event-form').fire('submit');
  assert.equal(h.node('publish-event-dialog').open, true);
  assert.equal(h.node('publish-event-error').hidden, false);
  assert.match(h.node('publish-event-error').textContent, /Upload a flyer/);
  assert.equal(h.node('publish-event-edit').href, '/events/64/edit');
  assert.equal(h.node('publish-event-edit').hidden, false);
  assert.equal(h.node('publish-event-confirm').disabled, false);
  assert.equal(h.node('publish-event-cancel').disabled, false);
  assert.equal(h.active(), 'publish-event-error');
  assert.equal(h.navigations.length, 0);
  assert.equal(h.run('eventData.status'), 'draft');
});

test('published Manage switches to sharing and never reopens publication', () => {
  const h = harness();
  h.run(`eventData.status = 'published'; syncPublicationActions(); syncMobileManageAvailability();`);
  assert.equal(h.node('publish-event').hidden, true);
  assert.equal(h.node('manage-mobile-publish').hidden, true);
  assert.equal(h.node('copy-link').hidden, false);
  assert.equal(h.node('share-event').disabled, false);
  assert.equal(h.node('view-link').textContent, 'View page');
  h.node('publish-event').click();
  assert.equal(h.node('publish-event-dialog').open, false);
});

test('publication review shows saved local time and the actual visibility boundary', () => {
  const h = harness();
  h.run(`eventData.start_time = '20:37:00'; eventData.timezone = 'America/Los_Angeles'; eventData.visibility = 'private';`);
  h.node('meta').textContent = 'Friday, February 12, 2027 · The venue';
  h.node('publish-event').click();
  assert.match(h.node('publish-event-details').textContent, /8:37 PM · America\/Los Angeles/);
  assert.match(h.node('publish-event-visibility').textContent, /Private — Link Only/);
  h.node('publish-event-cancel').click();
  h.run('eventData.secret_show_enabled = true;');
  h.node('publish-event').click();
  assert.match(h.node('publish-event-visibility').textContent, /need your access code/);
  assert.equal(h.calls.length, 0);
});

test('an unconfirmed publish response never invents a successful publication', async () => {
  const h = harness({ publish: async () => ({ ok: true }) });
  h.node('publish-event').click();
  await h.node('publish-event-form').fire('submit');
  assert.match(h.node('publish-event-error').textContent, /Publication could not be confirmed/);
  assert.equal(h.navigations.length, 0);
  assert.equal(h.run('eventData.status'), 'draft');
});

test('active follower email is disclosed before only public non-Secret publishes', async () => {
  for (const { visibility, secret, available, enabled, optedOut, eligible } of [
    { visibility: 'public', available: true, enabled: true, optedOut: false, eligible: true },
    { visibility: 'public', available: true, enabled: true, optedOut: true, eligible: true },
    { visibility: 'private', available: true, enabled: true },
    { visibility: 'public', secret: true, available: true, enabled: true },
    { visibility: 'public', available: true, enabled: false },
    { visibility: 'public', available: false, enabled: true }
  ]) {
    const h = harness({ publish: async url => url === '/api/settings/follower-email'
      ? { available, enabled }
      : { event: { id: 64, status: 'published' } } });
    h.run(`Object.assign(eventData, { visibility: '${visibility}', secret_show_enabled: ${Boolean(secret)} });`);
    await h.run('loadPublishFollowerEmailPreference()');
    h.node('publish-event').click();
    assert.equal(h.node('publish-follower-email-option').hidden, !eligible);
    assert.match(h.node('publish-event-copy').textContent, eligible ? /schedule an email to followers who chose email updates/ : /won’t email followers/);
    h.node('publish-skip-follower-email').checked = Boolean(optedOut);
    await h.node('publish-event-form').fire('submit');
    assert.equal(h.calls.at(-1).options.body.skip_follower_email, !eligible || Boolean(optedOut));
  }
});

test('automatic email status advances through server counts, polls only while active and accepts Send now', async () => {
  let status = 'pending';
  const h = harness({ publish: async (url, options) => {
    if (url.endsWith('/automatic-follower-email')) {
      assert.equal(options.body.action, 'send_now');
      status = 'reserved';
      return { ok: true };
    }
    return { automaticEmail: { status, scheduledAt: '2026-12-19T23:05:00Z', eligibleCount: 5, pendingCount: 3, sentCount: status === 'complete' ? 4 : 0, failedCount: 1 }, count: 0 };
  } });
  h.run(`eventData.status = 'published';`);
  await h.run('loadFollowers()');
  assert.equal(h.node('automatic-follower-email').hidden, false);
  assert.match(h.node('automatic-follower-email-status').textContent, /Scheduled to email 5 at /);
  assert.equal(h.node('automatic-follower-email-actions').hidden, false);
  assert.equal(h.timers.size, 1);
  h.node('automatic-follower-email-send').focus();
  await h.node('automatic-follower-email-send').click();
  assert.equal(h.node('automatic-follower-email-status').textContent, 'Sending to 3…');
  assert.equal(h.node('automatic-follower-email-actions').hidden, true);
  assert.equal(h.active(), 'automatic-follower-email-status');
  status = 'complete';
  await [...h.timers.values()][0].callback();
  assert.equal(h.node('automatic-follower-email-status').textContent, '4 emails sent · 1 not confirmed');
  assert.equal(h.timers.size, 0);
});

test('automatic email cancellation remains recoverable after a request error and honors confirmed skip', async () => {
  let status = 'pending';
  const h = harness({ publish: async (url, options) => {
    if (url.endsWith('/automatic-follower-email')) {
      assert.equal(options.body.action, 'cancel');
      if (h.calls.length === 2) throw new Error('Connection failed.');
      status = 'skipped';
      return { ok: true };
    }
    return { automaticEmail: { status, scheduledAt: '2026-12-19T23:05:00Z', eligibleCount: 2, sentCount: 0 }, count: 0 };
  } });
  h.run(`eventData.status = 'published';`);
  await h.run('loadFollowers()');
  await h.node('automatic-follower-email-cancel').click();
  assert.equal(h.node('automatic-follower-email-error').textContent, 'Connection failed.');
  assert.equal(h.node('automatic-follower-email-error').hidden, false);
  assert.equal(h.node('automatic-follower-email-cancel').disabled, false);
  await h.node('automatic-follower-email-cancel').click();
  assert.equal(h.node('automatic-follower-email-actions').hidden, true);
  assert.equal(h.node('automatic-follower-email-error').hidden, true);
  assert.equal(h.node('automatic-follower-email-status').textContent, 'No automatic follower email was sent.');
});

test('manual follower SMS remains available to eligible recipients after automatic email', async () => {
  const followerPreview = { automaticEmail: { status: 'complete', sentCount: 5 }, canAnnounce: true, count: 2, emailCount: 0, textCount: 2, textBalance: 6, textCreditCost: 2, canIncludeTexts: true };
  const h = harness({ publish: async url => {
    if (!url.endsWith('/announce')) return followerPreview;
    Object.assign(followerPreview, { announcedAt: '2026-12-19T23:11:00Z', announcedCount: 0, announcedTextCount: 2 });
    return { sent: 0, textsQueued: 2 };
  } });
  h.run(`eventData.status = 'published';`);
  await h.run('loadFollowers()');
  assert.equal(h.node('announce-title').textContent, 'Text 2 followers');
  assert.doesNotMatch(h.node('announce-copy').textContent, /emails/i);
  await h.node('announce').click();
  assert.match(h.confirmations[0], /2 followers as 2 texts/);
  assert.doesNotMatch(h.confirmations[0], /emails/i);
  assert.equal(h.calls.find(call => call.url.endsWith('/announce')).options.body.includeTexts, true);
  assert.equal(h.node('announce-copy').textContent, '2 texts queued');
  assert.equal(h.node('automatic-follower-email-status').textContent, '5 emails sent');
});

test('deferred emails show remaining recipients and cannot be accelerated', async () => {
  const h = harness({ publish: async () => ({ count: 0, automaticEmail: { status: 'pending', scheduledAt: '2026-12-20T03:00:00Z', eligibleCount: 9, pendingCount: 7, sentCount: 2, canSendNow: false } }) });
  h.run(`eventData.status = 'published';`);
  await h.run('loadFollowers()');
  assert.match(h.node('automatic-follower-email-status').textContent, /Scheduled to email 7 at .+ · 2 emails sent/);
  assert.equal(h.node('automatic-follower-email-send').hidden, true);
  assert.equal(h.node('automatic-follower-email-cancel').textContent, 'Stop remaining emails');
  await h.node('automatic-follower-email-send').click();
  assert.equal(h.calls.length, 1);
});

test('past guests are read-only while drafting, then become selectable only after publication', async () => {
  const h = harness();
  h.run(`peopleState = {canBrowsePastGuests:true, canInvite:false, people:[{id:'rsvp:1',name:'Past guest',detail:'Halloween',fallbackEmoji:'🎉'}], plusOnes:[{name:'Friend', detail:'Past guest’s +1',fallbackEmoji:'🎉'}], groups:[{key:'all',count:1,label:'Everyone'}]}; renderPeople();`);
  assert.match(h.node('familiar-people-grid').innerHTML, /<article/);
  assert.doesNotMatch(h.node('familiar-people-grid').innerHTML, /<button|data-person=|data-share-person=/);
  assert.equal(h.node('familiar-people-title').textContent, 'People from your past events');
  assert.match(h.node('familiar-people-intro').textContent, /not RSVPs for this event/);
  assert.equal(h.node('familiar-people-bulk').hidden, true);
  assert.equal(h.node('familiar-people-bar').hidden, true);
  h.node('familiar-people-bulk-btn').click();
  await h.node('familiar-people-send').click();
  assert.equal(h.calls.length, 0);
  h.run(`eventData.status = 'published'; peopleState.canInvite = true; renderPeople();`);
  assert.match(h.node('familiar-people-grid').innerHTML, /<button[^>]+data-person=/);
  assert.match(h.node('familiar-people-grid').innerHTML, /data-share-person=/);
  assert.equal(h.node('familiar-people-bulk').hidden, false);
  assert.equal(h.calls.length, 0);
});

test('publication review and hidden controls keep explicit accessible semantics', () => {
  assert.match(view, /<dialog class="publish-event-dialog"[^>]+aria-labelledby="publish-event-title"[^>]+aria-describedby="publish-event-copy"/);
  assert.match(view, /\.publish-event-dialog:not\(\[open\]\),\.publish-event-dialog \[hidden\] \{ display:none !important; \}/);
  assert.match(view, /id="publish-skip-follower-email" type="checkbox" aria-describedby="publish-event-copy"/);
  assert.match(client, /!data\.canInvite && \(!\(data\.canBrowsePastGuests\)/);
  assert.match(client, /eventData\.status === 'cancelled' \|\| eventData\.status === 'draft'/);
});

test('same-day drafts still load past guests and filtered empty states stay truthful', async () => {
  const h = harness();
  h.run(`peopleState = {canBrowsePastGuests:true,canInvite:false,people:[],plusOnes:[],groups:[]}; peopleGroup = 'regulars'; renderPeople();`);
  assert.equal(h.node('familiar-people-empty').textContent, 'No past guests match this filter.');
  h.run(`peopleGroup = 'all'; $('familiar-people-source').value = '4'; renderPeople();`);
  assert.equal(h.node('familiar-people-empty').textContent, 'No past guests match this filter.');
  const initialization = client.slice(client.indexOf('async function initializeManagePage()'), client.indexOf('\ninitializeMobileManage();'));
  assert.match(initialization, /eventData\.status === 'published' && eventData\.lifecycle_phase === 'tonight'\s*\? \[loadPeople\(\), loadContacts\(\), loadFollowers\(\)\]\s*:\s*\[loadLineStatus\(\), loadPeople\(\), loadFollowers\(\), loadSmsPreview\(\), loadContacts\(\)\]/);
  assert.doesNotMatch(initialization, /:\s*eventData\.lifecycle_phase === 'tonight'/);
});

const emptyFaces = { faces: [], totalCount: 0, selectableCount: 0 };

test('empty Familiar Faces reuses native sharing or desktop clipboard without sending anything', async () => {
  assert.match(view, /id="familiar-faces-empty-state" hidden>[\s\S]*?<img[^>]+music-notes\.png[^>]+alt=""/);
  assert.match(view, /id="no-guests" role="status"/);
  for (const mobile of [false, true]) {
    const shared = [];
    const browserNavigator = mobile
      ? { share: async ({ url }) => shared.push(url) }
      : { clipboard: { writeText: async url => shared.push(url) } };
    const h = harness({ mobile, browserNavigator, publish: async () => emptyFaces });
    h.run("eventData.status = 'published'; eventData.visibility = 'private'; syncPublicationActions();");
    await h.run('loadGuests()');
    assert.equal(h.node('familiar-faces-empty-state').hidden, false);
    assert.equal(h.node('familiar-faces-empty-share').hidden, false);
    h.node('familiar-faces-empty-share').click();
    assert.deepEqual(shared, ['http://localhost/e/draft-party']);
    assert.deepEqual(h.calls, [{ url: '/api/events/64/familiar-faces', options: undefined }]);
    assert.deepEqual(h.navigations, []);
  }
});

test('draft, hidden, cancelled and ended events do not gain a share action in the empty state', async () => {
  for (const [status, ended] of [['draft', false], ['hidden', false], ['cancelled', false], ['published', true]]) {
    const h = harness({ publish: async () => emptyFaces });
    h.run(`eventData.status = '${status}'; eventData.post_event_ended = ${ended}; syncPublicationActions();`);
    await h.run('loadGuests()');
    assert.equal(h.node('familiar-faces-empty-state').hidden, false, status);
    assert.equal(h.node('familiar-faces-empty-share').hidden, true, status);
    assert.doesNotMatch(h.node('familiar-faces-empty-copy').textContent, /first RSVPs/);
  }
});

test('Familiar Faces separates loading, populated results, search misses and failures from a true empty list', async () => {
  let finish;
  let fail;
  const h = harness({ publish: () => new Promise((resolve, reject) => { finish = resolve; fail = reject; }) });
  h.run("eventData.status = 'published'; syncPublicationActions();");
  const initial = h.run('loadGuests()');
  assert.equal(h.node('manage-guest-section').getAttribute('aria-busy'), 'true');
  assert.equal(h.node('familiar-faces-empty-state').hidden, true);
  finish({ ...emptyFaces, totalCount: 1, faces: [{ id: 'rsvp:1', name: 'Test guest', group: 'going' }] });
  await initial;
  assert.equal(h.node('familiar-faces-empty-state').hidden, true);
  assert.match(h.node('familiar-faces-grid').innerHTML, /Test guest/);

  const filtered = h.run("loadGuests('missing name')");
  finish(emptyFaces);
  await filtered;
  assert.equal(h.node('familiar-faces-empty-state').hidden, true);
  assert.equal(h.node('familiar-faces-empty-share').hidden, true);
  assert.equal(h.node('no-guests').textContent, 'No people match that search.');

  const failed = h.run('loadGuests()');
  fail(new Error('fixture failure'));
  await failed;
  assert.equal(h.node('familiar-faces-empty-state').hidden, true);
  assert.match(h.node('no-guests').textContent, /Could not load Familiar Faces/i);
  assert.equal(h.node('manage-guest-section').getAttribute('aria-busy'), 'false');
});

test('a stale unfiltered Familiar Faces response cannot replace more recent search feedback', async () => {
  const replies = [];
  const h = harness({ publish: () => new Promise(resolve => replies.push(resolve)) });
  h.run("eventData.status = 'published'; syncPublicationActions();");
  const initial = h.run('loadGuests()');
  const query = h.run("loadGuests('missing')");
  replies[1](emptyFaces);
  await query;
  replies[0](emptyFaces);
  await initial;
  assert.equal(h.node('no-guests').textContent, 'No people match that search.');
  assert.equal(h.node('familiar-faces-empty-state').hidden, true);
  assert.equal(h.node('manage-guest-section').getAttribute('aria-busy'), 'false');
});
