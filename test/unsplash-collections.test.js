const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function setup(t, provide = ({ query, perPage }) => ({ ids: Array.from({ length: perPage }, (_, i) => `${query}/${i}`) })) {
  delete require.cache[require.resolve('../src/lib/unsplash')];
  const unsplash = require('../src/lib/unsplash');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const params = new URL(url).searchParams;
    const input = { query: params.get('query'), page: Number(params.get('page')), perPage: Number(params.get('per_page')) };
    calls.push(input);
    assert.equal(params.get('content_filter'), 'high');
    const { ids = [], totalPages = 5, status = 200 } = await provide(input);
    return { ok: status === 200, status, json: async () => ({ total_pages: totalPages, results: ids.map(id => ({
      id, urls: { small: `https://images.unsplash.com/${id}?w=400`, regular: `https://images.unsplash.com/${id}` },
      links: { download_location: `https://api.unsplash.com/photos/${id}/download` },
      user: { name: 'Fixture Photographer', links: { html: 'https://unsplash.com/@fixture' } }
    })) }) };
  });
  return { ...unsplash, calls };
}

test('Christmas mixes trees, gatherings, presents and snowmen and shares pending and cached results', async t => {
  const { searchPicker, calls } = setup(t);
  const [first, second] = await Promise.all([
    searchPicker({ collection: 'christmas', per_page: 12 }),
    searchPicker({ collection: 'christmas', per_page: 24 })
  ]);
  assert.deepEqual(second, first);
  assert.equal(calls.length, 4);
  assert.deepEqual(first.results.slice(0, 4).map(photo => photo.id), [
    'decorated christmas tree/0', 'christmas party friends/0', 'presents under christmas tree/0', 'snowman/0'
  ]);
  assert.equal(first.results.length, 16);
  assert.equal(first.results[0].credit_name, 'Fixture Photographer');
  assert.match(first.results[0].credit_link, /utm_source=silver_glider_events/);
  assert.match(first.results[0].download_location, /^https:\/\/api\.unsplash\.com\//);
  await searchPicker({ collection: 'christmas' });
  assert.equal(calls.length, 4, 'reopening a pack does not consume extra provider requests');
});

test('New Year’s leads with party photos and adds at most two dedicated fireworks on page one', async t => {
  const { searchPicker, calls } = setup(t);
  const first = await searchPicker({ collection: 'new-year' });
  assert.deepEqual(first.results.slice(0, 3).map(photo => photo.id), [
    'new year eve party balloons/0', 'new year eve party decorations signs/0', 'champagne toast friends party/0'
  ]);
  assert.equal(first.results.filter(photo => photo.id.includes('fireworks')).length, 2);
  assert.ok(first.results.slice(-2).every(photo => photo.id.includes('fireworks')));
  const second = await searchPicker({ collection: 'new-year', page: 2 });
  assert.equal(second.results.filter(photo => photo.id.includes('fireworks')).length, 0);
  assert.equal(second.totalPages, 3);
  assert.equal(calls.filter(request => request.query.includes('fireworks')).length, 1);
  assert.deepEqual(await searchPicker({ collection: 'new-year', page: 4 }), { page: 4, totalPages: 3, results: [] });
  assert.equal(calls.length, 7);
});

test('a thin or partly unavailable New Year’s mix deduplicates and does not fill gaps with fireworks', async t => {
  const { searchPicker } = setup(t, ({ query }) => {
    if (query.includes('fireworks')) return { ids: ['firework-one', 'firework-two'] };
    if (query.includes('balloons')) return { ids: ['same-photo', 'extra-photo'], totalPages: 1 };
    if (query.includes('decorations')) return { ids: ['same-photo', 'distinct-photo'], totalPages: 2 };
    return { status: 429 };
  });
  const result = await searchPicker({ collection: 'new-year' });
  assert.deepEqual(result.results.map(photo => photo.id), ['same-photo', 'extra-photo', 'distinct-photo']);
  assert.equal(result.totalPages, 2);
});

test('a failed New Year’s search never shows a fireworks-only collection', async t => {
  const { searchPicker } = setup(t, ({ query }) => query.includes('fireworks')
    ? { ids: ['firework-one', 'firework-two'] }
    : { status: 429 });
  await assert.rejects(searchPicker({ collection: 'new-year' }), { status: 429 });
});

test('manual searches stay single-query and both protected routes share the allowlist', async t => {
  const { searchPicker, calls } = setup(t);
  await searchPicker({ q: ' christmas ', page: '2', per_page: '12' });
  assert.deepEqual(calls, [{ query: 'christmas', page: 2, perPage: 12 }]);
  await assert.rejects(searchPicker({ collection: 'other', q: 'manual' }), { status: 400 });
  assert.equal(calls.length, 1);
  for (const [route, middleware] of [['photos.js', 'requireOrganizer'], ['admin-editor.js', 'requireBoundWorkspace']]) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', route), 'utf8');
    assert.match(source, new RegExp(`router\\.get\\('/api/photos/search', ${middleware},[\\s\\S]+?unsplash\\.searchPicker\\(req\\.query\\)`));
  }
});
