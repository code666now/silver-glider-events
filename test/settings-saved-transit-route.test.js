'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const source = read('public/js/settings.js');
const controller = source.slice(source.indexOf('function createSavedTransitRouteControl'), source.indexOf('const loadSavedTransitRoute = '));
const create = vm.runInNewContext(`${controller}; createSavedTransitRouteControl`);

function fixture(respond) {
  const row = { hidden: true };
  const status = { hidden: true, textContent: '', focus() { this.focused = true; } };
  const button = { disabled: false, addEventListener(name, handler) { this[name] = handler; } };
  const requests = [];
  const request = async (url, options) => {
    assert.equal(url, '/api/account/saved-transit-route');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    requests.push(options);
    const data = await respond(options.method || 'GET');
    return { ok: !data.error, json: async () => data };
  };
  const load = create({ row, button, status, request });
  return { row, button, status, requests, load };
}

test('saved travel can be removed privately through one hidden-by-default Account action', () => {
  const view = read('src/views/settings-v2.html');
  const account = view.slice(view.indexOf('id="settings-account"'), view.indexOf('id="settings-messaging"'));
  assert.match(account, /id="account-saved-transit" hidden/);
  assert.match(account, /type="button" id="account-saved-transit-clear"[^>]*>Clear saved transit route</);
  assert.match(account, /id="account-saved-transit-status" role="status" aria-live="polite"/);
  assert.match(account, /Any ride text already set is unchanged/);
  assert.doesNotMatch(view.slice(view.indexOf('id="settings-messaging"')), /account-saved-transit/);
  assert.match(source, /if \(desktopSettingsSection === 'account'\) loadSavedTransitRoute\(\)/);
});

test('the control stays hidden unless the account actually has a saved route', async () => {
  for (const state of [{ status: 'available', hasPreference: false }, { status: 'available', hasPreference: 'true' },
    { status: 'unavailable', hasPreference: true }, { status: 'available', hasPreference: true, error: true }]) {
    const settings = fixture(() => state);
    await settings.load();
    await settings.button.click();
    assert.equal(settings.row.hidden, true);
    assert.equal(settings.status.hidden, true);
    assert.equal(settings.requests.length, 1);
  }
});

test('clearing sends one empty same-origin DELETE, reveals no route details and does not touch a ride reminder', async () => {
  let finish;
  const remove = new Promise(resolve => { finish = resolve; });
  const settings = fixture(method => method === 'DELETE' ? remove
    : { status: 'available', hasPreference: true, route: 'private unexpected data' });
  await settings.load();
  assert.equal(settings.row.hidden, false);
  const pending = settings.button.click();
  await settings.button.click();
  assert.equal(settings.requests.length, 2);
  assert.equal(settings.requests[1].method, 'DELETE');
  assert.equal(settings.requests[1].body, '{}');
  assert.equal(settings.requests[1].headers['Content-Type'], 'application/json');
  assert.equal(settings.button.disabled, true);
  finish({ status: 'removed', route: 'private termination response' });
  await pending;
  assert.equal(settings.row.hidden, true);
  assert.equal(settings.status.focused, true);
  assert.equal(settings.status.textContent, 'Saved route cleared. Any ride text already set is unchanged.');
});

test('an uncertain removal leaves the button retryable without exposing internal errors', async () => {
  const settings = fixture(method => method === 'DELETE' ? { status: 'unavailable', error: 'internal detail' }
    : { status: 'available', hasPreference: true });
  await settings.load();
  await settings.button.click();
  assert.equal(settings.row.hidden, false);
  assert.equal(settings.button.disabled, false);
  assert.match(settings.status.textContent, /couldn’t confirm/i);
  assert.doesNotMatch(settings.status.textContent, /internal detail/);
});
