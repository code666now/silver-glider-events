const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public/js/api.js'), 'utf8')
  .split('let sgAdminSessionPromise')[0];

function client({ pathname = '/events/42/manage', search = '?tab=guests', hash = '#invite', status = 403,
  data = { error: 'legal_acceptance_required', redirect: 'https://untrusted.example/' } } = {}) {
  const navigations = [];
  const requests = [];
  const location = { pathname, search, hash, assign: value => navigations.push(value) };
  const context = vm.createContext({ location, window: { location }, fetch: async (...args) => {
    requests.push(args);
    return { status, ok: status >= 200 && status < 300, json: async () => data };
  } });
  vm.runInContext(`${source}\nthis.callApi = api;`, context);
  return { call: context.callApi, requests, navigations };
}

test('legal-required API response preserves the actual page and never replays its mutation', async () => {
  const ui = client();
  await assert.rejects(ui.call('/api/events/42/publish', { method: 'POST', body: {} }), error =>
    error.code === 'legal_acceptance_required' && error.status === 403);
  assert.deepEqual(ui.navigations, ['/account/review?next=%2Fevents%2F42%2Fmanage%3Ftab%3Dguests%23invite']);
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0][1].method, 'POST');
});

test('unrelated API rejection does not send the account through review', async () => {
  const ui = client({ data: { error: 'forbidden' } });
  await assert.rejects(ui.call('/api/events/42'), error => error.code === 'forbidden');
  assert.deepEqual(ui.navigations, []);
});

test('optional account-menu artwork cannot interrupt public browsing or recovery', async () => {
  const ui = client({ pathname: '/settings/account' });
  await assert.rejects(ui.call('/api/events', { redirectOnLegalReview: false }));
  assert.deepEqual(ui.navigations, []);
  assert.equal(Object.hasOwn(ui.requests[0][1], 'redirectOnLegalReview'), false);
  const settings = fs.readFileSync(path.join(__dirname, '..', 'public/js/settings.js'), 'utf8');
  assert.match(settings, /if \(!legalAcceptance\?\.required\) \{[\s\S]*?loadSmsCredits\(\)/);
});

test('dedicated admin realm never uses the customer acceptance redirect', async () => {
  const ui = client({ pathname: '/admin/accounts' });
  await assert.rejects(ui.call('/api/admin/accounts'));
  assert.deepEqual(ui.navigations, []);
});

test('successful account responses remain unchanged', async () => {
  const ui = client({ status: 200, data: { ok: true } });
  assert.deepEqual(await ui.call('/api/auth/me'), { ok: true });
  assert.deepEqual(ui.navigations, []);
});
