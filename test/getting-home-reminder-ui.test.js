'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { mount, schedulePayload, reminderTime } = require('../public/js/getting-home-reminder');

const view = fs.readFileSync(path.join(__dirname, '../src/views/getting-home.html'), 'utf8');
const reminderAt = Date.parse('2026-12-12T08:35:00Z');
const detail = {
  selection: { stationId: 'BA:24TH', destinationStationId: 'BA:ANTC' },
  plan: { status: 'scheduled', timing: 'scheduled', proposedReminderAt: reminderAt, timezone: 'America/Los_Angeles' }
};
const st = (status, other = {}) => ({ status, ...other });
const next = () => new Promise(resolve => setImmediate(resolve));

function setup(respond) {
  const element = () => ({
    hidden: true, textContent: '', checked: false, listeners: {},
    setAttribute() {}, removeAttribute() {}, focus() { this.focused = true; },
    addEventListener(name, callback) { this.listeners[name] = callback; }
  });
  const els = new Map();
  const root = {
    listeners: {},
    addEventListener(name, callback) { this.listeners[name] = callback; },
    querySelector(selector) {
      if (!els.has(selector)) els.set(selector, element());
      return els.get(selector);
    }
  };
  const calls = [];
  const win = {
    location: { pathname: '/e/demo/getting-home' },
    async fetch(url, options) {
      assert.equal(url, '/api/public/events/demo/getting-home/reminder');
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.cache, 'no-store');
      calls.push(options);
      const record = await respond(options.method || 'GET');
      return { ok: !record.error, json: async () => record };
    }
  };
  mount(root, win);
  return {
    calls, el: name => root.querySelector(`#gh-reminder-${name}`),
    select: plan => root.listeners['getting-home:plan']({ detail: plan }),
    submit: () => root.querySelector('#gh-reminder-form').listeners.submit({ preventDefault() {} }),
    cancel: () => root.querySelector('#gh-reminder-cancel').listeners.click()
  };
}

test('ride text form is initially hidden, opt-in is unchecked and no phone is collected', () => {
  assert.match(view, /id="gh-reminder-offer"[^>]*hidden/);
  assert.match(view, /id="gh-reminder-form" hidden/);
  assert.match(view, /id="gh-reminder-consent" type="checkbox" required/);
  assert.doesNotMatch(view, /id="gh-reminder-consent"[^>]*\bchecked\b|type="tel"/);
  assert.match(view, /one reminder for this event/);
  assert.match(view, /No marketing texts/);
  assert.match(view, /id="gh-reminder-announcement" role="status" aria-live="polite"/);
});

test('only an explicit checked consent for an exact verified timetable creates a request', () => {
  assert.equal(schedulePayload(detail, false), null);
  assert.equal(schedulePayload(detail, 'true'), null);
  assert.equal(schedulePayload({ ...detail, plan: { ...detail.plan, timing: 'feed-estimate' } }, true), null);
  assert.equal(schedulePayload({ ...detail, plan: { ...detail.plan, proposedReminderAt: null } }, true), null);
  assert.deepEqual(schedulePayload(detail, true), { consent: true, expectedReminderAt: reminderAt, selection: detail.selection });
  assert.match(reminderTime(reminderAt), /Sat, Dec 12, 12:35 AM PST/);
});

test('disabled and sign-in-needed states do not prompt for a phone or send a request', async () => {
  const disabled = setup(() => st('unavailable'));
  await next();
  disabled.select(detail);
  assert.equal(disabled.el('offer').hidden, true);
  assert.equal(disabled.el('form').hidden, true);
  assert.equal(disabled.calls.length, 1);

  const identity = setup(() => st('identity-required'));
  await next();
  identity.select(detail);
  assert.equal(identity.el('offer').hidden, false);
  assert.equal(identity.el('form').hidden, true);
  assert.equal(identity.el('signin').href, '/login?next=%2Fe%2Fdemo%2Fgetting-home');
  assert.match(identity.el('requirement').textContent, /existing account/i);
});

test('changing routes clears consent, submitting makes one request and management survives plan changes', async () => {
  const pending = st('pending', { canCancel: true, reminderAt });
  let current = st('available', { canRequest: true });
  const ui = setup(method => {
    if (method === 'POST') current = pending;
    if (method === 'DELETE') current = st('cancelled', { canRequest: true });
    return current;
  });
  await next();
  ui.select(detail);
  assert.equal(ui.el('form').hidden, false);
  ui.el('consent').checked = true;
  ui.select(detail);
  assert.equal(ui.el('consent').checked, false);
  ui.submit();
  assert.equal(ui.calls.length, 1);
  ui.el('consent').checked = true;
  ui.submit();
  ui.submit();
  await next();
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 1);
  assert.deepEqual(JSON.parse(ui.calls[1].body), schedulePayload(detail, true));
  assert.equal(ui.el('title').focused, true);
  ui.select(null);
  assert.equal(ui.el('management').hidden, false);
  assert.equal(ui.el('cancel').hidden, false);
  assert.match(ui.el('description').textContent, /Checking a different route/);
  ui.cancel();
  await next();
  assert.ok(ui.calls.some(call => call.method === 'DELETE' && call.body === '{}'));
  assert.equal(ui.el('cancel').hidden, true);
  assert.equal(ui.el('title').textContent, 'Ride text canceled');
});

test('an already-pending ride can be canceled without checking a route again', async () => {
  const ui = setup(() => st('pending', { canCancel: true, reminderAt }));
  await next();
  assert.equal(ui.el('cancel').hidden, false);
  assert.equal(ui.el('management').hidden, false);
  assert.equal(ui.el('form').hidden, true);
});
