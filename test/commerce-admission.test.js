const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ADMISSION_TYPES,
  isExternalTickets,
  isSilverGliderTickets,
  normalizeAdmissionType
} = require('../src/lib/admission');
const { CommerceClient, CommerceClientError } = require('../src/lib/commerce-client');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('admission values normalize legacy paid events without changing their stored rows', () => {
  assert.equal(normalizeAdmissionType('paid'), ADMISSION_TYPES.EXTERNAL_TICKETS);
  assert.equal(normalizeAdmissionType('external_tickets'), ADMISSION_TYPES.EXTERNAL_TICKETS);
  assert.equal(isExternalTickets({ admission_type: 'paid' }), true);
  assert.equal(isSilverGliderTickets({ admission_type: 'silver_glider_tickets' }), true);
  assert.equal(normalizeAdmissionType('invented'), null);
});

test('Commerce migration is additive, keeps legacy paid valid, and never stores sales truth', () => {
  const migration = read('src/db/migrations/024_commerce_admission_types.sql');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS commerce_event_id TEXT/);
  for (const value of ['free_rsvp', 'paid', 'donation', 'door', 'vip', 'external_tickets', 'silver_glider_tickets']) {
    assert.match(migration, new RegExp(`'${value}'`));
  }
  assert.match(migration, /UNIQUE INDEX[\s\S]*commerce_event_id[\s\S]*WHERE commerce_event_id IS NOT NULL/i);
  assert.doesNotMatch(migration, /ADD COLUMN[^;]*(inventory|order_id|ticket_id|stripe|payment|refund|payout)/i);
});

test('event editor presents three admission choices and gates unfinished Commerce setup', () => {
  const html = read('src/views/event-form.html');
  const js = read('public/js/event-form.js');
  assert.match(html, /id="admission-free"[\s\S]*Free RSVP/);
  assert.match(html, /id="admission-free"[\s\S]*id="admission-paid"[\s\S]*id="admission-commerce"/, 'Commerce should be the third admission option');
  assert.match(html, /id="admission-commerce"[^>]*disabled[\s\S]*Sell with Silver Glider[\s\S]*Coming soon/);
  assert.match(html, /id="admission-paid"[\s\S]*External tickets/);
  assert.match(js, /api\('\/api\/commerce\/config'\)/);
  assert.match(js, /admission-commerce-status'\)\.hidden = commerceEnabled/);
  assert.match(js, /commerce_event_id: admissionType === 'silver_glider_tickets'/);
  assert.match(js, /ticket_price: admissionType === 'external_tickets'/);
});

test('public and organizer routes keep Commerce separate from RSVP and duplication', () => {
  const publicRoute = read('src/routes/public.js');
  const eventRoute = read('src/routes/events.js');
  assert.match(publicRoute, /router\.get\('\/e\/:slug\/tickets'/);
  assert.match(publicRoute, /error: 'tickets_required'/);
  assert.match(publicRoute, /Get Tickets/);
  assert.match(eventRoute, /artwork_accent_color, commerce_event_id\)/);
  assert.match(eventRoute, /\$37,NULL\)/, 'duplicates must not copy a Commerce event reference');
  assert.doesNotMatch(`${publicRoute}\n${eventRoute}`, /stripe|payment_intent|checkout\.sessions/i);
});

test('Commerce client keeps credentials server-side and normalizes responses', async () => {
  let request;
  const client = new CommerceClient({
    baseUrl: 'https://commerce.example.test/api',
    apiKey: 'service-secret',
    timeoutMs: 2000,
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  });
  const result = await client.request('/events/example', {
    method: 'POST',
    body: { eventId: 'example' },
    idempotencyKey: 'request-1'
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(request.url, 'https://commerce.example.test/api/events/example');
  assert.equal(request.options.headers.Authorization, 'Bearer service-secret');
  assert.equal(request.options.headers['Idempotency-Key'], 'request-1');
  assert.equal(request.options.body, JSON.stringify({ eventId: 'example' }));
});

test('Commerce client rejects unconfigured and cross-origin destinations safely', async () => {
  const unconfigured = new CommerceClient({ fetchImpl: async () => assert.fail('fetch should not run') });
  await assert.rejects(unconfigured.request('/events'), err => {
    assert.ok(err instanceof CommerceClientError);
    assert.equal(err.code, 'commerce_not_configured');
    return true;
  });

  const configured = new CommerceClient({
    baseUrl: 'https://commerce.example.test',
    apiKey: 'secret',
    fetchImpl: async () => assert.fail('fetch should not run')
  });
  await assert.rejects(configured.request('https://evil.example/steal'), err => {
    assert.equal(err.code, 'invalid_commerce_destination');
    return true;
  });
});
