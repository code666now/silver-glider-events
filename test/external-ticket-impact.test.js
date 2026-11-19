const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { externalTicketLink, validTicketUrl } = require('../src/lib/ticket-links');
const { loadExternalTicketImpact, recordExternalTicketClick, ticketVisitorSlot } = require('../src/lib/external-ticket-impact');

const eventLink = ticket_url => externalTicketLink({ admission_type: 'external_tickets', ticket_url });
const sampleKey = '0123456789abcdef0123456789abcdef';
const browserScript = fs.readFileSync(path.join(__dirname, '..', 'public/js/external-ticket-clicks.js'), 'utf8');

test('external seller labels recognize verified destinations, not text or hostile lookalikes', () => {
  for (const url of ['https://DICE.FM/event/show', 'https://link.dice.fm/show']) {
    assert.equal(eventLink(url).sellerLabel, 'Tickets sold on DICE');
  }
  for (const url of ['https://www.eventbrite.com/e/show', 'https://your-show.eventbrite.com/']) {
    assert.equal(eventLink(url).sellerLabel, 'Tickets sold on Eventbrite');
  }
  for (const url of [
    'https://eventbrite.com.example.com/e/show', 'https://notdice.fm/e/show', 'https://dice.fm:8443/event/show',
    'https://tickets.example/show?site=https://eventbrite.com', 'https://dice.example/show#dice.fm'
  ]) {
    assert.equal(eventLink(url).sellerLabel, 'Tickets sold on an external site');
  }
  for (const url of ['', 'somewhere.com', '//example.com', 'javascript:alert(1)', 'https://dice.fm@nope.example']) {
    assert.equal(eventLink(url), null);
    assert.equal(validTicketUrl(url), null);
  }
  assert.equal(externalTicketLink({ admission_type: 'silver_glider_tickets', ticket_url: 'https://dice.fm/' }), null);
});

test('ticket impact reads owner-scoped aggregates and distinguishes unavailable tracking from measured zero', async () => {
  const records = [
    undefined,
    { admission_type: 'external_tickets', ticket_url: 'https://dice.fm/event/sample', tracking_available: false },
    { admission_type: 'external_tickets', tracking_available: true },
    { admission_type: 'external_tickets', ticket_url: 'https://dice.fm/event/sample', tracking_available: true },
    { admission_type: 'free_rsvp', total_clicks: '3', unique_clicks: 2 }
  ];
  const db = { query: async (sql, params) => {
    assert.match(sql, /WHERE e\.id=\$1 AND e\.organizer_id=\$2/);
    assert.deepEqual(params, [7, 3, '088_external_ticket_clicks.sql']);
    return { rows: [records.shift()] };
  } };
  for (const [totalTicketClicks, uniqueTicketClicks] of [[null, null], [null, null], [null, null], [0, 0], [3, 2]]) {
    assert.deepEqual(await loadExternalTicketImpact(db, { eventId: 7, organizerId: 3 }), { totalTicketClicks, uniqueTicketClicks });
  }
});

test('server calculates a stable event-specific slot and sends no browser key to storage', async () => {
  const slot = ticketVisitorSlot(5, sampleKey);
  assert.ok(Number.isInteger(slot) && slot >= 0 && slot <= 65535);
  assert.equal(slot, ticketVisitorSlot(5, sampleKey));
  assert.notEqual(slot, ticketVisitorSlot(6, sampleKey));
  assert.equal(ticketVisitorSlot(5, 'invalid'), null);
  let calls = 0;
  const event = { id: 5, admission_type: 'external_tickets', ticket_url: 'https://dice.fm/event/sample',
    secret_show_enabled: false, secret_show_version: 0 };
  const db = { query: async (sql, values) => {
    calls++;
    assert.match(sql, /ON CONFLICT \(event_id\) DO UPDATE/);
    assert.match(sql, /ticket_url=\$3/);
    assert.match(sql, /get_bit\(external_ticket_clicks\.visitor_slots/);
    assert.match(sql, /INSERT INTO external_ticket_clicks \(event_id,total_clicks,unique_clicks,visitor_slots\)/);
    assert.deepEqual(values, [5, slot, event.ticket_url, 'external_tickets', false, 0]);
    return { rowCount: 1 };
  } };
  assert.equal(await recordExternalTicketClick(db, event, 'invalid'), false);
  assert.equal(await recordExternalTicketClick(db, { ...event, ticket_url: null }, sampleKey), false);
  assert.equal(await recordExternalTicketClick(db, event, sampleKey), true);
  assert.equal(calls, 1);
});

function browserHarness({ navigator = {}, offline = false, sharedStorage = new Map(), state = { rand: 0 } } = {}) {
  const listeners = new Map();
  const requests = [];
  const storage = {
    get length() { return sharedStorage.size; },
    key: index => [...sharedStorage.keys()][index] || null,
    getItem: name => sharedStorage.get(name) ?? null,
    setItem: (name, value) => sharedStorage.set(name, value),
    removeItem: name => sharedStorage.delete(name)
  };
  vm.runInNewContext(browserScript, {
    document: { addEventListener: (kind, listener) => listeners.set(kind, listener) },
    navigator,
    window: { localStorage: storage, crypto: { getRandomValues: bytes => bytes.fill(++state.rand) } },
    fetch: (url, options) => { requests.push({ url, options }); return offline ? Promise.reject(new Error('offline')) : Promise.resolve(); }
  });
  return { requests, click({ family = 'click', eventId = '5', overrides = {} } = {}) {
    const target = { closest: () => ({ href: 'https://dice.fm/event/sample?pass=private', dataset: {
      externalTicketClick: '/api/public/events/test-night/external-ticket-click', externalTicketEvent: eventId
    } }) };
    listeners.get(family)({ type: family, button: family === 'click' ? 0 : 1, isTrusted: true, target, ...overrides,
      preventDefault() { assert.fail('analytics cannot prevent navigation'); } });
  } };
}

test('desktop/mobile, keyboard-style and middle-button activation share an event key without delaying navigation', () => {
  const sharedStorage = new Map([['sge.ticket-browser.v1.88', JSON.stringify({ key: sampleKey, expiresAt: 1 })], ['unrelated', 'unchanged']]);
  const state = { rand: 0 };
  const browser = browserHarness({ sharedStorage, state, offline: true });
  assert.equal(browser.requests.length, 0, 'rendering alone does not make a request');
  browser.click();
  browser.click({ overrides: { detail: 0 } });
  browser.click({ family: 'auxclick' });
  assert.equal(browser.requests.length, 3);
  const browserKeys = browser.requests.map(({ url, options }) => {
    assert.equal(url, '/api/public/events/test-night/external-ticket-click');
    assert.equal(options.keepalive, true);
    assert.equal(options.referrerPolicy, 'no-referrer');
    const payload = JSON.parse(options.body);
    assert.deepEqual(Object.keys(payload), ['browserKey']);
    return payload.browserKey;
  });
  assert.equal(new Set(browserKeys).size, 1);
  assert.equal(sharedStorage.has('sge.ticket-browser.v1.88'), false);
  assert.equal(sharedStorage.get('unrelated'), 'unchanged');
  const afterReload = browserHarness({ sharedStorage, state });
  afterReload.click();
  afterReload.click({ eventId: '6' });
  assert.equal(JSON.parse(afterReload.requests[0].options.body).browserKey, browserKeys[0]);
  assert.notEqual(JSON.parse(afterReload.requests[1].options.body).browserKey, browserKeys[0]);
});

test('privacy preferences and non-navigation interactions do not send click analytics', () => {
  for (const navigator of [{ globalPrivacyControl: true }, { doNotTrack: '1' }]) {
    const browser = browserHarness({ navigator });
    browser.click();
    assert.equal(browser.requests.length, 0);
  }
  const browser = browserHarness();
  for (const overrides of [{ isTrusted: false }, { defaultPrevented: true }, { button: 2 }, { target: null }]) {
    browser.click({ overrides });
  }
  assert.equal(browser.requests.length, 0);
});
