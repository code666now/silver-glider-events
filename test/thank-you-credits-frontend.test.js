const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const credits = require('../public/js/thank-you-credits');
const postEvent = require('../public/js/post-event');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('thank-you credits accept a name with optional role and Instagram, without an account or contact field', () => {
  const result = credits.validateRows([{ name: '  Night   Artist  ', role: '', instagramHandle: '' }]);
  assert.deepEqual(result, { valid: true, credits: [{ name: 'Night Artist', role: '', instagramHandle: null }], errors: [] });
  assert.equal(credits.MAX_CREDITS, 3);
  assert.deepEqual(Object.keys(result.credits[0]), ['name', 'role', 'instagramHandle']);
});

test('Instagram credits normalize handles and profile URLs to one safe handle', () => {
  for (const input of ['@Night.Artist', 'Night.Artist', 'https://www.instagram.com/Night.Artist/', 'instagram.com/Night.Artist?igsh=public']) {
    assert.deepEqual(credits.instagramHandle(input), { value: 'night.artist', error: null });
  }
  for (const input of ['javascript:alert(1)', 'https://evil.example/artist', 'https://instagram.com/p/post', 'https://instagram.com.evil.example/artist', 'https://instagram.com:443/artist', 'https://instagram.com:8443/artist', 'https://user:password@instagram.com/artist', 'https://instagram.com/reels', '@accounts', 'direct', '.artist', 'artist.', 'bad..name', 'bad name']) {
    assert.ok(credits.instagramHandle(input).error, `${input} is not an Instagram profile`);
  }
});

test('an untouched blank new row is omitted, while meaningful incomplete rows need a name or removal', () => {
  assert.deepEqual(credits.validateRows([{ name: ' ', role: '', instagramHandle: '' }]).credits, []);
  assert.equal(credits.validateRows([{ name: '', role: 'Bartender', instagramHandle: '' }]).valid, false);
  assert.match(credits.validateRows([{ name: '', role: '', instagramHandle: '@artist' }]).errors[0].message, /name.*remove/i);
  assert.equal(credits.validateRows([{ name: 'Artist', role: '', instagramHandle: 'bad handle' }]).errors[0].field, 'instagramHandle');
});

test('credits stay capped at three and enforce the backend name and role bounds', () => {
  assert.equal(credits.validateRows(Array.from({ length: 4 }, () => ({ name: 'Artist' }))).valid, false);
  assert.equal(credits.validateRows([{ name: 'x'.repeat(101) }]).valid, false);
  assert.equal(credits.validateRows([{ name: 'Artist', role: 'x'.repeat(81) }]).valid, false);
  assert.equal(credits.validateRows([{ name: 'Artist', role: 'DJ\u0000' }]).valid, false);
  assert.equal(credits.normalizeRows(Array.from({ length: 4 }, () => ({ name: 'Artist' }))).length, 3);
});

test('thank-you state retains only simple credit presentation and an explicit cleared array', () => {
  const normalized = postEvent.normalizeThankYou({ credits: [{ name: 'Artist', role: 'DJ', instagramHandle: null, email: 'private@example.test', photoUrl: '/not-used.png' }] });
  assert.deepEqual(normalized.credits, [{ name: 'Artist', role: 'DJ', instagramHandle: '' }]);
  assert.deepEqual(postEvent.normalizeThankYou({ credits: [] }).credits, []);
  assert.doesNotMatch(JSON.stringify(normalized), /private@example|not-used/);
});

test('thank-you editor replaces onboarding with an optional simple shout-out and preserves its main send path', () => {
  const view = read('src/views/event-manage.html');
  const source = read('public/js/thank-you-credits.js');
  const thankYou = read('public/js/post-event.js');
  assert.match(view, /<details class="post-event-credits" id="post-event-credits">/);
  assert.match(view, /Give your crew a shout-out/);
  assert.match(view, /Optional · up to three people/);
  assert.match(view, /id="post-event-credit-add" type="button">\+ Add person/);
  assert.match(view, /src="\/js\/thank-you-credits.js"/);
  assert.doesNotMatch(view, /post-event-contributor|src="\/js\/contributors.js"/);
  assert.doesNotMatch(thankYou, /SgeContributors|\/contributors|contributorEditor/);
  assert.doesNotMatch(source, /fetch\(|request\(|type = 'email'|photoUrl|claim|approval|invite/i);
  assert.match(source, /label: 'Role · optional'/);
  assert.match(source, /label: 'Instagram · optional'/);
  assert.match(thankYou, /credits: result\?\.credits \|\| state.thankYou.credits/);
  assert.match(thankYou, /if \(force \|\| !editorDirty \|\| thankYou.status !== 'draft'\)/);
  assert.match(thankYou, /revision !== editorRevision/);
  assert.match(thankYou, /setEditorBusy\(true\)/);
  assert.match(thankYou, /if \(hasHistory\) currentPanel = 'status'/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
});

test('simple credits maintain keyboard controls, mobile input sizes and reduced-motion styling', () => {
  const source = read('public/js/thank-you-credits.js');
  const styles = read('public/css/post-event.css');
  assert.match(source, /remove.type = 'button'/);
  assert.match(source, /input.reportValidity\(\)/);
  assert.match(source, /remove.setAttribute\('aria-label'/);
  assert.match(styles, /\.post-event-credits summary:focus-visible/);
  assert.match(styles, /\.post-event-credit-field \.sg-input \{ min-height:56px;font-size:16px/);
  assert.match(styles, /@media \(prefers-reduced-motion:reduce\)/);
});
