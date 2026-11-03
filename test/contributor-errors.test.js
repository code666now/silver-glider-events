const test = require('node:test');
const assert = require('node:assert/strict');
const errorHandler = require('../src/middleware/errorHandler');

const paths = [
  ['/api/contributors/intake/private-bearer/photo', '/api/contributors/intake/:token/photo'],
  ['/api/contributors/intake/private-bearer', '/api/contributors/intake/:token'],
  ['/contributors/intake/private-bearer', '/contributors/intake/:token'],
  ['/api/events/123/contributors/456', '/api/events/:eventId/contributors/:id'],
  ['/api/events/123/contributors', '/api/events/:eventId/contributors'],
  ['/api/contributors/claim/456', '/api/contributors/claim/:id'],
  ['/contributors/claim/456', '/contributors/claim/:id'],
  ['/api/people/private-person/follow', '/api/people/:slug/follow'],
  ['/api/people/private-person', '/api/people/:slug'],
  ['/people/private-person', '/people/:slug']
];

test('unexpected contributor failures log route patterns, not bearer paths, mailboxes or database/provider payloads', () => {
  const original = console.error;
  const messages = [];
  console.error = (...parts) => messages.push(parts.join(' '));
  try {
    for (const [path, pattern] of paths) {
      const err = Object.assign(new Error('database failure for private@example.test token=private-bearer'), { status: 502 });
      const res = {
        headersSent: false,
        status(value) { this.statusCode = value; return this; },
        json(body) { this.body = body; return this; },
        send(body) { this.body = body; return this; }
      };
      errorHandler(err, { method: 'POST', path }, res, () => assert.fail('response should finish here'));
      assert.equal(res.statusCode, 502);
      assert.equal(path.startsWith('/api/') ? res.body.error : res.body, 'Something went wrong');
      assert.equal(errorHandler.contributorErrorRoute(path), pattern);
      assert.ok(messages.at(-1).includes(pattern));
      assert.doesNotMatch(messages.at(-1), /private-bearer|private@example|private-person|database failure|123|456/);
    }
  } finally {
    console.error = original;
  }
});

test('headers-sent contributor failure forwards only a sanitized error to the framework fallback', () => {
  const original = console.error;
  console.error = () => {};
  try {
    const err = new Error('provider secret and private@example.test');
    let forwarded;
    errorHandler(err, { method: 'POST', path: '/api/contributors/intake/private-bearer/photo' }, { headersSent: true }, value => { forwarded = value; });
    assert.ok(forwarded instanceof Error);
    assert.notEqual(forwarded, err);
    assert.equal(forwarded.message, 'Contributor request failed');
    assert.doesNotMatch(forwarded.stack, /private-bearer|private@example|provider secret/);
  } finally {
    console.error = original;
  }
});

test('contributor failure sanitization does not broaden or alter existing unrelated route handling', () => {
  assert.equal(errorHandler.contributorErrorRoute('/api/auth/verify-code'), null);
  assert.equal(errorHandler.contributorErrorRoute('/api/events/123/post-event/thank-you/send'), null);
  assert.equal(errorHandler.contributorErrorRoute('/api/people/slug/unrelated'), null);
});
