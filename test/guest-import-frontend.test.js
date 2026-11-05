const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const parser = require('../public/js/guest-list-parser');

const script = fs.readFileSync(path.join(__dirname, '../public/js/guest-import.js'), 'utf8');
const view = fs.readFileSync(path.join(__dirname, '../src/views/event-manage.html'), 'utf8');
const manage = fs.readFileSync(path.join(__dirname, '../public/js/manage.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/css/guest-import.css'), 'utf8');

function harness(handler) {
  const nodes = new Map();
  const calls = [];
  const timers = [];
  let active = null;
  let past = 0;
  let queued = 0;
  let imported = null;
  const node = id => {
    if (nodes.has(id)) return nodes.get(id);
    const handlers = new Map();
    const attrs = {};
    const el = {
      id, hidden: false, disabled: false, value: '', checked: false, textContent: '', innerHTML: '', srcdoc: '', files: [], open: false,
      dataset: {}, style: {}, scrollTop: 0,
      addEventListener(name, fn) { handlers.set(name, fn); },
      setAttribute(name, value) { attrs[name] = value; },
      getAttribute(name) { return attrs[name]; },
      replaceChildren() { this.textContent = ''; }, append() {},
      focus() { active = id; }, scrollIntoView() {},
      querySelectorAll() { return []; }, querySelector(selector) { return node(`${id}:${selector}`); },
      showModal() { this.open = true; },
      close() { this.open = false; handlers.get('close')?.(); },
      async fire(name, event = {}) { return handlers.get(name)?.({ preventDefault() {}, target: this, ...event }); },
      async click() { return this.fire('click'); }
    };
    nodes.set(id, el); return el;
  };
  const get = suffix => node(`guest-import-${suffix}`);
  const api = async (url, opts) => {
    calls.push({ url, opts });
    if (handler) return handler(url, opts);
    if (url.endsWith('/preview')) return {
      rows: (opts.body.rows || [{ id: '7', source: 'contact', selectionKey: 'shared-key', name: 'Alex', email: 'alex@example.com' }]).map(row => ({ ...row, status: 'ready' })),
      summary: { ready: opts.body.rows?.length || 1 }, previewHtml: '<p>Personal invitation</p>', subject: 'You are invited',
      reviewToken: 'test-review-token', canSend: true, limits: { maxRows: 100, remaining24h: 200 }
    };
    if (url.endsWith('/contacts/import')) return { contacts: [{ id: '7', selectionKey: 'shared-key', name: 'Alex', email: 'alex@example.com', eligible: true }], total: 1, selectedContactIds: ['7'] };
    if (url.endsWith('/send')) return { ok: true, batchId: 9, queued: 1, skipped: 0 };
    return { status: 'completed', queued: 0, accepted: 1, failed: 0, skipped: 0, complete: true };
  };
  const document = { getElementById: node, createElement: () => node('new-link'), createTextNode: value => value, body: { style: { overflow: 'auto' } }, activeElement: node('trigger') };
  const window = { SGGuestListParser: parser };
  vm.runInNewContext(script, { window, document, Promise, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {} });
  const controller = window.SGGuestImport.create({ eventId: 64, api, onPastGuests: () => { past += 1; }, onQueued: () => { queued += 1; }, onImported: result => { imported = result; } });
  const settle = async () => { for (let n = 0; n < 12; n += 1) await Promise.resolve(); };
  const reviewList = async (text = 'Alex <alex@example.com>') => { controller.openImport('paste', node('trigger')); get('text').value = text; await get('next').click(); };
  const reviewInvitations = async () => { controller.openInvitations({ faceIds: [], contactIds: ['7'] }, node('trigger')); await settle(); };
  return { get, calls, controller, node, document, timers, reviewList, reviewInvitations, settle, active: () => active, past: () => past, queued: () => queued, imported: () => imported };
}

test('guest import lives inside Contacts alongside the unchanged Familiar Faces panel', async () => {
  const h = harness(); h.controller.openImport('paste', h.node('trigger'));
  assert.equal(h.get('dialog').open, true);
  assert.equal(h.get('input').hidden, false);
  assert.equal(h.get('foot').hidden, false);
  assert.equal(h.calls.length, 0);
  await h.get('back').click();
  assert.equal(h.get('dialog').open, false);
  assert.equal(h.active(), 'trigger');
  assert.equal(h.document.body.style.overflow, 'auto');
  assert.match(view, /id="people-tab-familiar"[\s\S]*id="people-tab-contacts"/);
  assert.match(view, /id="people-panel-contacts"[\s\S]*id="people-contacts-csv"[\s\S]*id="people-contacts-paste"/);
  assert.match(manage, /const available = eventData\?\.status === 'published' && !eventData\.is_past/);
  assert.match(manage, /guestImport\?\.openImport/);
});

test('paste and reviewed import save contacts without sending and return eligible selection', async () => {
  const h = harness(); await h.reviewList();
  assert.equal(h.get('review').hidden, false);
  assert.match(h.get('summary').textContent, /1 ready/);
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls.every(call => call.url.endsWith('/preview')));
  await h.get('next').click();
  assert.ok(h.calls[1].url.endsWith('/contacts/import'));
  assert.deepEqual(h.imported().selectedContactIds, ['7']);
  assert.equal(h.get('dialog').open, false);
  assert.equal(h.calls.filter(call => call.url.endsWith('/send')).length, 0);
});

test('unified email preview requires an unchecked permission confirmation and sends reviewed IDs only', async () => {
  const h = harness(); await h.reviewInvitations();
  await h.get('next').click();
  assert.equal(h.get('preview').hidden, false);
  assert.equal(h.get('email-preview').srcdoc, '<p>Personal invitation</p>');
  assert.equal(h.get('permission').checked, false);
  assert.equal(h.get('next').disabled, true);
  await h.get('next').click();
  assert.equal(h.calls.length, 2, 'forced click cannot skip permission');
  h.get('permission').checked = true;
  await h.get('permission').fire('change');
  assert.equal(h.get('next').disabled, false);
  await h.get('next').click();
  await Promise.resolve();
  assert.equal(h.calls.filter(call => call.url.endsWith('/send')).length, 1);
  const sent = h.calls.find(call => call.url.endsWith('/send')).opts.body;
  assert.equal(sent.rows, undefined);
  assert.equal(sent.contactIds[0], '7');
  assert.equal(h.get('status').hidden, false);
  assert.match(h.get('status-copy').textContent, /1 accepted by the email provider/);
  assert.equal(h.get('next').textContent, 'Invite more guests');
  assert.match(view, /id="guest-import-email-preview"[^>]*sandbox=""/);
  assert.match(view, /Email-provider acceptance is not the same as inbox delivery/);
  assert.match(script, /show\('preview'\);\s*get\('email-preview'\)\.srcdoc = data\.previewHtml/, 'reveal the panel before loading its sandboxed frame so Chrome lays it out');
  assert.match(css, /#people-panel-contacts \[hidden\]/, 'hidden paging and empty states override button display styles');
});

test('contact saving remains available without invitation quota and stale import proof is reviewed again', async () => {
  let saves = 0;
  const h = harness(async (url, opts) => {
    if (url.endsWith('/preview')) return { rows: opts.body.rows.map(row => ({ ...row, status: 'ready' })), summary: { ready: 1, existingContacts: 1 }, reviewToken: 'token', canSend: false, limits: { remaining24h: 0 } };
    saves += 1;
    throw Object.assign(new Error('Review this contact list again.'), { data: { code: 'stale_preview' } });
  });
  await h.reviewList();
  assert.equal(h.get('next').disabled, false);
  assert.match(h.get('summary').textContent, /1 already in Contacts/);
  await h.get('next').click();
  assert.equal(saves, 1);
  assert.equal(h.get('next').textContent, 'Check changes');
  assert.match(h.get('rows').innerHTML, /alex@example\.com/);
  await h.get('next').click();
  assert.equal(saves, 1, 'fresh preview does not silently repeat the save');
  assert.equal(h.calls.filter(call => call.url.endsWith('/send')).length, 0);
});

test('ambiguous send recovery reuses the same immutable review and never silently sends twice', async () => {
  let attempts = 0;
  const h = harness(async (url, opts) => {
    if (url.endsWith('/preview')) return { rows: [{ id: '7', source: 'contact', name: 'Alex', status: 'ready' }], summary: { ready: 1 }, reviewToken: 'same-token', canSend: true, subject: 'Invite', previewHtml: '<p>Preview</p>' };
    if (url.endsWith('/send')) { attempts += 1; if (attempts === 1) throw new Error('Connection interrupted'); return { ok: true, batchId: 2, queued: 1, skipped: 0, alreadyApproved: true }; }
    return { status: 'queued', queued: 1, accepted: 0, failed: 0, skipped: 0, complete: false };
  });
  await h.reviewInvitations(); await h.get('next').click(); h.get('permission').checked = true; await h.get('next').click();
  assert.equal(attempts, 1);
  assert.equal(h.get('check-status').textContent, 'Check submission');
  assert.equal(h.get('next').hidden, true);
  await h.get('back').click(); h.controller.open(h.node('trigger'));
  assert.equal(h.get('status').hidden, false);
  assert.equal(attempts, 1);
  await h.get('check-status').click();
  const sends = h.calls.filter(call => call.url.endsWith('/send'));
  assert.equal(sends.length, 2);
  assert.equal(sends[0].opts.body, sends[1].opts.body);
  assert.equal(sends[1].opts.body.reviewToken, 'same-token');
});

test('stale approval returns to review without losing the list or retaining permission', async () => {
  const h = harness(async (url, opts) => {
    if (url.endsWith('/preview')) return { rows: [{ id: '7', source: 'contact', name: 'Alex', email: 'alex@example.com', status: 'ready' }], summary: { ready: 1 }, reviewToken: 'expired-token', canSend: true, subject: 'Invite', previewHtml: '<p>Preview</p>' };
    throw Object.assign(new Error('Preview expired. Review again.'), { data: { code: 'stale_preview' } });
  });
  await h.reviewInvitations(); await h.get('next').click(); h.get('permission').checked = true; await h.get('next').click();
  assert.equal(h.get('review').hidden, false);
  assert.match(h.get('rows').innerHTML, /alex@example\.com/);
  assert.equal(h.get('permission').checked, false);
  assert.match(h.get('error').textContent, /Preview expired/);
});

test('busy send blocks repeated clicks and dismissal until a confirmed result', async () => {
  let finish;
  const h = harness(async (url, opts) => {
    if (url.endsWith('/preview')) return { rows: [{ id: '7', source: 'contact', name: 'Alex', status: 'ready' }], summary: { ready: 1 }, reviewToken: 'token', canSend: true, subject: 'Invite', previewHtml: '<p>Preview</p>' };
    if (url.endsWith('/send')) return new Promise(resolve => { finish = resolve; });
    return { status: 'complete', queued: 0, accepted: 1, failed: 0, skipped: 0, complete: true };
  });
  await h.reviewInvitations(); await h.get('next').click(); h.get('permission').checked = true;
  const pending = h.get('next').click();
  await h.get('next').click(); await h.get('close').click();
  let prevented = false;
  await h.get('dialog').fire('cancel', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(h.get('dialog').open, true);
  assert.equal(h.calls.filter(call => call.url.endsWith('/send')).length, 1);
  finish({ ok: true, batchId: 3, queued: 1, skipped: 0 }); await pending;
  assert.equal(h.get('close').disabled, false);
});

test('CSV upload remains local and uncertain columns are mapped before server review', async () => {
  const h = harness(); h.controller.openImport('upload');
  h.get('file').files = [{ name: 'guests.csv', size: 80, text: async () => 'Person,Primary,Secondary\nAlex,alex@example.com,other@example.com' }];
  await h.get('file').fire('change');
  assert.equal(h.calls.length, 0);
  await h.get('next').click();
  assert.equal(h.get('mapping').hidden, false);
  assert.equal(h.calls.length, 0);
  h.get('has-header').checked = true; h.get('email-column').value = '1'; h.get('name-column').value = '0';
  await h.get('next').click();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].opts.body.rows[0].email, 'alex@example.com');
  assert.equal(h.calls[0].opts.body.rows[0].name, 'Alex');
  assert.equal(h.get('change-columns').hidden, false);
});

test('invalid replacement files cannot reuse the previous upload and host content is escaped', async () => {
  const h = harness(); h.controller.openImport('upload');
  h.get('file').files = [{ name: 'guests.csv', size: 40, text: async () => 'alex@example.com' }]; await h.get('file').fire('change');
  h.get('file').files = [{ name: 'large.csv', size: 100000, text: async () => '' }]; await h.get('file').fire('change'); await h.get('next').click();
  assert.equal(h.calls.length, 0);
  assert.match(h.get('error').textContent, /valid CSV/);
  await h.get('paste-tab').click(); h.get('text').value = '<img src=x>\talex@example.com'; await h.get('next').click();
  assert.doesNotMatch(h.get('rows').innerHTML, /<img/);
  assert.match(h.get('rows').innerHTML, /&lt;img src=x&gt;/);
  assert.match(css, /@media \(hover:hover\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\.guest-import-row input \{ font-size:16px/);
});

test('empty and oversized lists cannot advance or send', async () => {
  const h = harness(); await h.reviewList('');
  assert.equal(h.calls.length, 0); assert.match(h.get('error').textContent, /at least one/);
  h.get('text').value = Array.from({ length: 101 }, (_, index) => `person${index}@example.com`).join('\n');
  await h.get('next').click(); assert.equal(h.calls.length, 0); assert.match(h.get('error').textContent, /100/);
});
