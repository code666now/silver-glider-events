'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGeoapifyWalking, GEOAPIFY_MAX_WALK_TARGETS } = require('../src/lib/transit/geoapify-walk');

const KEY = 'fake-key?not-for-logs';
const env = { GEOAPIFY_API_KEY: KEY };
const origin = { lat: 37.7552, lon: -122.4195 };
const targets = [{ lat: 37.7553, lon: -122.4187 }, { lat: 37.7561, lon: -122.4188 }];
const coords = ({ lon, lat }) => [lon, lat];
const point = input => ({ original_location: coords(input), location: coords(input) });
const cell = (target_index, time, extra = {}) => ({ source_index: 0, target_index, time, distance: 190, ...extra });
const sample = () => ({ sources: [point(origin)], targets: targets.map(point), sources_to_targets: [[cell(0, 120), cell(1, 201)]] });
const fake = data => async () => new Response(JSON.stringify(data));

test('Geoapify walking matrix posts one origin in lon/lat order and keeps provider results indexed to the candidate stop', async () => {
  const client = createGeoapifyWalking({ env, fetchImpl: async (url, req) => {
    assert.equal(url.origin, 'https://api.geoapify.com');
    assert.equal(url.pathname, '/v1/routematrix');
    assert.equal(url.searchParams.get('apiKey'), KEY);
    assert.equal(req.method, 'POST');
    assert.equal(req.redirect, 'error');
    assert.ok(req.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(req.body), {
      mode: 'walk', sources: [{ location: coords(origin) }], targets: targets.map(p => ({ location: coords(p) }))
    });
    return new Response(JSON.stringify({ ...sample(), sources_to_targets: [[cell(1, 211.3), cell(0, 91)]] }));
  } });
  assert.equal(client.configured, true);
  assert.deepEqual(await client.matrix(origin, targets), [91, 212]);
});

test('missing routes, zero durations, no-distance results, and fallback results remain unknown', async () => {
  const data = sample();
  for (const invalid of [cell(0, null, { distance: null }), cell(0, 0), cell(0, 103, { distance: null }), cell(0, 103, { fallback: true }), cell(0, '103'), cell(0, 103, { mode: 'drive' })]) {
    data.sources_to_targets[0][0] = invalid;
    assert.deepEqual(await createGeoapifyWalking({ env, fetchImpl: fake(data) }).matrix(origin, targets), [null, 201]);
  }
});

test('a provider snap across the block or an unrelated echoed point cannot prove a walk', async () => {
  const data = sample();
  data.targets[0].location[0] = targets[0].lon + .003;
  assert.deepEqual(await createGeoapifyWalking({ env, fetchImpl: fake(data) }).matrix(origin, targets), [null, 201]);
  data.sources[0].original_location[0] = origin.lon + .003;
  assert.deepEqual(await createGeoapifyWalking({ env, fetchImpl: fake(data) }).matrix(origin, targets), [null, null]);
});

test('wrong dimensions, wrong transport mode, duplicate, missing and foreign matrix indexes fail closed', async () => {
  for (const data of [
    { ...sample(), mode: 'drive' },
    { ...sample(), targets: [] },
    { ...sample(), sources_to_targets: [[cell(0, 97)]] },
    { ...sample(), sources_to_targets: [[cell(0, 97), cell(0, 109)]] },
    { ...sample(), sources_to_targets: [[cell(1, 97), cell(2, 109)]] },
    { ...sample(), sources_to_targets: [[cell(1, 97), cell(0, 109, { source_index: 1 })]] }
  ]) {
    await assert.rejects(createGeoapifyWalking({ env, fetchImpl: fake(data) }).matrix(origin, targets), { code: 'GEOAPIFY_BAD_RESPONSE' });
  }
});

test('non-JSON, provider errors, and quota responses are classified without exposing provider bodies or keys', async () => {
  const privateProviderDetails = `https://api.geoapify.com/v1/routematrix?apiKey=${KEY}`;
  for (const [status, code] of [[200, 'GEOAPIFY_BAD_RESPONSE'], [403, 'GEOAPIFY_UNAVAILABLE'], [429, 'GEOAPIFY_RATE_LIMITED']]) {
    const client = createGeoapifyWalking({ env, fetchImpl: async () => new Response(privateProviderDetails, { status }) });
    await assert.rejects(client.matrix(origin, targets), error => error.code === code &&
      !error.stack.includes(KEY) && !error.cause && !error.message.includes('https://'));
  }
  const client = createGeoapifyWalking({ env, fetchImpl: async () => { throw new Error(privateProviderDetails); } });
  await assert.rejects(client.matrix(origin, targets), error => error.code === 'GEOAPIFY_UNAVAILABLE' && !error.stack.includes(KEY));
});

test('oversized streamed walking responses are refused even without Content-Length', async () => {
  let cancelled = false;
  const client = createGeoapifyWalking({ env, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(129 * 1024)); },
    cancel() { cancelled = true; }
  })) });
  await assert.rejects(client.matrix(origin, targets), { code: 'GEOAPIFY_BAD_RESPONSE' });
  assert.equal(cancelled, true);
});

test('the walking lookup has an abort deadline and timeout errors are redacted', async () => {
  const client = createGeoapifyWalking({ env, timeoutMs: 5, fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error(KEY)), { once: true });
  }) });
  // Node's AbortSignal deadline does not keep the process alive on its own.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(client.matrix(origin, targets), error => error.code === 'GEOAPIFY_UNAVAILABLE' && !error.stack.includes(KEY));
  } finally {
    clearTimeout(keepAlive);
  }
});

test('unconfigured, over-limit and invalid coordinates never make a billable request', async () => {
  const fetchImpl = async () => assert.fail('Unexpected external request');
  const noKey = createGeoapifyWalking({ env: {}, fetchImpl });
  assert.equal(noKey.configured, false);
  assert.deepEqual(await noKey.matrix(origin, []), []);
  await assert.rejects(noKey.matrix(origin, targets), { code: 'GEOAPIFY_UNCONFIGURED' });
  const client = createGeoapifyWalking({ env, fetchImpl });
  for (const args of [
    [origin, Array(GEOAPIFY_MAX_WALK_TARGETS + 1).fill(targets[0])],
    [origin, Array(2)],
    [origin, [{ lat: '37.7552', lon: -122.4195 }]],
    [{ lat: 91, lon: -122.4195 }, targets]
  ]) {
    await assert.rejects(client.matrix(...args), { code: 'GEOAPIFY_INVALID_LOCATIONS' });
  }
});
