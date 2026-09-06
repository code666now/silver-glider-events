const test = require('node:test');
const assert = require('node:assert/strict');

const LocationUtils = require('../public/js/location-utils');

test('business Places results preserve the business name and full address', () => {
  const result = LocationUtils.recordForPlace({
    name: 'Make-Out Room',
    formatted_address: '3225 22nd St, San Francisco, CA 94110, USA',
    types: ['bar', 'establishment', 'point_of_interest']
  });

  assert.deepEqual(result, {
    addressOnly: false,
    venueName: 'Make-Out Room',
    venueAddress: '3225 22nd St, San Francisco, CA 94110, USA'
  });
  assert.equal(LocationUtils.locationQuery(result.venueName, result.venueAddress), 'Make-Out Room, 3225 22nd St, San Francisco, CA 94110, USA');
});

test('street-address Places results use the address without requiring a location name', () => {
  const result = LocationUtils.recordForPlace({
    name: '346 Corbett Ave',
    formatted_address: '346 Corbett Ave, San Francisco, CA 94114, USA',
    types: ['street_address']
  });

  assert.equal(result.addressOnly, true);
  assert.equal(result.venueName, '346 Corbett Ave');
  assert.equal(result.venueAddress, '346 Corbett Ave, San Francisco, CA 94114, USA');
  assert.deepEqual(LocationUtils.displayParts(result.venueName, result.venueAddress), {
    name: '346 Corbett Ave, San Francisco, CA 94114, USA',
    address: ''
  });
  assert.equal(LocationUtils.locationQuery(result.venueName, result.venueAddress), result.venueAddress);
});

test('an optional friendly name is retained for an address-only location', () => {
  const result = LocationUtils.recordForPlace({
    name: '346 Corbett Ave',
    formatted_address: '346 Corbett Ave, San Francisco, CA 94114, USA',
    types: ['premise']
  }, { locationName: 'Adrian’s place' });

  assert.equal(result.venueName, 'Adrian’s place');
  assert.deepEqual(LocationUtils.displayParts(result.venueName, result.venueAddress), {
    name: 'Adrian’s place',
    address: '346 Corbett Ave, San Francisco, CA 94114, USA'
  });
});

test('legacy duplicate address values render and link only once', () => {
  const name = '346 Corbett Ave';
  const address = '346 Corbett Ave, San Francisco, CA 94114, USA';

  assert.equal(LocationUtils.isAddressFallback(name, address), true);
  assert.equal(LocationUtils.locationQuery(name, address), address);
  assert.equal(LocationUtils.isAddressFallback('The Midway', address), false);
});
