process.env.SESSION_SECRET ||= 'guest-return-unit-test-only';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
const safeUrl = value => {
  try {
    if (!value) return '';
    const url = new URL(value, 'https://example.test');
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch (_) { return ''; }
};

function browserContext(responses) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML:'', textContent:'', hidden:false, dataset:{}, style:{}, attrs:{},
      classList:{
        added:[], removed:[],
        remove(...names) { this.removed.push(...names); },
        add(...names) { this.added.push(...names); }
      },
      setAttribute(key, value) { this.attrs[key] = value; },
      removeAttribute(key) { delete this.attrs[key]; }
    });
    return elements.get(id);
  };
  const calls = [];
  const context = {
    Date, Intl, URL, console, renderNav() {}, sgEscapeHtml:escape, sgSafeHttpUrl:safeUrl,
    window:{ matchMedia:() => ({ matches:false, addEventListener() {} }) },
    document:{
      getElementById:get, querySelector:get, querySelectorAll:() => [],
      body:{ classList:{ remove() {} } }
    },
    async api(url) {
      calls.push(url);
      const result = responses[url];
      if (result instanceof Error) throw result;
      if (result === undefined) throw new Error(`Unexpected API call ${url}`);
      return result;
    }
  };
  return { context:vm.createContext(context), get, calls };
}

async function runView(file, responses) {
  const browser = browserContext(responses);
  const inline = [...read(file).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');
  await vm.runInContext(inline, browser.context, { filename:file });
  return browser;
}

function event(overrides = {}) {
  return {
    id:10, slug:'guest-night', title:'Guest Night', event_date:'2035-06-01', start_time:'20:30',
    starts_at:'2035-06-02T03:30:00Z', ends_at:'2035-06-02T05:30:00Z',
    timezone:'America/Los_Angeles', status:'published', venue_name:'Test Hall',
    host_name:'Test Host', cover_image_url:'https://example.test/art.jpg', ...overrides
  };
}

function homeResponses(hosted = [], plans = []) {
  return { '/api/auth/me':{ organizer:{ name:'Adrian Test' } }, '/api/events':{ events:hosted }, '/api/events/going':{ events:plans } };
}

test('guest Home reuses Going and offers an RSVP and scoped directions without leaking personal tokens', async () => {
  const browser = await runView('src/views/dashboard.html', homeResponses([], [event()]));
  const markup = browser.get('next-event').innerHTML;
  assert.match(markup, /Guest Night/);
  assert.match(markup, />Going</);
  assert.match(markup, /8:30 PM/);
  assert.match(markup, /href="\/e\/guest-night#returning-rsvp-state">View RSVP/);
  assert.match(markup, /href="\/e\/guest-night#event-location-map">Get directions/);
  assert.doesNotMatch(markup, /manage_token|token=|maps\.google|\/events\/10\/manage/);
  assert.equal(browser.get('sub').textContent, 'Your next night.');
  assert.equal(browser.get('.dashboard-overview').hidden, true);
  assert.ok(browser.get('dashboard-create').classList.removed.includes('sg-btn-primary'));
  assert.ok(browser.get('dashboard-create').classList.added.includes('sg-btn-ghost'));
  assert.equal(browser.get('dashboard-my-events').href, '/events?view=going');
  assert.equal(browser.get('dashboard-view-all').href, '/events?view=going');
  assert.match(read('src/views/dashboard.html'), /\.next-plan \.next-details h2 \{ white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere/);
  assert.equal(browser.get('next-event').attrs['aria-busy'], 'false');
  assert.deepEqual(browser.calls, ['/api/auth/me','/api/events','/api/events/going']);
});

test('mixed-role Home selects the earliest plan but keeps owner counts and management access', async () => {
  const hosted = event({ id:20, title:'Hosting Later', starts_at:'2035-07-01T03:30:00Z', ends_at:'2035-07-01T05:30:00Z', rsvp_count:7 });
  const browser = await runView('src/views/dashboard.html', homeResponses([hosted], [event()]));
  assert.match(browser.get('next-event').innerHTML, /Guest Night/);
  assert.equal(browser.get('upcoming-count').textContent, '1');
  assert.equal(browser.get('rsvp-count').textContent, '7');
  assert.ok(!browser.get('dashboard-create').classList.removed.includes('sg-btn-primary'), 'mixed-role hosts keep their Create Event action');
  assert.match(read('src/views/dashboard.html'), /href="\/events">My Events/);
  const owner = await runView('src/views/dashboard.html', homeResponses([hosted], [hosted]));
  assert.match(owner.get('next-event').innerHTML, /href="\/events\/20\/manage"/);
  assert.doesNotMatch(owner.get('next-event').innerHTML, /View RSVP/);
});

test('playing nights remain accessible and cancelled or ended plans do not replace the next event', async () => {
  const browser = await runView('src/views/dashboard.html', homeResponses([], [
    event({ id:1, title:'Cancelled', status:'cancelled' }),
    event({ id:2, title:'Already Ended', ends_at:'2000-01-01T00:00:00Z' }),
    event({ id:3, title:'Playing Tonight', playing:true })
  ]));
  assert.match(browser.get('next-event').innerHTML, /Playing Tonight/);
  assert.match(browser.get('next-event').innerHTML, />Playing</);
  assert.doesNotMatch(browser.get('next-event').innerHTML, /Cancelled|Already Ended/);
});

test('Home keeps an in-progress overnight plan and safely escapes guest-facing event fields', async () => {
  const browser = await runView('src/views/dashboard.html', homeResponses([], [event({
    title:'<script>bad()</script>', venue_name:'<img onerror=bad()>', host_name:'<b>Host</b>',
    cover_image_url:'javascript:bad()', starts_at:'2000-01-01T00:00:00Z', ends_at:'2099-01-01T00:00:00Z'
  })]));
  const markup = browser.get('next-event').innerHTML;
  assert.match(markup, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(markup, /&lt;img onerror=bad\(\)&gt;/);
  assert.doesNotMatch(markup, /<script>|<img onerror|javascript:/);
});

test('Home distinguishes no plans from a failed request rather than inventing empty counts', async () => {
  const empty = await runView('src/views/dashboard.html', homeResponses());
  assert.match(empty.get('next-event').innerHTML, /No upcoming plans yet/);
  assert.match(empty.get('next-event').innerHTML, /href="\/following"/);
  const failure = homeResponses();
  failure['/api/events/going'] = new Error('Unavailable');
  const failed = await runView('src/views/dashboard.html', failure);
  assert.match(failed.get('next-event').innerHTML, /role="alert"/);
  assert.match(failed.get('next-event').innerHTML, /Try again/);
  assert.equal(failed.get('upcoming-count').textContent, '—');
});

test('Following renders event artwork, local date/time, safe links and existing host preference access', async () => {
  const browser = await runView('src/views/following.html', { '/api/following':{
    hosts:[{ org_name:'Test Host', public_slug:'test-host', upcoming_count:1 }],
    events:[event({ title:'<b>Show</b>', host_name:'<i>Host</i>', cover_image_url:'javascript:bad()' })]
  } });
  const markup = browser.get('following-events').innerHTML;
  assert.match(markup, /&lt;b&gt;Show&lt;\/b&gt;/);
  assert.match(markup, /8:30 PM/);
  assert.match(markup, /Los Angeles time/);
  assert.match(markup, /href="\/e\/guest-night"/);
  assert.doesNotMatch(markup, /javascript:|<b>Show|<i>Host/);
  assert.match(browser.get('following-list').innerHTML, /href="\/h\/test-host"/);
  assert.equal(browser.get('following-events').attrs['aria-busy'], 'false');
});

test('Following settles distinct empty, no upcoming events and failed-request states', async () => {
  const empty = await runView('src/views/following.html', { '/api/following':{ hosts:[],events:[] } });
  assert.equal(empty.get('following-empty').hidden, false);
  assert.equal(empty.get('following-events-heading').hidden, true);
  const quiet = await runView('src/views/following.html', { '/api/following':{
    hosts:[{ org_name:'Quiet Host',public_slug:'quiet-host',upcoming_count:0 }],events:[]
  } });
  assert.equal(quiet.get('following-events-empty').hidden, false);
  assert.match(quiet.get('following-list').innerHTML, /Quiet Host/);
  const failure = await runView('src/views/following.html', { '/api/following':new Error('database detail must stay private') });
  assert.match(failure.get('following-list').innerHTML, /role="alert"/);
  assert.doesNotMatch(failure.get('following-list').innerHTML, /database detail/);
});

test('Following API scopes both bounded chronological queries to the authenticated account and no-store', async () => {
  const pool = require('../src/config/db');
  const route = require('../src/routes/follows').stack.find(layer => layer.route?.path === '/api/following').route;
  const handle = route.stack[route.stack.length - 1].handle;
  const original = pool.query;
  const calls = [];
  const headers = {};
  let payload;
  pool.query = async (sql, values) => {
    calls.push({ sql, values });
    return { rows:sql.includes('COUNT(e.id)') ? [{ org_name:'Test Host' }] : [{ title:'Public Show' }] };
  };
  try {
    await handle({ organizer:{ id:42 },query:{ organizerId:99 } }, {
      setHeader(key,value) { headers[key] = value; }, json(value) { payload = value; }
    }, error => { throw error; });
  } finally { pool.query = original; }
  assert.equal(calls.length, 2);
  for (const { sql,values } of calls) {
    assert.deepEqual(values, [42]);
    assert.match(sql, /hf\.follower_organizer_id=\$1/);
    assert.match(sql, /hf\.unsubscribed_at IS NULL/);
    assert.match(sql, /e\.status='published' AND e\.visibility='public'/);
    assert.match(sql, /e\.secret_show_enabled=FALSE/);
    assert.match(sql, /host_account\.account_status='active'/);
    assert.match(sql, /AT TIME ZONE e\.timezone[\s\S]*> NOW\(\)/);
  }
  assert.match(calls[1].sql, /ORDER BY starts_at ASC,e\.id ASC\s+LIMIT 60/);
  assert.doesNotMatch(calls[1].sql, /venue_address|manage_token|email|phone/);
  assert.equal(headers['Cache-Control'], 'private, no-store');
  assert.deepEqual(payload, { hosts:[{ org_name:'Test Host' }],events:[{ title:'Public Show' }] });
});
