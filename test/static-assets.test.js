const test = require('node:test');
const assert = require('node:assert/strict');
const {
  markVersionedAssetRequest,
  setStaticCacheHeaders,
  versionAssetUrls,
  versionHtmlResponses
} = require('../src/lib/static-assets');

test('versions local browser assets without changing navigation or external URLs', () => {
  const html = `<!DOCTYPE html><html><head>
    <link rel="stylesheet" href="/css/main.css">
    <link rel="icon" href="/favicon.png?theme=dark#icon">
    <script src="/js/public-event.js?v=already"></script>
    <script src="https://cdn.example.test/app.js"></script>
  </head><body><a href="/events">Events</a><img src="/images/flyer-plaster-wall.webp"></body></html>`;
  const versioned = versionAssetUrls(html, '1.2.3');

  assert.match(versioned, /href="\/css\/main\.css\?v=1\.2\.3"/);
  assert.match(versioned, /href="\/favicon\.png\?theme=dark&v=1\.2\.3#icon"/);
  assert.match(versioned, /src="\/js\/public-event\.js\?v=already"/);
  assert.match(versioned, /src="\/images\/flyer-plaster-wall\.webp\?v=1\.2\.3"/);
  assert.match(versioned, /src="https:\/\/cdn\.example\.test\/app\.js"/);
  assert.match(versioned, /href="\/events"/);
});

test('versions full HTML responses but leaves JSON strings untouched', () => {
  const sent = [];
  const res = { send(body) { sent.push(body); return body; } };
  versionHtmlResponses('4.5.6')({}, res, () => {});

  res.send('<!doctype html><html><script src="/js/public-event.js"></script></html>');
  res.send('{"asset":"/js/public-event.js"}');

  assert.match(sent[0], /\/js\/public-event\.js\?v=4\.5\.6/);
  assert.equal(sent[1], '{"asset":"/js/public-event.js"}');
});

test('gives current versioned assets immutable caching and legacy URLs a short cache', () => {
  const makeResponse = () => ({
    locals: {},
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  });

  const current = makeResponse();
  markVersionedAssetRequest('1.2.3')({ query: { v: '1.2.3' } }, current, () => {});
  setStaticCacheHeaders(current);
  assert.equal(current.headers['cache-control'], 'public, max-age=31536000, immutable');

  const legacy = makeResponse();
  markVersionedAssetRequest('1.2.3')({ query: {} }, legacy, () => {});
  setStaticCacheHeaders(legacy);
  assert.equal(legacy.headers['cache-control'], 'public, max-age=3600');
});
