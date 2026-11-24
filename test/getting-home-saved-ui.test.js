'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mount, savePayload, savedTitle } = require('../public/js/getting-home-saved');

const route = Object.freeze({ stopId: 'sf:22', routeId: 'sf:33', direction: '0', headsign: 'Ashbury' });
const alternate = Object.freeze({ ...route, stopId: 'sf:23', direction: '1', headsign: 'Richmond' });
const rail = Object.freeze({ stationId: 'BA:24TH', destinationStationId: 'BA:ANTC' });
const details = (selection, status = 'scheduled') => ({ selection, plan: { status } });
const saved = (selection = route) => ({ status: 'available', selection, routeLabel: '33', stopLabel: 'Mission & 22nd', directionLabel: selection.headsign });
const next = () => new Promise(resolve => setImmediate(resolve));

function setup(respond) {
  const element = () => ({
    hidden: true, textContent: '', checked: true, disabled: false, listeners: {},
    focus() { this.focused = true; },
    click() { this.clicked = true; this.listeners.click?.(); },
    addEventListener(name, callback) { this.listeners[name] = callback; }
  });
  const els = new Map();
  const root = {
    listeners: {}, events: [],
    addEventListener(name, callback) { this.listeners[name] = callback; },
    querySelector(selector) {
      if (!els.has(selector)) els.set(selector, element());
      return els.get(selector);
    },
    dispatchEvent(event) { this.events.push(event); this.listeners[event.type]?.(event); }
  };
  const calls = [];
  const win = {
    location: { pathname: '/e/demo/getting-home' },
    CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
    async fetch(url, options) {
      assert.equal(url, '/api/public/events/demo/getting-home/saved-route');
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.cache, 'no-store');
      calls.push(options);
      const record = await respond(options.method || 'GET');
      return { ok: !record.error, json: async () => record };
    }
  };
  const el = name => root.querySelector(`#gh-${name}`);
  mount(root, win);
  return { calls, el, events: root.events,
    choose: detail => root.dispatchEvent(new win.CustomEvent('getting-home:plan', { detail })),
    check() { el('remember-check').checked = true; el('remember-check').listeners.change(); } };
}

test('a route preference is only the exact chosen stop/direction or rail connection, never consent to a text', () => {
  for (const remember of [undefined, false, 'true']) assert.equal(savePayload(details(route), remember), null);
  assert.equal(savePayload(details(route, 'no-service'), true), null);
  assert.equal(savePayload(details({ ...route, headsign: 'wrong\0' }), true), null);
  assert.equal(savePayload(details({ stationId: 'BA:24TH', destinationStationId: 'BA:24TH' }), true), null);
  assert.deepEqual(savePayload({ ...details({ ...route, phone: '123', consent: true }), proposedReminderAt: 30 }, true), { remember: true, selection: route });
  assert.deepEqual(savePayload(details(rail, 'overnight'), true), { remember: true, selection: rail });
  assert.equal(savedTitle('33'), 'Taking the 33 again?');
  assert.equal(savedTitle('Muni 33'), 'Taking Muni 33 again?');
  assert.equal(savedTitle('BART'), 'Taking BART again?');
});

test('checking a saved route dispatches the selection only; nothing is written or scheduled', async () => {
  const ui = setup(() => saved());
  await next();
  assert.equal(ui.el('saved').hidden, false);
  assert.equal(ui.el('saved-title').textContent, 'Taking the 33 again?');
  assert.equal(ui.el('saved-details').textContent, 'Mission & 22nd · Ashbury');
  ui.el('saved-use').click();
  assert.deepEqual(ui.events.map(({ type, detail }) => [type, detail]), [['getting-home:choose-saved', route]]);
  assert.equal(ui.calls.length, 1);
  ui.choose(details(route));
  assert.equal(ui.el('remember').hidden, true);
  ui.el('plan').hidden = false;
  ui.el('saved-change').click();
  assert.equal(ui.el('change').clicked, true);
  assert.equal(ui.el('routes-title').focused, true);
  assert.equal(ui.calls.length, 1);
});

test('remembering requires a fresh deliberate checkbox plus save and updates the card once', async () => {
  const ui = setup(method => method === 'POST' ? saved(alternate) : { status: 'none' });
  await next();
  ui.choose(details(route));
  assert.equal(ui.el('remember').hidden, false);
  assert.equal(ui.el('remember-check').checked, false);
  assert.equal(ui.el('remember-save').disabled, true);
  ui.el('remember-save').click();
  assert.equal(ui.calls.length, 1);
  ui.check();
  assert.equal(ui.el('remember-save').disabled, false);
  ui.choose(details(alternate));
  assert.equal(ui.el('remember-check').checked, false);
  ui.check();
  ui.el('remember-save').click();
  ui.el('remember-save').click();
  await next();
  assert.equal(ui.calls.length, 2);
  assert.equal(ui.calls[1].method, 'POST');
  assert.deepEqual(JSON.parse(ui.calls[1].body), { remember: true, selection: alternate });
  assert.equal(ui.el('remember').hidden, true);
  assert.match(ui.el('saved-details').textContent, /Richmond/);
  assert.match(ui.el('saved-status').textContent, /did not schedule a text/);
  assert.equal(ui.el('saved-title').focused, true);
});

test('unverified or failed saved routes show no trip details, but an existing stale preference can be removed', async () => {
  for (const record of [{ status: 'unavailable' }, { status: 'not-eligible', hasPreference: true }]) {
    const ui = setup(() => record);
    await next();
    ui.choose(details(route));
    assert.equal(ui.el('remember').hidden, true);
    assert.equal(ui.el('saved').hidden, true);
    assert.equal(ui.calls.length, 1);
  }
  const stale = setup(method => method === 'DELETE' ? { status: 'removed' }
    : { ...saved(), status: 'unavailable', hasPreference: true });
  await next();
  assert.equal(stale.el('saved').hidden, false);
  assert.equal(stale.el('saved-use').hidden, true);
  assert.equal(stale.el('saved-remove').hidden, false);
  assert.doesNotMatch(stale.el('saved-details').textContent, /Mission|Ashbury/);
  stale.el('saved-remove').click();
  await next();
  assert.equal(stale.calls[1].method, 'DELETE');
  assert.equal(stale.calls[1].body, '{}');
  assert.equal(stale.el('saved').hidden, true);
  assert.equal(stale.el('routes-title').focused, true);
  assert.match(stale.el('saved-status').textContent, /Any ride text already set is unchanged/);
});

test('clearing or failing a route check resets the unchecked offer without hiding transit', async () => {
  const ui = setup(() => ({ status: 'none' }));
  await next();
  ui.choose(details(route));
  ui.check();
  ui.choose(null);
  assert.equal(ui.el('remember').hidden, true);
  assert.equal(ui.el('remember-check').checked, false);
  assert.equal(ui.calls.length, 1);
  ui.choose(details(route, 'schedule-unavailable'));
  assert.equal(ui.el('remember').hidden, true);
});
