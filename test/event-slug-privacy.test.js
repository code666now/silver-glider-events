const test = require('node:test');
const assert = require('node:assert/strict');

const { makeEventSlug } = require('../src/lib/slug');

test('draft slugs are unguessable without changing public and private event defaults', () => {
  const draftSlug = makeEventSlug({
    title: 'Private Working Draft',
    status: 'draft',
    visibility: 'public'
  });
  const privateSlug = makeEventSlug({
    title: 'Private Night',
    status: 'published',
    visibility: 'private'
  });
  const publicSlug = makeEventSlug({
    title: 'Public Night',
    status: 'published',
    visibility: 'public'
  });

  assert.match(draftSlug, /^[a-f0-9]{16}$/);
  assert.match(privateSlug, /^[a-f0-9]{16}$/);
  assert.match(publicSlug, /^public-night-[a-z0-9]{4}$/);
});
