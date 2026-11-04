const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const verification = require('../public/js/verification-code');

class FakeEvent {
  constructor(type, options = {}) { Object.assign(this, options); this.type = type; }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
}

class FakeElement {
  constructor(documentRoot, tag = 'div') {
    this.ownerDocument = documentRoot;
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this._text = '';
    this.textChanges = 0;
    this.value = '';
    this.readOnly = false;
    this.disabled = false;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const add = force === undefined ? !this.classList.contains(name) : force;
        this.classList[add ? 'add' : 'remove'](name);
        return add;
      }
    };
  }
  get textContent() { return this._text + this.childNodes.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.childNodes = []; this.textChanges += 1; }
  get offsetWidth() { return 20; }
  append(...elements) { for (const element of elements) { element.parentNode = this; this.childNodes.push(element); } }
  replaceChildren(...elements) { this.childNodes = []; this._text = ''; this.append(...elements); }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(child => child !== this); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter(candidate => candidate !== listener)); }
  dispatchEvent(event) {
    event.target ||= this;
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    if (event.bubbles && !event.propagationStopped && this.ownerDocument !== this) this.ownerDocument.dispatchEvent(event);
    return !event.defaultPrevented;
  }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  getBoundingClientRect() { return { left: 10, width: 360 }; }
  focus() { this.ownerDocument.activeElement = this; this.dispatchEvent(new FakeEvent('focus')); }
  blur() { this.ownerDocument.activeElement = null; this.dispatchEvent(new FakeEvent('blur')); }
}

function fixture() {
  const documentRoot = new FakeElement(null, 'document');
  documentRoot.ownerDocument = documentRoot;
  documentRoot.defaultView = { Event: FakeEvent };
  documentRoot.createElement = tag => new FakeElement(documentRoot, tag);
  const container = documentRoot.createElement('div');
  const input = documentRoot.createElement('input');
  input.setAttribute('autocomplete', 'one-time-code');
  input.setAttribute('aria-label', '6-digit code');
  input.setAttribute('maxlength', '6');
  container.append(input);
  const button = documentRoot.createElement('button');
  const originalLabel = documentRoot.createElement('span');
  originalLabel.textContent = 'Sign in';
  button.append(originalLabel);
  const status = documentRoot.createElement('p');
  status.setAttribute('role', 'status');
  const error = documentRoot.createElement('p');
  error.setAttribute('role', 'alert');
  const control = verification.attach({ input, container, button, status, error });
  const visual = container.childNodes[1];
  return { documentRoot, container, input, button, status, error, control, visual, cells: visual.childNodes, originalLabel };
}

function edit(input, value, start = value.length, end = start) {
  input.value = value;
  input.setSelectionRange(start, end);
  input.dispatchEvent(new FakeEvent('input', { bubbles: true }));
}

test('verification enhancement retains one native field and creates exactly six presentation-only cells', () => {
  const { input, container, button, control, visual, cells } = fixture();
  assert.equal(container.childNodes.filter(child => child.tagName === 'INPUT').length, 1);
  assert.equal(container.childNodes[0], input);
  assert.equal(cells.length, 6);
  assert.equal(visual.getAttribute('aria-hidden'), 'true');
  assert.ok(cells.every(cell => cell.getAttribute('aria-hidden') === 'true'));
  assert.equal(input.getAttribute('autocomplete'), 'one-time-code');
  assert.equal(input.getAttribute('aria-label'), '6-digit code');
  assert.equal(input.getAttribute('maxlength'), '6');
  assert.equal(input.getAttribute('aria-hidden'), null);
  assert.equal(button.childNodes[0].getAttribute('aria-hidden'), 'true');
  assert.equal(verification.attach({ input, container, button }), control);
  assert.equal(container.childNodes.length, 2, 'repeat attachment does not duplicate cells/listeners');
  assert.equal(button.disabled, true);
});

test('native entry, deletion and autofill synchronize digits without submitting anything', () => {
  const { input, cells, button, documentRoot } = fixture();
  let submissions = 0;
  documentRoot.addEventListener('submit', () => { submissions += 1; });
  edit(input, '1');
  assert.equal(cells[0].textContent, '1');
  assert.ok(cells[0].classList.contains('is-entering'));
  assert.equal(button.disabled, true);
  edit(input, '123456');
  assert.equal(cells.map(cell => cell.textContent).join(''), '123456');
  assert.equal(button.disabled, false);
  edit(input, '12345');
  assert.equal(cells[5].textContent, '');
  assert.equal(button.disabled, true);
  edit(input, ' 12-34 56 extra ');
  assert.equal(input.value, '123456');
  assert.equal(cells.map(cell => cell.textContent).join(''), '123456');
  assert.equal(submissions, 0);
});

test('full formatted paste is normalized before maxlength and emits one native input event', () => {
  for (const value of ['549 218', '549\u00a0218', '549-218', '549218']) {
    const { input, documentRoot, cells } = fixture();
    let nativeInputs = 0;
    let delegatedPastes = 0;
    documentRoot.addEventListener('input', () => { nativeInputs += 1; });
    documentRoot.addEventListener('paste', () => { delegatedPastes += 1; });
    const event = new FakeEvent('paste', { bubbles: true, clipboardData: { getData: () => value } });
    input.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(input.value, '549218');
    assert.equal(input.selectionStart, 6);
    assert.equal(cells.map(cell => cell.textContent).join(''), '549218');
    assert.equal(nativeInputs, 1);
    assert.equal(delegatedPastes, 0, 'shared email paste helper must not dispatch a second input');
  }
});

test('partial paste preserves native replacement semantics and readonly checking cannot be pasted over', () => {
  const { input, control } = fixture();
  edit(input, '12');
  const partial = new FakeEvent('paste', { clipboardData: { getData: () => '34-5' } });
  input.dispatchEvent(partial);
  assert.equal(partial.defaultPrevented, undefined);
  assert.equal(input.value, '12');
  control.setState('checking', { label: 'Checking code…' });
  const blocked = new FakeEvent('paste', { clipboardData: { getData: () => '123456' } });
  input.dispatchEvent(blocked);
  assert.equal(input.value, '12');
});

test('visible caret and selected cells follow focus, arrows, select-all and blur', () => {
  const { input, cells, documentRoot, control } = fixture();
  input.focus();
  assert.equal(documentRoot.activeElement, input);
  assert.ok(cells[0].classList.contains('is-active'));
  edit(input, '123456');
  assert.ok(cells[5].classList.contains('is-active'));
  assert.ok(cells[5].classList.contains('is-at-end'));
  input.setSelectionRange(2, 2);
  input.dispatchEvent(new FakeEvent('keyup'));
  assert.ok(cells[2].classList.contains('is-active'));
  input.setSelectionRange(0, 6);
  documentRoot.dispatchEvent(new FakeEvent('selectionchange'));
  assert.ok(cells.every(cell => cell.classList.contains('is-selected')));
  assert.ok(cells.every(cell => !cell.classList.contains('is-active')));
  control.setState('checking');
  assert.ok(cells.every(cell => !cell.classList.contains('is-active')));
  input.blur();
  assert.ok(cells.every(cell => !cell.classList.contains('is-selected')));
});

test('a single tap positions the native caret at its displayed cell while drag selection is kept', () => {
  const { input, cells } = fixture();
  edit(input, '123456');
  input.focus();
  input.dispatchEvent(new FakeEvent('click', { clientX: 200, detail: 1 }));
  assert.equal(input.selectionStart, 3);
  assert.ok(cells[3].classList.contains('is-active'));
  input.setSelectionRange(1, 4);
  input.dispatchEvent(new FakeEvent('click', { clientX: 350, detail: 1 }));
  assert.equal(input.selectionStart, 1);
  assert.equal(input.selectionEnd, 4);
});

test('checking and success have distinct truthful labels, readonly fields and stable button states', () => {
  const { input, button, container, status, error, control } = fixture();
  edit(input, '123456');
  control.setState('checking', { label: 'Checking code…', message: 'Checking code…' });
  assert.equal(input.readOnly, true);
  assert.equal(input.disabled, false, 'readonly field remains focusable');
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(container.getAttribute('data-verification-state'), 'checking');
  assert.equal(status.textContent, 'Checking code…');
  assert.equal(error.textContent, '');
  control.setState('success', { label: 'Phone verified', message: 'Phone verified' });
  assert.equal(button.textContent, 'Phone verified');
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'false');
  assert.equal(container.getAttribute('data-verification-state'), 'success');
  assert.equal(status.textContent, 'Phone verified');
  assert.doesNotMatch(status.textContent, /signed in/i);
});

test('errors are announced once through the existing alert, not the polite status or decorative cells', () => {
  const { input, button, status, error, cells, control } = fixture();
  edit(input, '123456');
  control.setState('checking', { message: 'Checking code…' });
  control.setState('error', { label: 'Try again', message: 'That code expired. Send a new code.' });
  assert.equal(input.readOnly, false);
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(button.disabled, false);
  assert.equal(status.textContent, '');
  assert.equal(error.textContent, 'That code expired. Send a new code.');
  assert.equal(error.classList.contains('sg-verification-error'), true);
  const writes = error.textChanges;
  control.setState('error', { label: 'Try again in 0:29', message: error.textContent, disabled: true });
  assert.equal(error.textChanges, writes, 'countdown must not reannounce the same error every second');
  assert.ok(cells.every(cell => cell.getAttribute('aria-hidden') === 'true'));
  control.setState('idle', { label: 'Enter all 6 digits' });
  assert.equal(input.getAttribute('aria-invalid'), 'false');
  assert.equal(error.textContent, '');
});

test('an explicit server rate-limit lock survives edits and sync until the owner clears it', () => {
  const { input, button, control } = fixture();
  edit(input, '123456');
  control.setState('error', { label: 'Try again in 0:30', message: 'Wait before trying again.', disabled: true });
  edit(input, '654321');
  control.sync();
  assert.equal(input.readOnly, false);
  assert.equal(button.disabled, true);
  control.setState('error', { label: 'Try again', disabled: false });
  assert.equal(button.disabled, false);
  edit(input, '654');
  assert.equal(button.disabled, true, 'clearing a rate limit cannot bypass the six-digit minimum');
});

test('reset clears the code and live text; destroy restores a real usable native fallback', () => {
  const { input, button, status, error, control, container, originalLabel } = fixture();
  edit(input, '123456');
  control.setState('error', { label: 'Try again', message: 'Wrong code.' });
  control.reset();
  assert.equal(input.value, '');
  assert.equal(error.textContent, '');
  assert.equal(status.textContent, '');
  assert.equal(button.disabled, true);
  control.destroy();
  assert.equal(container.childNodes.length, 1);
  assert.equal(container.childNodes[0], input);
  assert.equal(input.classList.contains('sg-verification-native'), false);
  assert.equal(input.readOnly, false);
  assert.equal(input.getAttribute('aria-invalid'), null);
  assert.equal(button.disabled, false);
  assert.equal(button.childNodes[0], originalLabel);
  assert.equal(button.textContent, 'Sign in');
  assert.equal(error.classList.contains('sg-verification-error'), false);
  input.value = '987654';
  control.sync();
  assert.equal(input.value, '987654');
  assert.equal(input.listeners.get('paste').length, 0);
});

function countdownFixture() {
  const { button } = fixture();
  let clock = 100000;
  let nextId = 0;
  const pending = new Map();
  const helper = verification.createResend(button, {
    now: () => clock,
    setTimeout: (callback, delay) => { const id = ++nextId; pending.set(id, { callback, delay }); return id; },
    clearTimeout: id => pending.delete(id)
  });
  function advance(milliseconds) {
    clock += milliseconds;
    const callbacks = [...pending.values()];
    pending.clear();
    callbacks.forEach(timer => timer.callback());
  }
  return { button, helper, advance, pending };
}

test('resend countdown uses a deadline, including delayed/background ticks, not a drifting decrement', () => {
  const { button, helper, advance, pending } = countdownFixture();
  helper.start();
  assert.equal(button.textContent, 'Resend in 0:30');
  assert.equal(button.disabled, true);
  assert.equal(helper.getRemaining(), 30000);
  advance(18500);
  assert.equal(button.textContent, 'Resend in 0:12');
  assert.equal(helper.getRemaining(), 11500);
  advance(12000);
  assert.equal(button.textContent, 'Send a new code');
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('data-resend-state'), 'ready');
  assert.equal(pending.size, 0);
});

test('restart replaces the old countdown and sending(false) never unlocks an unexpired cooldown', () => {
  const { button, helper, advance, pending } = countdownFixture();
  helper.start(30000);
  advance(1000);
  helper.start(60000);
  assert.equal(helper.getRemaining(), 60000);
  assert.equal(pending.size, 1);
  helper.setSending(true);
  assert.equal(button.textContent, 'Sending a new code…');
  assert.equal(button.getAttribute('aria-busy'), 'true');
  helper.setSending(false);
  assert.equal(button.textContent, 'Resend in 1:00');
  assert.equal(button.disabled, true);
  helper.stop();
  assert.equal(helper.getRemaining(), 0);
  assert.equal(button.disabled, false);
  assert.equal(pending.size, 0);
});

test('resend helper destroy cancels timers and never schedules or changes text afterward', () => {
  const { button, helper, advance, pending } = countdownFixture();
  helper.start();
  helper.destroy();
  assert.equal(pending.size, 0);
  const label = button.textContent;
  advance(60000);
  helper.start();
  helper.stop();
  helper.setSending(true);
  assert.equal(button.textContent, label);
  assert.equal(pending.size, 0);
});

test('pure selection helpers clamp to six cells without exposing code text to status', () => {
  assert.equal(verification.digits('12 34-56 extra7'), '123456');
  assert.deepEqual(verification.selection('123456', 6, 6), { start: 6, end: 6, active: 5, atEnd: true });
  assert.deepEqual(verification.selection('12', 100, 100), { start: 2, end: 2, active: 2, atEnd: false });
  assert.deepEqual(verification.selection('123456', 1, 4), { start: 1, end: 4, active: 1, atEnd: false });
  assert.equal(verification.attach(), null);
});

test('component styles are scoped, motion has a reduced alternative, and forced colors keep the native field visible', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/verification-code.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../public/js/verification-code.js'), 'utf8');
  assert.match(css, /\.sg-verification-button\.sg-btn/);
  assert.doesNotMatch(css, /(?:^|\n)\.sg-btn\s*\{/);
  assert.match(css, /sg-verification-digit-in 150ms/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.sg-verification-button \.sg-verification-button-icon \{ animation: none !important; \}/);
  assert.match(css, /\[data-verification-state='idle'\]:disabled,[\s\S]*?color: #b5bfbd/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /caret-color: CanvasText/);
  assert.match(css, /\.sg-verification-cell\.is-active::after/);
  assert.match(css, /\.sg-verification-code\[data-verification-state='error'\]\.is-focused \.sg-verification-cell \{\s*border-color: #f28b82/);
  assert.match(css, /\.sg-verification-code\[data-verification-state='error'\]\.is-focused \.sg-verification-cell\.is-selected \{\s*background: rgba\(242,139,130,\.16\)/);
  assert.match(css, /\.sg-verification-error:not\(:empty\) \{ display: block !important/);
  assert.match(css, /\.sg-verification-button\.sg-btn\[data-verification-state='success'\]:disabled/);
  assert.doesNotMatch(js, /\b(?:fetch|XMLHttpRequest|localStorage|requestSubmit)\b|\.submit\(/);
  assert.doesNotMatch(js, /console\./);
});
