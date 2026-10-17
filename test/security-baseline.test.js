const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'security-baseline-unit-secret';

const securityHeaders = require('../src/middleware/securityHeaders');
const { sameOriginMutation } = require('../src/middleware/requireOrganizer');

function request(headers = {}, protocol = 'https') {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    protocol,
    get(name) { return normalized[String(name).toLowerCase()]; }
  };
}

test('baseline security headers protect app responses without exposing Express', () => {
  const headers = new Map();
  let continued = false;
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    securityHeaders({}, {
      setHeader(name, value) { headers.set(name.toLowerCase(), value); }
    }, () => { continued = true; });
  } finally {
    process.env.NODE_ENV = previousEnvironment;
  }

  assert.equal(continued, true);
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(headers.get('permissions-policy'), /camera=\(\)/);
  assert.equal(headers.get('strict-transport-security'), 'max-age=31536000');
  assert.match(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8'),
    /app\.disable\('x-powered-by'\)/
  );
});

test('organizer mutations allow same-origin browsers and reject cross-site browsers', () => {
  const previousAppUrl = process.env.APP_URL;
  process.env.APP_URL = 'https://silvergliderevents.com';
  try {
    assert.equal(sameOriginMutation(request({ 'sec-fetch-site': 'same-origin' })), true);
    assert.equal(sameOriginMutation(request({ 'sec-fetch-site': 'cross-site' })), false);
    assert.equal(sameOriginMutation(request({ origin: 'https://silvergliderevents.com', host: 'silvergliderevents.com' })), true);
    assert.equal(sameOriginMutation(request({ origin: 'https://attacker.example', host: 'silvergliderevents.com' })), false);
    assert.equal(sameOriginMutation(request({ origin: 'not a URL', host: 'silvergliderevents.com' })), false);
  } finally {
    process.env.APP_URL = previousAppUrl;
  }
});
