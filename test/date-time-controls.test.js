const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const controls = require('../public/js/date-time-controls');

class FakeEvent {
  constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
  preventDefault() { this.defaultPrevented = true; }
}

function element(documentRoot) {
  const attributes = new Map();
  const listeners = new Map();
  const classes = new Set();
  return {
    ownerDocument: documentRoot, value: '', hidden: false, disabled: false, readOnly: false,
    validity: { valid: true }, textContent: '', listeners,
    classList: { add: value => classes.add(value), contains: value => classes.has(value),
      toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value) },
    get min() { return attributes.get('min') || ''; }, set min(value) { attributes.set('min', value); },
    get max() { return attributes.get('max') || ''; }, set max(value) { attributes.set('max', value); },
    setAttribute: (key, value) => attributes.set(key, String(value)),
    getAttribute: key => attributes.get(key) ?? null,
    removeAttribute: key => attributes.delete(key),
    addEventListener(type, listener) { const list = listeners.get(type) || []; list.push(listener); listeners.set(type, list); },
    removeEventListener(type, listener) { listeners.set(type, (listeners.get(type) || []).filter(item => item !== listener)); },
    dispatchEvent(event) { event.target ||= this; (listeners.get(event.type) || []).forEach(listener => listener(event)); },
    click() { this.clicks = (this.clicks || 0) + 1; this.dispatchEvent(new FakeEvent('click')); },
    focus() { this.focuses = (this.focuses || 0) + 1; documentRoot.activeElement = this; },
    closest() { return this.parentElement; }
  };
}

function fixture(options = {}) {
  const documentRoot = { defaultView: { Event: FakeEvent } };
  const dateInput = element(documentRoot);
  const timeInput = element(documentRoot);
  dateInput.id = 'date'; timeInput.id = 'time';
  if (options.showPicker !== false) {
    dateInput.showPicker = () => {};
    timeInput.showPicker = () => {};
  }
  dateInput.parentElement = element(documentRoot);
  timeInput.parentElement = element(documentRoot);
  const dateButton = element(documentRoot);
  const timeButton = element(documentRoot);
  const todayButton = element(documentRoot);
  dateButton.hidden = timeButton.hidden = todayButton.hidden = true;
  const timeZoneLabel = element(documentRoot);
  dateInput.value = options.date || '';
  timeInput.value = options.time || '';
  if (options.min) dateInput.min = options.min;
  if (options.max) dateInput.max = options.max;
  let clock = Date.parse('2026-11-04T03:30:00Z'); // Still November 3 in Los Angeles.
  const fields = { dateInput, timeInput, dateButton, timeButton, todayButton, timeZoneLabel };
  const control = controls.attach({ ...fields, ...options, now: () => clock });
  return { ...fields, control, documentRoot, advance(milliseconds) { clock += milliseconds; } };
}

test('Today is computed in the event time zone, not browser-local or UTC, including midnight and DST', () => {
  assert.equal(controls.localDate('America/Los_Angeles', '2026-11-04T03:30:00Z'), '2026-11-03');
  assert.equal(controls.localDate('Asia/Tokyo', '2026-11-04T03:30:00Z'), '2026-11-04');
  assert.equal(controls.localDate('America/Los_Angeles', '2026-07-04T06:59:59Z'), '2026-07-03');
  assert.equal(controls.localDate('America/Los_Angeles', '2026-07-04T07:00:00Z'), '2026-07-04');
  assert.equal(controls.localDate('America/Los_Angeles', '2026-03-08T09:30:00Z'), '2026-03-08');
  assert.equal(controls.localDate('America/Los_Angeles', '2026-03-08T10:30:00Z'), '2026-03-08');
  assert.equal(controls.localDate('invalid-zone', '2026-11-04T03:30:00Z'), '2026-11-03');
});

test('timezone label is season-neutral rather than stamping current PST/PDT onto future events', () => {
  assert.equal(controls.timeZoneName('America/Los_Angeles', '2026-01-01'), 'Pacific Time');
  assert.equal(controls.timeZoneName('America/Los_Angeles', '2026-07-01'), 'Pacific Time');
  const { timeZoneLabel } = fixture();
  assert.equal(timeZoneLabel.textContent, 'Pacific Time');
  assert.equal(timeZoneLabel.getAttribute('title'), 'America/Los_Angeles');
});

test('attach and repeated sync never choose a date, time or minute step', () => {
  const empty = fixture();
  empty.control.sync();
  assert.equal(empty.dateInput.value, '');
  assert.equal(empty.timeInput.value, '');
  assert.equal(empty.dateInput.min, '', 'historical/editing flows have no new past-date restriction');
  assert.equal(empty.timeInput.getAttribute('step'), null);
  const saved = fixture({ date: '2024-01-04', time: '18:37' });
  saved.control.sync();
  assert.equal(saved.dateInput.value, '2024-01-04');
  assert.equal(saved.timeInput.value, '18:37');
  assert.equal(saved.dateInput.parentElement.classList.contains('is-filled'), true);
});

test('triggers are revealed as non-submit accessible buttons and call their own native picker once', () => {
  const fields = fixture();
  let dateOpens = 0;
  let timeOpens = 0;
  fields.dateInput.showPicker = () => { dateOpens += 1; };
  fields.timeInput.showPicker = () => { timeOpens += 1; };
  assert.equal(fields.dateButton.hidden, false);
  assert.equal(fields.timeButton.hidden, false);
  assert.equal(fields.todayButton.hidden, false);
  assert.equal(fields.dateButton.type, 'button');
  assert.equal(fields.dateButton.getAttribute('aria-label'), 'Choose date');
  assert.equal(fields.timeButton.getAttribute('aria-controls'), 'time');
  fields.dateButton.click();
  assert.equal(dateOpens, 1);
  assert.equal(timeOpens, 0);
  assert.equal(fields.dateInput.clicks || 0, 0, 'do not follow successful showPicker with a second native click');
  fields.timeButton.click();
  assert.equal(timeOpens, 1);
  assert.equal(fields.documentRoot.activeElement, fields.timeInput);
});

test('unavailable or throwing showPicker leaves native focus/click fallback usable without retrying it', () => {
  const { dateInput, timeInput, dateButton, timeButton } = fixture();
  let attempts = 0;
  dateInput.showPicker = () => { attempts += 1; throw new Error('Picker unavailable in this browser'); };
  assert.doesNotThrow(() => dateButton.click());
  assert.equal(attempts, 1);
  assert.equal(dateInput.clicks, 1);
  assert.equal(dateInput.focuses, 1);
  assert.equal(dateButton.hidden, true, 'failed overlay gets out of the way of a genuine native tap');
  delete timeInput.showPicker;
  assert.doesNotThrow(() => timeButton.click());
  assert.equal(timeInput.clicks, 1);
  assert.equal(timeInput.focuses, 1);
});

test('a browser without showPicker retains the aligned native indicator instead of blocking it with an overlay', () => {
  const { dateInput, dateButton, timeButton, todayButton } = fixture({ showPicker: false });
  assert.equal(dateButton.hidden, true);
  assert.equal(timeButton.hidden, true);
  assert.equal(todayButton.hidden, false, 'explicit Today still works without showPicker');
  assert.equal(dateInput.disabled, false);
  assert.equal(dateInput.readOnly, false);
});

test('explicit Today changes date only, emits one native input/change pair, and does not silently submit or send', () => {
  const { dateInput, timeInput, todayButton } = fixture({ date: '2026-11-09', time: '18:37' });
  const events = [];
  dateInput.addEventListener('input', event => events.push([event.type, event.bubbles]));
  dateInput.addEventListener('change', event => events.push([event.type, event.bubbles]));
  todayButton.click();
  assert.equal(dateInput.value, '2026-11-03');
  assert.equal(timeInput.value, '18:37');
  assert.deepEqual(events, [['input', true], ['change', true]]);
  assert.equal(todayButton.getAttribute('aria-pressed'), 'true');
  todayButton.click();
  assert.equal(events.length, 2, 'choosing the already selected Today is not a second dirty change');
});

test('Today and picker triggers respect disabled and readonly inputs even for forced programmatic clicks', () => {
  for (const property of ['disabled', 'readOnly']) {
    const { dateInput, timeInput, dateButton, timeButton, todayButton, control } = fixture({ date: '2026-11-09', time: '18:37' });
    dateInput[property] = timeInput[property] = true;
    control.sync();
    assert.equal(dateButton.disabled, true);
    assert.equal(timeButton.disabled, true);
    assert.equal(todayButton.disabled, true);
    dateButton.click(); timeButton.click(); todayButton.click();
    assert.equal(dateInput.value, '2026-11-09');
    assert.equal(timeInput.value, '18:37');
    assert.equal(dateInput.focuses || 0, 0);
  }
});

test('Today honors existing date min/max and a stricter future minimum without replacing saved values', () => {
  for (const boundary of [{ min: '2026-11-05' }, { max: '2026-11-01' }]) {
    const { dateInput, todayButton } = fixture({ ...boundary, date: '2026-11-09' });
    assert.equal(todayButton.disabled, true);
    todayButton.click();
    assert.equal(dateInput.value, '2026-11-09');
  }
  const { dateInput } = fixture({ min: '2026-11-20', minToday: true });
  assert.equal(dateInput.min, '2026-11-20');
});

test('quick-create minimum uses the event zone and refreshes across midnight on picker open', () => {
  const { dateInput, dateButton, control, advance } = fixture({ minToday: true, date: '2024-01-04' });
  assert.equal(dateInput.min, '2026-11-03');
  assert.equal(dateInput.value, '2024-01-04', 'even an old restored draft is not silently rewritten');
  advance(5 * 60 * 60 * 1000);
  dateButton.click();
  assert.equal(dateInput.min, '2026-11-04');
  assert.equal(dateInput.value, '2024-01-04');
  control.destroy();
  assert.equal(dateInput.min, '', 'destroy restores helper-owned minimum');
});

test('error state appears after explicit aria-invalid or native validation, not for pristine empty required fields', () => {
  const { dateInput, control } = fixture();
  const wrapper = dateInput.parentElement;
  dateInput.validity.valid = false;
  control.sync();
  assert.equal(wrapper.classList.contains('is-invalid'), false);
  dateInput.dispatchEvent(new FakeEvent('invalid'));
  assert.equal(wrapper.classList.contains('is-invalid'), true);
  dateInput.validity.valid = true;
  dateInput.dispatchEvent(new FakeEvent('change'));
  assert.equal(wrapper.classList.contains('is-invalid'), false);
  dateInput.setAttribute('aria-invalid', 'true');
  control.sync();
  assert.equal(wrapper.classList.contains('is-invalid'), true);
});

test('destroy removes listeners, restores native-fallback buttons, and permits safe reattachment for a new event zone', () => {
  const fields = fixture({ date: '2026-11-05', time: '20:11' });
  assert.equal(controls.attach(fields), fields.control, 'repeat attach does not double-open the picker');
  fields.control.destroy();
  assert.equal(fields.dateButton.hidden, true);
  assert.equal(fields.todayButton.hidden, true);
  assert.equal(fields.dateButton.listeners.get('click').length, 0);
  assert.equal(fields.dateInput.parentElement.classList.contains('is-enhanced'), false);
  const second = controls.attach({ ...fields, timeZone: 'Asia/Tokyo' });
  assert.notEqual(second, fields.control);
  assert.equal(fields.timeZoneLabel.getAttribute('title'), 'Asia/Tokyo');
  assert.equal(fields.dateInput.value, '2026-11-05');
  assert.equal(fields.timeInput.value, '20:11');
  second.destroy();
  assert.equal(controls.attach(), null);
});

test('shared styles keep generous scoped triggers, aligned native fallback, explicit hidden states and reduced motion', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/date-time-controls.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../public/js/date-time-controls.js'), 'utf8');
  assert.match(css, /\.sge-datetime-trigger \{[\s\S]*?width: 52px;[\s\S]*?min-height: 44px;/);
  assert.match(css, /::-webkit-calendar-picker-indicator \{[\s\S]*?right: 1px;[\s\S]*?width: 52px;/);
  assert.match(css, /background-position: right 16px center/);
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition: none !important/);
  assert.match(css, /\[aria-invalid='true'\] \{ border-color: #f28b82 !important; box-shadow: [^;]+ !important;/);
  assert.doesNotMatch(css, /(?:^|\n)(?:input|button|\.sg-input|\.owner-input)\s*\{/);
  assert.doesNotMatch(js, /\b(?:fetch|XMLHttpRequest|localStorage|requestSubmit)\b|\.submit\(|\.step\s*=/);
});
