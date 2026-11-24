'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { formattedTime, makeRouteChoices, makeRideshareLinks } = require('../public/js/getting-home');
const view = readFileSync(join(__dirname, '../src/views/getting-home.html'), 'utf8');

test('Getting Home groups buses by route/direction across verified boarding stops', () => {
  const muni = { routeId: '14', name: '14 Mission', agency: 'Muni', direction: '0', headsign: 'Downtown' };
  const choices = makeRouteChoices([
    { stopId: 'a', name: 'Mission & 20th', walkSeconds: 350, routes: [muni] },
    { stopId: 'b', name: 'Mission & 22nd', walkSeconds: 95, routes: [muni, { ...muni, direction: '1', headsign: 'Daly City' }] }
  ]);
  assert.equal(choices.length, 1);
  assert.equal(choices[0].closest.stopId, 'b');
  assert.equal(choices[0].label, 'Muni 14 Mission');
  assert.equal(choices[0].icon, 'bus');
  assert.deepEqual(choices[0].directions.map(direction => [direction.label, direction.stops.map(stop => stop.stopId)]), [
    ['Downtown', ['b', 'a']], ['Daly City', ['b']]
  ]);
});

test('BART combines train lines/platforms at each station and keeps the destinations', () => {
  const bart = { routeId: 'red', name: 'Red', requiresDestination: true };
  const station = { stationId: '24', name: '24th St / Mission', walkSeconds: 360 };
  const destinations = [{ stationId: 'deln', name: 'El Cerrito del Norte', latitude: 37.93, longitude: -122.317 }];
  const choices = makeRouteChoices([
    { ...station, stopId: 'nb', routes: [bart], destinations },
    { ...station, stopId: 'sb', routes: [{ ...bart, routeId: 'blue' }], destinations }
  ]);
  assert.equal(choices.length, 1);
  assert.equal(choices[0].icon, 'train');
  assert.deepEqual(choices[0].stations.map(stop => stop.stationId), ['24']);
  assert.deepEqual(choices[0].destinations, destinations);
});

test('departure, leave-by and text preview use the supplied local date even after midnight', () => {
  assert.equal(formattedTime(Date.parse('2026-11-28T08:47:00Z'), 'America/Los_Angeles'), 'Sat, Nov 28 · 12:47 AM PST');
  assert.equal(formattedTime(Date.parse('2026-11-28T09:41:00Z'), 'America/Los_Angeles'), 'Sat, Nov 28 · 1:41 AM PST');
  assert.equal(formattedTime(null, 'America/Los_Angeles'), '');
  assert.equal(formattedTime(Date.parse('2026-11-28T09:41:00Z'), 'invalid'), '');
});

test('rideshare links use known providers and only prefill a valid public destination', () => {
  const defaultLinks = makeRideshareLinks(null);
  assert.equal(defaultLinks.uber, 'https://m.uber.com/looking');
  assert.equal(defaultLinks.lyft, 'https://ride.lyft.com/u');
  assert.equal(makeRideshareLinks({ latitude: '', longitude: 0, name: 'Invalid' }).prefilled, false);
  const links = makeRideshareLinks({ latitude: 37.93, longitude: -122.317, name: 'A & B Public Station' });
  assert.equal(links.prefilled, true);
  const uber = new URL(links.uber);
  const lyft = new URL(links.lyft);
  assert.equal(uber.origin, 'https://m.uber.com');
  assert.deepEqual(JSON.parse(uber.searchParams.get('drop[0]')), {
    latitude: 37.93, longitude: -122.317, addressLine1: 'A & B Public Station'
  });
  assert.equal(lyft.origin, 'https://ride.lyft.com');
  assert.equal(lyft.searchParams.get('destination[longitude]'), '-122.317');
});

test('transit preview is optional, announces status and is not an SMS form', () => {
  assert.match(view, /gh-status" role="status" aria-live="polite"/);
  assert.match(view, /for="gh-direction"/);
  assert.match(view, /for="gh-destination"/);
  assert.match(view, /30 minutes before you need to leave\. No text is scheduled\./);
  assert.match(view, /name="referrer" content="no-referrer"/);
  assert.doesNotMatch(view, /type="tel"|send text|early bird/i);
});
