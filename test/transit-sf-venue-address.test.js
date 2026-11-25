'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSfAddressResolver, selectedSfVenue } = require('../src/lib/transit/sf-venue-address');

const event = {
  status: 'published', visibility: 'public', secret_show_enabled: false, hide_address_until_rsvp: false,
  timezone: 'America/Los_Angeles', google_place_id: 'synthetic-selected-place',
  venue_city: 'San Francisco', venue_state: 'CA', venue_latitude: 37.75, venue_longitude: -122.415,
  venue_address: '3225 22nd St, San Francisco, CA 94110, USA'
};
const row = {
  address: '3225 22ND ST', zip_code: '94110', latitude: '37.755191533084364',
  longitude: '-122.41952096665861', supervisor: '9'
};
const reply = rows => new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } });

test('selected public SF venues normalize equivalent addresses without putting the Places pin in the routing input', () => {
  const selection = selectedSfVenue(event);
  assert.deepEqual(Object.keys(selection).sort(), ['address', 'key', 'zipCode']);
  assert.match(selection.key, /^[a-f0-9]{64}$/);
  assert.equal(selection.address, '3225 22ND ST');
  assert.equal(selection.zipCode, '94110');
  assert.deepEqual(selectedSfVenue({
    ...event, venue_address: '  3225  22nd street., san francisco, california 94110-1234, U.S.A. ',
    venue_latitude: 37.76, venue_longitude: -122.42
  }), selection);
  assert.notEqual(selectedSfVenue({ ...event, google_place_id: 'another-place' }).key, selection.key);
  assert.notEqual(selectedSfVenue({ ...event, venue_address: '3227 22nd St, San Francisco, CA 94110' }).key, selection.key);
  assert.notEqual(selectedSfVenue({ ...event, venue_address: '3225 22nd St, San Francisco, CA 94103' }).key, selection.key);
});

test('the selected address and saved locality must agree; never prepare manual, private, incomplete, or non-SF events', () => {
  for (const changes of [
    { status: 'draft' }, { status: 'cancelled' }, { visibility: 'private' }, { secret_show_enabled: true },
    { hide_address_until_rsvp: true }, { timezone: 'UTC' }, { venue_city: 'South San Francisco' },
    { venue_city: '' }, { venue_state: 'WA' }, { google_place_id: null }, { google_place_id: 'invalid/id' },
    { venue_latitude: null }, { venue_latitude: true }, { venue_longitude: ' ' }, { venue_longitude: -181 },
    { venue_latitude: NaN }, { venue_latitude: 0, venue_longitude: 0 }, { venue_address: '' },
    { venue_address: '3225 22nd St, Oakland, CA 94110, USA' },
    { venue_address: '3225 22nd St, San Francisco, NY 94110, USA' },
    { venue_address: '3225 22nd St, San Francisco, CA 95610, USA' },
    { venue_address: '3225 22nd St, San Francisco, CA 94110, Canada' },
    { venue_address: '3225 22nd St, San Francisco, CA 94110, ...' },
    { venue_address: 'Make-Out Room, San Francisco, CA' },
    { venue_address: '22nd St, San Francisco, CA 94110' },
    { venue_address: '3225-3227 22nd St, San Francisco, CA 94110' },
    { venue_address: '3225 22nd St #2, San Francisco, CA 94110' },
    { venue_address: '3225 22nd St & Mission St, San Francisco, CA 94110' },
    { venue_address: '3225 22nd St\n, San Francisco, CA 94110' }
  ]) assert.equal(selectedSfVenue({ ...event, ...changes }), null, JSON.stringify(changes));
  assert.equal(selectedSfVenue(null), null);
});

test('street type and leading-zero normalization match the DataSF base address; shorter streets still need Places metadata', () => {
  assert.equal(selectedSfVenue({ ...event, venue_address: '25 1st Street, San Francisco, CA' }).address, '25 01ST ST');
  assert.equal(selectedSfVenue({ ...event, venue_address: '25 01st St, San Francisco, CA' }).address, '25 01ST ST');
  assert.equal(selectedSfVenue({ ...event, venue_address: '1 Avenue of the Palms' }).address, '1 AVENUE OF THE PALMS');
  assert.equal(selectedSfVenue({ ...event, venue_address: '1 Avenue of the Palms' }).zipCode, null);
  assert.equal(selectedSfVenue({ ...event, venue_address: '1 Avenue of the Palms', google_place_id: null }), null);
});

test('DataSF lookup filters one literal street address and returns only the official point', async () => {
  const resolver = createSfAddressResolver({ fetchImpl: async (url, options) => {
    assert.equal(url.origin, 'https://data.sf.gov');
    assert.equal(url.pathname, '/resource/3mea-di5p.json');
    assert.equal(url.searchParams.get('address'), row.address);
    assert.equal(url.searchParams.get('$limit'), '2');
    assert.equal(url.searchParams.get('$select'), 'address,zip_code,latitude,longitude,supervisor');
    assert.equal(url.searchParams.has('$where'), false);
    assert.equal(url.href.includes(event.google_place_id), false);
    assert.equal(url.href.includes(String(event.venue_longitude)), false);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return reply([row]);
  } });
  assert.deepEqual(await resolver(selectedSfVenue(event)), { lat: 37.755191533084364, lon: -122.41952096665861 });
});

test('strict DataSF lookup fails closed on no match, duplicate points, wrong address or ZIP, and unverified geometry', async () => {
  const selection = selectedSfVenue(event);
  for (const rows of [
    [], [row, { ...row, latitude: '37.7501' }], [row, row], [null],
    [{ ...row, address: '3227 22ND ST' }], [{ ...row, zip_code: '94103' }],
    [{ ...row, supervisor: '0' }], [{ ...row, supervisor: null }], [{ ...row, longitude: null }],
    [{ ...row, latitude: 'not-a-coordinate' }], [{ ...row, latitude: '37.44', longitude: '-122.43' }]
  ]) {
    const resolver = createSfAddressResolver({ fetchImpl: async () => reply(rows) });
    assert.equal(await resolver(selection), null, JSON.stringify(rows));
  }
});

test('invalid resolver input never reaches the provider; provider errors are redacted', async () => {
  const neverFetch = createSfAddressResolver({ fetchImpl: async () => assert.fail('unexpected provider call') });
  assert.equal(await neverFetch(null), null);
  assert.equal(await neverFetch({ address: '3225 22ND ST', zipCode: 'bad' }), null);
  assert.equal(await neverFetch({ address: '3225 22ND ST&$where=other' }), null);

  const selection = selectedSfVenue(event);
  for (const fetchImpl of [
    async () => { throw new Error('raw provider request URL and address'); },
    async () => new Response('private upstream response', { status: 429 }),
    async () => new Response('not json'),
    async () => reply({ error: 'upstream shape changed' }),
    async () => new Response('x'.repeat(4097)),
    async () => new Response('[]', { headers: { 'content-length': '4097' } })
  ]) await assert.rejects(createSfAddressResolver({ fetchImpl })(selection), {
    code: 'SF_ADDRESS_UNAVAILABLE', message: 'San Francisco address data is unavailable.'
  });
});
