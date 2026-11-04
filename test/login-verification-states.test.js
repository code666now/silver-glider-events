const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

// Exercise the actual login controller and verification component. This small
// DOM/clock/fetch environment never contacts the app, Twilio, or an email API.
function loginHarness({ phone = false, search = '' } = {}) {
  const html = read('src/views/login.html');
  const elements = new Map();
  const allElements = [];
  const timers = new Map();
  const calls = [];
  const navigations = [];
  let now = 1700000000000;
  let timerId = 0;
  let document;

  class FakeEvent {
    constructor(type, options = {}) { this.type = type; Object.assign(this, options); this.defaultPrevented = false; }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() {}
  }

  class Element {
    constructor(tagName = 'div') {
      allElements.push(this);
      this.tagName = tagName.toUpperCase(); this.nodeName = this.tagName;
      this.attributes = new Map(); this.listeners = new Map(); this.children = [];
      this.dataset = {}; this.style = {}; this.value = ''; this.textContent = '';
      this.hidden = false; this.disabled = false; this.readOnly = false; this.parentNode = null;
      this.ownerDocument = document;
      const classes = new Set();
      this.classList = {
        add: (...values) => values.forEach(value => classes.add(value)),
        remove: (...values) => values.forEach(value => classes.delete(value)),
        contains: value => classes.has(value),
        toggle(value, force) { const next = force == null ? !classes.has(value) : Boolean(force); if (next) classes.add(value); else classes.delete(value); return next; }
      };
      Object.defineProperty(this, 'className', {
        get: () => [...classes].join(' '), set: value => { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach(part => classes.add(part)); }
      });
    }
    setAttribute(name, value = '') {
      const text = String(value); this.attributes.set(name, text);
      if (name === 'id') { this.id = text; elements.set(text, this); }
      if (name === 'class') this.className = text;
      if (name === 'hidden') this.hidden = true;
      if (name === 'disabled') this.disabled = true;
      if (name === 'readonly') this.readOnly = true;
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = text;
    }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) {
      this.attributes.delete(name); if (name === 'disabled') this.disabled = false;
      if (name === 'readonly') this.readOnly = false; if (name === 'hidden') this.hidden = false;
    }
    toggleAttribute(name, force) { const next = force == null ? !this.hasAttribute(name) : Boolean(force); if (next) this.setAttribute(name, ''); else this.removeAttribute(name); return next; }
    append(...nodes) { for (const node of nodes) this.appendChild(node); }
    appendChild(node) { if (typeof node === 'string') return node; node.parentNode = this; this.children.push(node); return node; }
    replaceChildren(...nodes) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.append(...nodes); }
    insertBefore(node, reference) { const index = this.children.indexOf(reference); node.parentNode = this; if (index < 0) this.children.push(node); else this.children.splice(index, 0, node); return node; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
    removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== listener)); }
    dispatchEvent(event) {
      event.target ||= this; event.currentTarget = this;
      for (const listener of this.listeners.get(event.type) || []) listener(event);
      if (event.bubbles) document.dispatchEvent(event);
      return !event.defaultPrevented;
    }
    focus() { document.activeElement = this; }
    select() { this.selected = true; this.focus(); }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    reportValidity() { return true; }
    checkValidity() { return true; }
    matches(selector) {
      if (selector.startsWith('#')) return this.id === selector.slice(1);
      if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
      const attribute = selector.match(/^\[([^=\]]+)(?:="?([^"\]]+)"?)?\]$/);
      if (attribute) return this.hasAttribute(attribute[1]) && (attribute[2] == null || this.getAttribute(attribute[1]) === attribute[2]);
      return this.tagName.toLowerCase() === selector;
    }
    querySelectorAll(selector) {
      const found = [];
      const visit = node => { for (const child of node.children) { if (selector.split(',').some(part => child.matches(part.trim()))) found.push(child); visit(child); } };
      visit(this); return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    get childElementCount() { return this.children.length; }
    get childNodes() { return this.children; }
    get firstElementChild() { return this.children[0] || null; }
    get isConnected() { return Boolean(this.parentNode || this === document.body); }
  }

  const documentListeners = new Map();
  document = {
    readyState: 'complete', activeElement: null,
    createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }),
    getElementById: id => elements.get(id) || null,
    querySelectorAll(selector) { return allElements.filter(element => selector.split(',').some(part => element.matches(part.trim()))); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    addEventListener(type, listener) { if (!documentListeners.has(type)) documentListeners.set(type, []); documentListeners.get(type).push(listener); },
    removeEventListener() {},
    dispatchEvent(event) { for (const listener of documentListeners.get(event.type) || []) listener(event); }
  };
  document.body = new Element('body');
  document.documentElement = new Element('html');
  const stack = [document.body];
  const markup = html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
  for (const match of markup.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const [, close, tag, attrs] = match;
    if (close) { if (stack.length > 1) stack.pop(); continue; }
    if (['html', 'head', 'body'].includes(tag.toLowerCase())) continue;
    const element = new Element(tag);
    for (const attr of attrs.matchAll(/([a-z_:][\w:.-]*)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gi)) {
      element.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    const after = markup.slice(match.index + match[0].length);
    element.textContent = (after.match(/^([^<]*)/)?.[1] || '').trim();
    stack[stack.length - 1].appendChild(element);
    if (!['meta', 'link', 'input', 'br', 'hr', 'img', 'source', 'wbr'].includes(tag.toLowerCase())) stack.push(element);
  }

  const location = { origin: 'https://silvergliderevents.com', search, pathname: '/login' };
  let href = `${location.origin}/login${search}`;
  Object.defineProperty(location, 'href', { get: () => href, set: value => { href = String(value); navigations.push(href); } });
  location.assign = value => { location.href = value; };
  location.replace = value => { location.href = value; };
  const schedule = (callback, delay = 0, interval = false) => {
    const id = ++timerId; timers.set(id, { callback, due: now + Math.max(0, Number(delay) || 0), interval: interval ? Math.max(1, Number(delay) || 1) : 0 }); return id;
  };
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const fetch = (url, options = {}) => {
    if (String(url) === '/api/public/guest-session') return Promise.resolve(reply({ recognized: false }));
    if (String(url) === '/api/auth/phone/cancel' || String(url) === '/api/public/guest-session/forget') return Promise.resolve(reply({ ok: true }));
    let resolve; let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    calls.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : null, resolve, reject, settled: false });
    return promise;
  };
  function reply(body, status = 200, headers = {}) {
    return { ok: status >= 200 && status < 300, status, headers: { get: name => headers[name.toLowerCase()] ?? headers[name] ?? null },
      json: async () => body, text: async () => JSON.stringify(body) };
  }
  const storage = new Map();
  const context = vm.createContext({
    document, location, URL, URLSearchParams, Event: FakeEvent, Date: ClockDate, fetch, console,
    AbortController, navigator: { userAgent: 'verification-state-unit-test' },
    matchMedia: query => ({ matches: query.includes('max-width') ? phone : false, addEventListener() {}, removeEventListener() {} }),
    setTimeout: (callback, delay) => schedule(callback, delay), clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, true), clearInterval: id => timers.delete(id),
    requestAnimationFrame: callback => schedule(() => callback(now), 0), cancelAnimationFrame: id => timers.delete(id),
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
    getComputedStyle: () => ({ direction: 'ltr' })
  });
  context.window = context; context.globalThis = context; document.defaultView = context;
  vm.runInContext(read('public/js/email-code-input.js'), context, { filename: 'email-code-input.js' });
  vm.runInContext(read('public/js/verification-code.js'), context, { filename: 'verification-code.js' });
  const inlineScripts = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.ok(inlineScripts.length > 0, 'test must execute the real inline login controller');
  for (const source of inlineScripts) vm.runInContext(source, context, { filename: 'login-inline.js' });

  async function settle() { for (let turn = 0; turn < 12; turn += 1) await Promise.resolve(); }
  function node(id) { const element = elements.get(id); assert.ok(element, `login element #${id} must exist`); return element; }
  function fire(id, type = 'click', extras = {}) { const element = node(id); element.dispatchEvent(new FakeEvent(type, { bubbles: true, ...extras })); }
  async function respond(url, body, status = 200, headers = {}) {
    const call = calls.find(candidate => candidate.url === url && !candidate.settled);
    assert.ok(call, `expected a pending mocked request for ${url}`);
    call.settled = true; call.resolve(reply(body, status, headers)); await settle(); return call;
  }
  async function advance(ms) {
    const target = now + ms;
    for (let step = 0; step < 2000; step += 1) {
      const pending = [...timers].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!pending) { now = target; await settle(); return; }
      const [id, timer] = pending; now = timer.due;
      if (timer.interval) timer.due += timer.interval; else timers.delete(id);
      timer.callback(); await settle();
    }
    throw new Error('fake clock exceeded its bounded timer budget');
  }
  return { node, fire, calls, navigations, respond, advance, settle, context,
    count: url => calls.filter(call => call.url === url).length };
}

async function beginEmail(h, email = 'guest@example.test') {
  if (h.node('form-state').hidden) {
    const switchButton = h.context.document.querySelectorAll('.use-email-instead')[0];
    assert.ok(switchButton); switchButton.dispatchEvent(new h.context.Event('click', { bubbles: true }));
  }
  h.node('email').value = email;
  h.fire('login-form', 'submit');
  await h.respond('/api/auth/magic-link', { ok: true });
  assert.equal(h.node('sent-state').hidden, false);
}

async function beginPhone(h) {
  h.node('phone').value = '+14155550123';
  h.fire('phone-form', 'submit');
  await h.respond('/api/auth/phone/start', { ok: true, codeLength: 6 });
  assert.equal(h.node('phone-code-state').hidden, false);
}

test('email code verifies automatically once and displays success only after the server accepts it', async () => {
  const h = loginHarness();
  await beginEmail(h);
  h.node('code').value = '123456'; h.fire('code', 'input');
  h.fire('code', 'change'); h.fire('code-form', 'submit');
  assert.equal(h.count('/api/auth/verify-code'), 1);
  assert.equal(h.node('email-code-control').dataset.verificationState, 'checking');
  assert.equal(h.node('code-submit').disabled, true);
  assert.equal(h.navigations.length, 0);
  await h.respond('/api/auth/verify-code', { ok: true, redirect: '/events/new' });
  assert.equal(h.node('email-code-control').dataset.verificationState, 'success');
  assert.equal(h.navigations.length, 0, 'success is visible briefly before navigation');
  await h.advance(500);
  assert.deepEqual(h.navigations, ['/events/new']);
});

test('formatted email-code paste keeps the existing six-digit normalization and triggers one verification', async () => {
  const h = loginHarness(); await beginEmail(h);
  let prevented = false;
  h.context.document.dispatchEvent({ type: 'paste', target: h.node('code'),
    clipboardData: { getData: () => '549\u00a0218' }, preventDefault() { prevented = true; } });
  await h.settle();
  assert.equal(prevented, true);
  assert.equal(h.node('code').value, '549218');
  assert.equal(h.count('/api/auth/verify-code'), 1);
  assert.equal(h.calls.find(call => call.url === '/api/auth/verify-code').body.code, '549218');
  assert.equal(h.node('email-code-control').dataset.verificationState, 'checking');
});

test('phone proof follows server redirect for an existing account but asks for email for a new phone', async () => {
  const returning = loginHarness({ phone: true });
  await beginPhone(returning);
  returning.node('phone-code').value = '654321'; returning.fire('phone-code', 'input');
  assert.equal(returning.node('phone-code-control').dataset.verificationState, 'checking');
  await returning.respond('/api/auth/phone/verify', { ok: true, redirect: '/dashboard' });
  assert.equal(returning.node('phone-code-control').dataset.verificationState, 'success');
  await returning.advance(500);
  assert.deepEqual(returning.navigations, ['/dashboard']);

  const fresh = loginHarness({ phone: true });
  await beginPhone(fresh);
  fresh.node('phone-code').value = '654321'; fresh.fire('phone-code', 'input');
  await fresh.respond('/api/auth/phone/verify', { ok: true, needsEmail: true, maskedPhone: '+1•••0123' });
  await fresh.advance(500);
  assert.equal(fresh.node('phone-email-state').hidden, false);
  assert.equal(fresh.navigations.length, 0, 'new phone proof alone never signs in');
  fresh.node('phone-email').value = 'new@example.test'; fresh.fire('phone-email-form', 'submit');
  await fresh.respond('/api/auth/phone/email', { ok: true, maskedEmail: 'n•••@example.test', codeLength: 6 });
  assert.equal(fresh.node('sent-state').hidden, false);
  assert.doesNotMatch(fresh.node('sent-suffix').textContent, /link/i);
  assert.doesNotMatch(fresh.node('code-expiry').textContent, /link/i);
  fresh.node('code').value = '112233'; fresh.fire('code', 'input');
  await fresh.respond('/api/auth/verify-code', { ok: true, redirect: '/events/new' });
  await fresh.advance(500);
  assert.deepEqual(fresh.navigations, ['/events/new']);
});

test('invalid, expired and locked server results never show success and permit only appropriate recovery', async () => {
  for (const [error, message] of [['invalid', 'That code did not match.'], ['expired', 'That code expired.'], ['locked', 'Too many wrong codes. Request a new one.']]) {
    const h = loginHarness(); await beginEmail(h);
    h.node('code').value = '123456'; h.fire('code', 'input');
    await h.respond('/api/auth/verify-code', { error, message }, 400);
    assert.notEqual(h.node('email-code-control').dataset.verificationState, 'success');
    assert.match(`${h.node('code-error').textContent} ${h.node('email-code-status').textContent}`, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await h.advance(500);
    assert.equal(h.navigations.length, 0);
  }
});

test('a network failure does not invent verification success or permanently lock the code control', async () => {
  const h = loginHarness(); await beginEmail(h);
  h.node('code').value = '123456'; h.fire('code', 'input');
  const call = h.calls.find(candidate => candidate.url === '/api/auth/verify-code');
  call.settled = true; call.reject(new Error('Connection interrupted. Try again.')); await h.settle();
  assert.equal(h.node('email-code-control').dataset.verificationState, 'error');
  assert.equal(h.node('code').readOnly, false);
  assert.match(`${h.node('code-error').textContent} ${h.node('email-code-status').textContent}`, /Connection interrupted|connection|try again/i);
  await h.advance(500);
  assert.equal(h.navigations.length, 0);
});

test('editing an email destination cancels stale verification and its delayed success navigation', async () => {
  const h = loginHarness(); await beginEmail(h);
  h.node('code').value = '123456'; h.fire('code', 'input');
  h.fire('different-code-email');
  assert.equal(h.node('form-state').hidden, false);
  await h.respond('/api/auth/verify-code', { ok: true, redirect: '/events/new' });
  await h.advance(600);
  assert.equal(h.node('form-state').hidden, false);
  assert.equal(h.navigations.length, 0);

  await beginEmail(h, 'next@example.test');
  h.node('code').value = '654321'; h.fire('code', 'input');
  await h.respond('/api/auth/verify-code', { ok: true, redirect: '/dashboard' });
  h.fire('different-code-email');
  await h.advance(600);
  assert.equal(h.navigations.length, 0, 'leaving during the success pause cancels navigation');
});

test('switching methods ignores late phone starts and phone verification results', async () => {
  const h = loginHarness({ phone: true });
  h.node('phone').value = '+14155550123'; h.fire('phone-form', 'submit');
  const emailSwitch = h.context.document.querySelectorAll('.use-email-instead')[0];
  emailSwitch.dispatchEvent(new h.context.Event('click', { bubbles: true }));
  await h.respond('/api/auth/phone/start', { ok: true, codeLength: 6 });
  assert.equal(h.node('form-state').hidden, false);
  h.fire('use-phone-instead'); await beginPhone(h);
  h.node('phone-code').value = '123456'; h.fire('phone-code', 'input');
  emailSwitch.dispatchEvent(new h.context.Event('click', { bubbles: true }));
  await h.respond('/api/auth/phone/verify', { ok: true, redirect: '/dashboard' });
  await h.advance(600);
  assert.equal(h.node('form-state').hidden, false);
  assert.equal(h.navigations.length, 0);
});

test('an initial email request cannot submit twice or return the user to email after they switch methods', async () => {
  const h = loginHarness();
  h.node('email').value = 'first@example.test';
  h.fire('login-form', 'submit'); h.fire('login-form', 'submit');
  assert.equal(h.count('/api/auth/magic-link'), 1);
  h.fire('use-phone-instead');
  assert.equal(h.node('phone-state').hidden, false);
  await h.respond('/api/auth/magic-link', { ok: true });
  await h.advance(500);
  assert.equal(h.node('phone-state').hidden, false);
  assert.equal(h.node('sent-state').hidden, true);
  assert.equal(h.navigations.length, 0);
});

test('changing the phone number invalidates a pending phone verification and preserves the new destination', async () => {
  const h = loginHarness({ phone: true }); await beginPhone(h);
  h.node('phone-code').value = '123456'; h.fire('phone-code', 'input');
  h.fire('phone-change-number');
  h.node('phone').value = '+14155550999';
  await h.respond('/api/auth/phone/verify', { ok: true, needsEmail: true });
  await h.advance(500);
  assert.equal(h.node('phone-state').hidden, false);
  assert.equal(h.node('phone-email-state').hidden, true);
  assert.equal(h.node('phone').value, '+14155550999');
  assert.equal(h.navigations.length, 0);
});

test('a verification rate limit honors Retry-After beyond the normal resend countdown and after method toggles', async () => {
  const h = loginHarness(); await beginEmail(h);
  h.node('code').value = '123456'; h.fire('code', 'input');
  await h.respond('/api/auth/verify-code', { error: 'too_many_attempts', message: 'Wait before trying again.' }, 429, { 'retry-after': '120' });
  assert.equal(h.node('resend-code').disabled, true);
  await h.advance(31000);
  assert.equal(h.node('resend-code').disabled, true, '429 is not reduced to the ordinary 30 seconds');
  h.fire('different-code-email'); h.fire('use-phone-instead');
  const emailSwitch = h.context.document.querySelectorAll('.use-email-instead')[0];
  emailSwitch.dispatchEvent(new h.context.Event('click', { bubbles: true }));
  assert.equal(h.node('resend-code').disabled, true, 'changing views does not reset the cooldown');
});

test('phone verification errors stay on the phone step and HTTP-date Retry-After survives changing the number', async () => {
  const h = loginHarness({ phone: true }); await beginPhone(h);
  h.node('phone-code').value = '123456'; h.fire('phone-code', 'input');
  await h.respond('/api/auth/phone/verify', { error: 'phone_verification_expired', message: 'This text code has expired.' }, 400);
  assert.equal(h.node('phone-code-control').dataset.verificationState, 'error');
  assert.equal(h.node('phone-email-state').hidden, true);
  assert.match(h.node('phone-code-error').textContent, /expired/);
  h.node('phone-code').value = '654321'; h.fire('phone-code', 'input');
  h.fire('phone-code-form', 'submit');
  assert.equal(h.count('/api/auth/phone/verify'), 1, 'an expired challenge cannot be retried by editing its code');
  assert.equal(h.node('phone-code-submit').disabled, true);
  await h.advance(31000);
  h.fire('resend-phone-code');
  await h.respond('/api/auth/phone/start', { ok: true, codeLength: 6 });
  assert.equal(h.node('phone-code').value, '');
  assert.equal(h.node('phone-code-control').dataset.verificationState, 'idle');
  h.node('phone-code').value = '654321'; h.fire('phone-code', 'input');
  assert.equal(h.count('/api/auth/phone/verify'), 2, 'an accepted resend replaces the expired challenge');
  const until = new Date(1700000000000 + 121000).toUTCString();
  await h.respond('/api/auth/phone/verify', { error: 'too_many_attempts', message: 'Wait before another phone attempt.' }, 429, { 'retry-after': until });
  assert.equal(h.node('resend-phone-code').disabled, true);
  h.fire('phone-change-number');
  await h.advance(31000);
  assert.equal(h.node('phone-state').hidden, false);
  assert.equal(h.node('resend-phone-code').disabled, true);
  assert.equal(h.navigations.length, 0);
});

test('a same-code change after an invalid response keeps the alert and never auto-submits again', async () => {
  const h = loginHarness(); await beginEmail(h);
  h.node('code').value = '123456'; h.fire('code', 'input');
  await h.respond('/api/auth/verify-code', { error: 'invalid', message: 'That code does not match.' }, 400);
  h.fire('code', 'change'); h.fire('code', 'input');
  assert.equal(h.count('/api/auth/verify-code'), 1);
  assert.equal(h.node('email-code-control').dataset.verificationState, 'error');
  assert.equal(h.node('code-error').textContent, 'That code does not match.');
  assert.equal(h.node('code-submit').disabled, false, 'ordinary wrong codes still permit an intentional retry');
  h.node('code').value = '654321'; h.fire('code', 'input');
  assert.equal(h.count('/api/auth/verify-code'), 2, 'a changed complete code may be checked automatically');
  assert.equal(h.node('email-code-control').dataset.verificationState, 'checking');
});

test('expired or locked email challenges require an accepted resend before any new code attempt', async () => {
  for (const error of ['expired', 'locked']) {
    const h = loginHarness(); await beginEmail(h);
    h.node('code').value = '123456'; h.fire('code', 'input');
    await h.respond('/api/auth/verify-code', { error, message: 'Request a new email code.' }, 400);
    h.node('code').value = '654321'; h.fire('code', 'input'); h.fire('code-form', 'submit');
    assert.equal(h.count('/api/auth/verify-code'), 1);
    assert.equal(h.node('code-submit').disabled, true);
    assert.match(h.node('code-error').textContent, /Request a new/);
    await h.advance(31000);
    h.fire('resend-code');
    await h.respond('/api/auth/magic-link', { ok: true });
    assert.equal(h.node('code').value, '');
    assert.equal(h.node('email-code-control').dataset.verificationState, 'idle');
    h.node('code').value = '112233'; h.fire('code', 'input');
    assert.equal(h.count('/api/auth/verify-code'), 2);
    assert.equal(h.node('email-code-control').dataset.verificationState, 'checking');
  }
});

test('resend uses the same endpoint and destination and cannot overlap itself', async () => {
  const h = loginHarness(); await beginEmail(h, 'same@example.test');
  await h.advance(31000);
  h.fire('resend-code'); h.fire('resend-code');
  assert.equal(h.count('/api/auth/magic-link'), 2, 'one initial request and one resend');
  const resend = h.calls.filter(call => call.url === '/api/auth/magic-link')[1];
  assert.equal(resend.body.email, 'same@example.test');
  await h.respond('/api/auth/magic-link', { ok: true });
  assert.equal(h.node('code').value, '');
  assert.equal(h.node('resend-code').disabled, true);
});

test('resend cannot race an active verification and late resend results cannot overwrite an edited destination', async () => {
  const h = loginHarness(); await beginEmail(h);
  await h.advance(31000);
  h.node('code').value = '123456'; h.fire('code', 'input');
  h.fire('resend-code');
  assert.equal(h.count('/api/auth/magic-link'), 1, 'no resend while a verification is in flight');
  await h.respond('/api/auth/verify-code', { error: 'invalid', message: 'Wrong code.' }, 400);
  h.fire('resend-code');
  assert.equal(h.count('/api/auth/magic-link'), 2);
  h.fire('different-code-email');
  h.node('email').value = 'new-destination@example.test';
  await h.respond('/api/auth/magic-link', { ok: true });
  assert.equal(h.node('form-state').hidden, false);
  assert.equal(h.node('email').value, 'new-destination@example.test');
  assert.equal(h.node('sent-state').hidden, true);
  assert.equal(h.navigations.length, 0);
});

test('a successful HTTP status without an affirmative proof result never shows phone or email success', async () => {
  const email = loginHarness(); await beginEmail(email);
  email.node('code').value = '123456'; email.fire('code', 'input');
  await email.respond('/api/auth/verify-code', { ok: false, redirect: '/dashboard' });
  await email.advance(500);
  assert.notEqual(email.node('email-code-control').dataset.verificationState, 'success');
  assert.equal(email.navigations.length, 0);

  const phone = loginHarness({ phone: true }); await beginPhone(phone);
  phone.node('phone-code').value = '123456'; phone.fire('phone-code', 'input');
  await phone.respond('/api/auth/phone/verify', { ok: false, needsEmail: true });
  await phone.advance(500);
  assert.notEqual(phone.node('phone-code-control').dataset.verificationState, 'success');
  assert.equal(phone.node('phone-email-state').hidden, true);
  assert.equal(phone.navigations.length, 0);
});

test('unsafe server redirect values cannot navigate away from Silver Glider', async () => {
  const h = loginHarness({ search: '?next=https%3A%2F%2Fattacker.example' }); await beginEmail(h);
  h.node('code').value = '123456'; h.fire('code', 'input');
  await h.respond('/api/auth/verify-code', { ok: true, redirect: 'https://attacker.example' });
  await h.advance(500);
  assert.ok(h.navigations.every(value => value.startsWith('/') && !value.startsWith('//')));
});
