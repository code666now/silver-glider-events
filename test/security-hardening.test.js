const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createRateLimiter } = require('../src/lib/rate-limit');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('shared dashboard renderer escapes HTML and rejects executable URLs', () => {
  const apiSource = source('public/js/api.js');
  const helpers = apiSource.slice(0, apiSource.indexOf('function renderNav'));
  const context = {
    URL,
    location: { origin: 'https://silvergliderevents.com' },
    result: null
  };
  const attack = '<img src=x onerror="alert(1)">\'&';
  vm.runInNewContext(`${helpers}\nresult = {
    escaped: sgEscapeHtml(${JSON.stringify(attack)}),
    unsafe: sgSafeHttpUrl('javascript:alert(1)'),
    safe: sgSafeHttpUrl('https://res.cloudinary.com/demo/image.jpg')
  };`, context);

  assert.equal(context.result.escaped, '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#039;&amp;');
  assert.equal(context.result.unsafe, '');
  assert.equal(context.result.safe, 'https://res.cloudinary.com/demo/image.jpg');
});

test('host-controlled dashboard and admin fields use safe rendering helpers', () => {
  const dashboard = source('src/views/dashboard.html');
  const events = source('src/views/events.html');
  const line = source('src/views/admin-line.html');
  const feedback = source('src/views/admin-feedback.html');

  for (const value of ['title', 'venue_name']) {
    assert.match(dashboard, new RegExp(`sgEscapeHtml\\(ev\\.${value}\\)|sgEscapeHtml\\(title\\)`));
    assert.match(events, new RegExp(`sgEscapeHtml\\(ev\\.${value}\\)|sgEscapeHtml\\(title\\)`));
  }
  assert.match(dashboard, /sgSafeHttpUrl\(ev\.cover_image_url\)/);
  assert.match(events, /sgSafeHttpUrl\(ev\.cover_image_url\)/);
  assert.match(line, /sgEscapeHtml\(s\.title\)/);
  assert.match(line, /sgEscapeHtml\(s\.venue_name\)/);
  assert.match(line, /sgEscapeHtml\(host\)/);
  assert.match(feedback, /sgSafeHttpUrl\(feedback\.page_url\)/);
  assert.doesNotMatch(line, />\$\{s\.title\}<\/a>/);
  assert.doesNotMatch(feedback, /href="\$\{esc\(feedback\.page_url\)\}"/);
});

test('sliding-window limiter blocks repeated attempts without blocking other keys', () => {
  let timestamp = 1_000;
  const limiter = createRateLimiter({
    windowMs: 60_000,
    now: () => timestamp,
    rules: [{ name: 'email', max: 2, key: context => context.email }]
  });

  assert.equal(limiter.consume({ email: 'one@example.com' }).allowed, true);
  assert.equal(limiter.consume({ email: 'one@example.com' }).allowed, true);
  const blocked = limiter.consume({ email: 'one@example.com' });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  assert.equal(limiter.consume({ email: 'two@example.com' }).allowed, true);

  timestamp += 60_001;
  assert.equal(limiter.consume({ email: 'one@example.com' }).allowed, true);
});

test('public RSVP route rate-limits submissions and atomically cools down email resends', () => {
  const publicRoute = source('src/routes/public.js');
  assert.match(publicRoute, /router\.post\('\/api\/public\/events\/:slug\/rsvp', protectRsvp,/);
  assert.match(publicRoute, /name: 'ip-event', max: 8/);
  assert.match(publicRoute, /name: 'email-event', max: 4/);
  assert.match(publicRoute, /status\(429\)/);
  assert.match(publicRoute, /ON CONFLICT \(rsvp_id, message_type, channel\)/);
  assert.match(publicRoute, /COALESCE\(message_log\.sent_at, message_log\.created_at\) < NOW\(\) - INTERVAL '15 minutes'/);
  assert.match(publicRoute, /if \(!rows\.length\) return false/);
});
