'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmailVisitTracker, formattedTime, makeRouteChoices, makeRideshareLinks, mapsDirections, matchSavedChoice, mount, requestDeadline, upcomingRows } = require('../public/js/getting-home');
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
  assert.equal(matchSavedChoice(choices, { stationId: '24', destinationStationId: 'deln' }).stop, 0);
  assert.equal(matchSavedChoice(choices, { stationId: '24', destinationStationId: 'missing' }), null);
});

test('saved selections only use the exact route, direction and verified stop', () => {
  const route = { routeId: '33', direction: '0', headsign: 'Richmond' };
  const choices = makeRouteChoices([{ stopId: 'a', name: 'Mission', walkSeconds: 120, routes: [route, { ...route, direction: '1' }] }]);
  const result = matchSavedChoice(choices, { ...route, direction: '1', stopId: 'a' });
  assert.equal(result.direction, 1);
  assert.equal(result.stop, 0);
  assert.equal(matchSavedChoice(choices, { ...route, stopId: 'wrong' }), null);
});

test('only an authoritative GTFS bus mode marks a route tile as a countable bus', () => {
  const stop = { stopId: 'a', stationId: '24', name: 'Mission', walkSeconds: 120 };
  const [bus, rail, bart, unknown] = makeRouteChoices([{ ...stop, routes: [
    { routeId: 'bus', name: '14', mode: 'bus' },
    { routeId: 'rail', name: '99', mode: 'rail' },
    { routeId: 'bart', name: 'Red', mode: 'rail', requiresDestination: true },
    { routeId: 'old', name: 'Older route' }
  ] }]);
  assert.equal(bus.bus, true);
  assert.equal(rail.bus, false);
  assert.equal(bart.bus, false);
  assert.equal(unknown.bus, false);
});

test('departure, leave-by and text preview use the supplied local date even after midnight', () => {
  assert.equal(formattedTime(Date.parse('2026-11-28T08:47:00Z'), 'America/Los_Angeles'), 'Sat, Nov 28 · 12:47 AM PST');
  assert.equal(formattedTime(Date.parse('2026-11-28T09:41:00Z'), 'America/Los_Angeles'), 'Sat, Nov 28 · 1:41 AM PST');
  assert.equal(formattedTime(null, 'America/Los_Angeles'), '');
  assert.equal(formattedTime(Date.parse('2026-11-28T09:41:00Z'), 'invalid'), '');
});

test('an email visit requires authorized available options and records only once when visible', () => {
  const document = new EventTarget();
  document.visibilityState = 'visible';
  const kinds = [];
  const track = createEmailVisitTracker(document, kind => kinds.push(kind));
  track({ status: 'available' });
  track({ status: 'available', emailEntry: 'true' });
  track({ status: 'schedule-unavailable', emailEntry: true });
  assert.deepEqual(kinds, []);
  track({ status: 'available', emailEntry: true });
  track({ status: 'available', emailEntry: true });
  document.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(kinds, ['email_link_open']);
});

test('a planner opened in a hidden tab does not count until the guest can see it', () => {
  const document = new EventTarget();
  document.visibilityState = 'hidden';
  const kinds = [];
  const track = createEmailVisitTracker(document, kind => kinds.push(kind));
  track({ status: 'available', emailEntry: true });
  track({ status: 'available', emailEntry: true });
  document.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(kinds, []);
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  document.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(kinds, ['email_link_open']);
});

test('mobile planner shows next departures, last / leave-by, then rideshare in document order', () => {
  assert.match(view, /id="gh-upcoming" aria-labelledby="gh-upcoming-title" hidden[\s\S]*Last bus tonight[\s\S]*Leave the venue by[\s\S]*Prefer rideshare\?/);
  assert.match(view, /<ol id="gh-upcoming-times" role="list" hidden>/);
  assert.match(view, /<button[^>]*id="gh-check"[^>]*>Check departures<\/button>/);
  assert.match(view, /id="gh-change-stop"[^>]*aria-expanded="false" aria-controls="gh-stop-field">Change stop/);
  assert.match(view, /id="gh-stop-field" hidden/);
  const css = readFileSync(join(__dirname, '../public/css/getting-home.css'), 'utf8');
  assert.match(css, /@media \(max-width: 539px\)[^}]*\.gh-field select\s*{[^}]*width: calc\(100% \+ 12px\)[^}]*height: max\(54px, 3em\)/);
});

test('upcoming restores and marks the last bus if it is one of the two reachable rides', () => {
  const first = Date.parse('2026-11-28T08:47:00Z');
  const last = Date.parse('2026-11-28T09:41:00Z');
  const plan = { timezone: 'America/Los_Angeles', departureAt: last, timing: 'schedule',
    upcoming: { includesLast: true, departures: [{ departureAt: first, timing: 'feed-estimate' }] } };
  assert.deepEqual(upcomingRows(plan), [
    { label: 'Sat, Nov 28 · 12:47 AM PST', estimated: true, alsoLast: false },
    { label: 'Sat, Nov 28 · 1:41 AM PST', estimated: false, alsoLast: true }
  ]);
  assert.equal(upcomingRows({ ...plan, upcoming: { includesLast: true, departures: [] } })[0].alsoLast, true);
  assert.equal(upcomingRows({ ...plan, upcoming: { includesLast: true, departures: [{ departureAt: last }] } }).length, 1);
  assert.deepEqual(upcomingRows({ ...plan, upcoming: { includesLast: false, departures: [] } }), []);
  assert.deepEqual(upcomingRows({ ...plan, upcoming: null }), []);
  assert.deepEqual(upcomingRows({ ...plan, timezone: 'invalid' }), []);
});

test('pending lookups give slow feedback, time out honestly, and clear obsolete timers', () => {
  const pending = new Map();
  const fakeWin = {
    setTimeout(callback, delay) { pending.set(delay, callback); return delay; },
    clearTimeout(delay) { pending.delete(delay); }
  };
  const controller = new AbortController();
  let slow = 0;
  const timers = requestDeadline(fakeWin, controller, { slowMs: 6, timeoutMs: 20, onSlow: () => { slow++; } });
  assert.equal(timers.timedOut, false);
  assert.equal(controller.signal.aborted, false);
  pending.get(6)();
  assert.equal(slow, 1);
  assert.equal(controller.signal.aborted, false);
  pending.get(20)();
  assert.equal(timers.timedOut, true);
  assert.equal(controller.signal.aborted, true);
  timers.clear();
  assert.equal(pending.size, 0);
  const css = readFileSync(join(__dirname, '../public/css/getting-home.css'), 'utf8');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]+animation: none/);
  assert.match(view, /data-loading>Finding nearby buses and trains…/);
  assert.match(view, /id="gh-retry-departure" hidden>Try again/);
});

test('tester directions only use a verified Google Maps target', () => {
  assert.equal(mapsDirections('https://maps.google.com/?q=Kilowatt'), 'https://maps.google.com/?q=Kilowatt');
  assert.equal(mapsDirections('https://www.google.com/maps/search/?query=Kilowatt'), 'https://www.google.com/maps/search/?query=Kilowatt');
  assert.equal(mapsDirections('https://www.google.com/redirect?next=elsewhere'), null);
  assert.equal(mapsDirections('https://maps.google.com.attacker.test/?q=Kilowatt'), null);
  assert.equal(mapsDirections('javascript:alert(1)'), null);
});

class PlannerNode extends EventTarget {
  constructor({ hidden = false, fragment = false } = {}) {
    super();
    this.attrs = new Map();
    this.children = [];
    this.textContent = '';
    this.value = '';
    this.hidden = hidden;
    this.fragment = fragment;
  }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name); }
  removeAttribute(name) { this.attrs.delete(name); }
  toggleAttribute(name, visible) { if (visible) this.setAttribute(name, ''); else this.removeAttribute(name); }
  append(...nodes) { this.children.push(...nodes.flatMap(node => node.fragment ? node.children : [node])); }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
    this.value = (this.children.find(node => node.selected) || this.children[0])?.value ?? '';
  }
  focus() { this.focused = true; }
}

test('shared tester mounts real controls, uses the nearest stop, and shows checking and results without tracking', async () => {
  const nodes = Object.fromEntries([...view.matchAll(/id="gh-([^"]+)"([^>]+|)>/g)].map(([, id, attributes]) =>
    [id, new PlannerNode({ hidden: /(?:^|\s)hidden\b/.test(attributes) })]));
  const root = new PlannerNode();
  root.querySelector = selector => nodes[selector.slice(4)];
  const linkText = new PlannerNode();
  nodes['event-link'].querySelector = () => linkText;
  const routeButton = new PlannerNode();
  const routeBits = { strong: new PlannerNode(), '.gh-route-copy span': new PlannerNode(), use: new PlannerNode() };
  routeButton.querySelector = selector => routeBits[selector];
  nodes['route-template'].content = { cloneNode() {
    const item = new PlannerNode({ fragment: true });
    item.querySelector = () => routeButton;
    return item;
  } };
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    createDocumentFragment: () => new PlannerNode({ fragment: true }),
    createElement: () => new PlannerNode()
  });
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  const win = {
    location: { pathname: '/admin/transportation/venue-test/plan' },
    document, CustomEvent, AbortController,
    Option: function (label, value, _defaultSelected, selected) { Object.assign(this, { label, value, selected }); },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(key) { timers.delete(key); },
    fetch(url, init) {
      return new Promise(resolve => { requests.push({ url, init, resolve: data => resolve({ ok: true, json: async () => data }) }); });
    }
  };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const muni = { routeId: '49', name: '49', agency: 'Muni', direction: '0', headsign: 'North Beach', mode: 'bus' };
  mount(root, win);
  assert.match(nodes.status.textContent, /Finding nearby/);
  assert.equal(nodes.status.getAttribute('data-loading'), '');
  assert.equal(requests[0].url, '/api/admin/transportation/venue-test/options');
  requests[0].resolve({ status: 'available', venue: 'Kilowatt', tester: true, emailEntry: true,
    directionsUrl: 'https://maps.google.com/?q=Kilowatt', stops: [
      { stopId: 'far', name: 'Further stop', walkSeconds: 305, routes: [muni] },
      { stopId: 'near', name: 'Closest stop', walkSeconds: 140, routes: [muni] }
    ] });
  await flush();
  assert.equal(nodes.heading.textContent, 'Getting home from Kilowatt');
  assert.equal(nodes.status.getAttribute('data-loading'), undefined);
  assert.equal(linkText.textContent, 'Test another venue');
  assert.equal(nodes['directions'].href, 'https://maps.google.com/?q=Kilowatt');
  assert.equal(nodes['route-picker'].hidden, false);
  routeButton.dispatchEvent(new Event('click'));
  assert.match(nodes['stop-picked'].textContent, /Closest stop/);
  assert.equal(nodes['stop-field'].hidden, true);
  nodes['change-stop'].dispatchEvent(new Event('click'));
  assert.equal(nodes['stop-field'].hidden, false);
  nodes.form.dispatchEvent(new Event('submit', { cancelable: true }));
  assert.equal(nodes.check.textContent, 'Checking departures…');
  assert.equal(nodes.form.getAttribute('aria-busy'), 'true');
  assert.deepEqual(JSON.parse(requests[1].init.body), { stopId: 'near', routeId: '49', direction: '0', headsign: 'North Beach' });
  assert.equal(requests[1].url, '/api/admin/transportation/venue-test/departure');
  const last = Date.parse('2026-11-28T09:41:00Z');
  requests[1].resolve({ status: 'scheduled', departureAt: last, leaveByAt: last - 8 * 60 * 1000,
    timezone: 'America/Los_Angeles', upcoming: { includesLast: true, departures: [] }, stopName: 'Closest stop' });
  await flush();
  assert.equal(nodes.check.textContent, 'Check departures');
  assert.equal(nodes.form.getAttribute('aria-busy'), undefined);
  assert.equal(nodes['upcoming-title'].textContent, 'Next buses if you leave now');
  assert.match(nodes['upcoming-note'].textContent, /Only one reachable scheduled bus/);
  assert.ok(nodes['upcoming-times'].children[0].children.some(node => node.textContent === 'Also the last bus'));
  assert.equal(nodes['results-title'].textContent, 'Last bus tonight');
  assert.match(nodes['leave-time'].textContent, /1:33 AM/);
  assert.equal(timers.size, 0);
  assert.equal(requests.length, 2, 'tester interactions and displayed options do not record any metric');
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
  assert.match(view, /Choose a route to see scheduled departures and when to leave\./);
  assert.match(view, /id="gh-preview-row" hidden/);
  assert.match(view, /id="gh-reminder-offer"[^>]* hidden/);
  assert.match(view, /30 minutes before you need to leave\. No text is scheduled\./);
  assert.match(view, /name="referrer" content="no-referrer"/);
  assert.doesNotMatch(view, /type="tel"|send text|early bird/i);
});
