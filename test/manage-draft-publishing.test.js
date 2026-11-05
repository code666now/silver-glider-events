const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '../public/js/manage.js'), 'utf8');
const view = fs.readFileSync(path.join(__dirname, '../src/views/event-manage.html'), 'utf8');

function harness({ publish, mobile = false } = {}) {
  const nodes = new Map();
  const calls = [];
  const navigations = [];
  let activeElement;
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
      removeAttribute(name) { attributes.delete(name); },
      hasAttribute(name) { return attributes.has(name); },
      querySelector(selector) { return node(`${id} ${selector}`); },
      querySelectorAll() { return []; },
      insertAdjacentHTML() {}, replaceChildren() {}, append() {},
      focus() { activeElement = id; },
      showModal() { this.open = true; },
      close() { this.open = false; listeners.get('close')?.(); },
      click() { return listeners.get('click')?.({ target: this }); },
      fire(name, event = {}) { return listeners.get(name)?.({ preventDefault() {}, ...event }); }
    };
    nodes.set(id, element);
    return element;
  }
  const location = { pathname: '/events/64/manage', search: '', origin: 'http://localhost', href: 'http://localhost/events/64/manage', assign(url) { navigations.push(url); }, replace(url) { navigations.push(url); } };
  const context = vm.createContext({
    URL, URLSearchParams, Map, Set, Number, String, Date, Promise, console,
    document: { getElementById: node, querySelectorAll() { return []; }, addEventListener() {}, body: { classList: { toggle() {} } } },
    window: { location, matchMedia(query) { return { matches: query.includes('max-width') ? mobile : !mobile, addEventListener() {} }; }, setInterval() {}, SgeEventLifecycle: { isPostEventEligible() { return false; }, variantFor() { return 'new-event'; } } },
    location, history: { state: null }, renderNav() {}, toast() {}, sgSafeHttpUrl() { return ''; }, setTimeout, clearTimeout,
    navigator: { clipboard: { async writeText() { throw new Error('Unexpected clipboard access'); } } },
    api: async (url, options) => { calls.push({ url, options }); return publish?.(url, options); }
  });
  vm.runInContext(client.replace('\ninitializeMobileManage();\ninitializeManagePage();', ''), context);
  vm.runInContext(`eventData = { id:64, title:'Draft party', status:'draft', slug:'draft-party', visibility:'public' };`, context);
  return { node, calls, navigations, context, run: source => vm.runInContext(source, context), active: () => activeElement };
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
  finish({ event: { id: 64, status: 'published' } });
  await pending;
  assert.deepEqual(h.navigations, ['/events/64/manage?created=1']);
  assert.match(client, /window\.location\.replace\(`\/events\/\$\{encodeURIComponent\(eventId\)\}\/manage\?created=1`\)/);
  assert.equal(h.calls.length, 1, 'publishing never sends invitations or follower announcements');
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
  assert.match(view, /Publishing does not send invitations or notify followers/);
  assert.match(client, /data\.canBrowsePastGuests \|\| data\.canInvite/);
  assert.match(client, /eventData\.status === 'cancelled' \|\| eventData\.status === 'draft'/);
});

test('same-day drafts still load past guests and filtered empty states stay truthful', async () => {
  const h = harness();
  h.run(`peopleState = {canBrowsePastGuests:true,canInvite:false,people:[],plusOnes:[],groups:[]}; peopleGroup = 'regulars'; renderPeople();`);
  assert.equal(h.node('familiar-people-empty').textContent, 'No past guests match this filter.');
  h.run(`peopleGroup = 'all'; $('familiar-people-source').value = '4'; renderPeople();`);
  assert.equal(h.node('familiar-people-empty').textContent, 'No past guests match this filter.');
  const initialization = client.slice(client.indexOf('async function initializeManagePage()'), client.indexOf('\ninitializeMobileManage();'));
  assert.match(initialization, /eventData\.status === 'published' && eventData\.lifecycle_phase === 'tonight'\s*\? \[\]\s*:\s*\[loadLineStatus\(\), loadPeople\(\), loadFollowers\(\), loadSmsPreview\(\)\]/);
  assert.doesNotMatch(initialization, /:\s*eventData\.lifecycle_phase === 'tonight'/);
});
