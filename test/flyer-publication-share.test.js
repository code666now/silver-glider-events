const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../public/js/flyer-preview.js'), 'utf8');
const shareScript = script.slice(script.indexOf('  async function copyText('), script.indexOf('  function showPublishRetry('));
const live = { published: true, eventUrl: 'https://silvergliderevents.com/e/sample-event', eventTitle: 'Sample event' };

function shareFixture({ native = false, supported = true, shareError, clipboard = 'ok', legacyCopy = true } = {}) {
  const calls = [];
  const events = {};
  const fallback = { hidden: true };
  const linkInput = { focus() { calls.push(['focus-manual-link']); }, select() { calls.push(['select-manual-link']); } };
  const elements = {
    'flyer-publish-url': fallback,
    'flyer-event-link': linkInput,
    'flyer-share-event': { addEventListener(name, listener) { events[name] = listener; } }
  };
  const context = {
    navigator: {
      ...(native ? {
        canShare: () => supported,
        async share(data) { calls.push(['native-share', data.url]); if (shareError) throw Object.assign(new Error('Share failed'), { name: shareError }); }
      } : {}),
      ...(clipboard ? { clipboard: { async writeText(text) { calls.push(['copy', text]); if (clipboard === 'blocked') throw new Error('Blocked'); } } } : {})
    },
    window: { isSecureContext: true, setTimeout() {} },
    dialog: { open: true, appendChild(textarea) { calls.push(['legacy-in-dialog', textarea.value]); } },
    document: {
      createElement() { return { setAttribute() {}, select() {}, remove() { calls.push(['remove-helper']); } }; },
      activeElement: { focus() { calls.push(['restore-focus']); } },
      execCommand(command) { calls.push(['exec', command]); return legacyCopy; },
      getElementById: key => elements[key]
    },
    body: { querySelector() { return null; } },
    payload: null,
    previewState: data => data,
    markPublished() {},
    escapeHtml: text => text,
    confettiHtml: () => '<i>Confetti</i>',
    open(html) { context.html = html; },
    message(text, error) { if (text) calls.push([error ? 'error' : 'message', text]); },
    showPublishRetry(reason) { calls.push(['retry', reason]); }
  };
  const showShare = vm.runInNewContext(`${shareScript}\nshowShare`, context);
  return { open: (data = live, options = {}) => showShare(data, options), click: () => events.click(), calls, fallback, context };
}

test('confirmed publication has one native share action and a direct live-event link', async () => {
  const f = shareFixture({ native: true });
  f.open(live, { celebrate: true });
  assert.match(f.context.html, /<h2[^>]*>Your event is live!<\/h2>/);
  assert.match(f.context.html, /<span>Share event<\/span>/);
  assert.equal((f.context.html.match(/<button\b/g) || []).length, 1);
  assert.match(f.context.html, /<a class="flyer-publish-view" href="https:\/\/silvergliderevents\.com\/e\/sample-event">View event<\/a>/);
  assert.match(f.context.html, /id="flyer-publish-url" hidden/);
  assert.match(f.context.html, /Confetti/);
  await f.click();
  assert.deepEqual(f.calls, [['native-share', live.eventUrl]]);
});

test('no native sharing or rejected share data shows Copy link as the single action', async () => {
  for (const options of [{}, { native: true, supported: false }]) {
    const f = shareFixture(options);
    f.open();
    assert.match(f.context.html, /<span>Copy link<\/span>/);
    assert.doesNotMatch(f.context.html, />Share event</);
    await f.click();
    assert.deepEqual(f.calls, [['copy', live.eventUrl], ['message', 'Event link copied.']]);
    assert.equal(f.fallback.hidden, true);
  }
});

test('canceling native share takes no surprise action, but a failure falls back to copy', async () => {
  const canceled = shareFixture({ native: true, shareError: 'AbortError' });
  canceled.open();
  await canceled.click();
  assert.deepEqual(canceled.calls, [['native-share', live.eventUrl]]);
  const failed = shareFixture({ native: true, shareError: 'NotAllowedError' });
  failed.open();
  await failed.click();
  assert.deepEqual(failed.calls, [['native-share', live.eventUrl], ['copy', live.eventUrl], ['message', 'Event link copied.']]);
});

test('legacy copy uses the open dialog, or reveals the manual link and selects it', async () => {
  const copied = shareFixture({ clipboard: 'blocked' });
  copied.open();
  await copied.click();
  assert.deepEqual(copied.calls, [['copy', live.eventUrl], ['legacy-in-dialog', live.eventUrl], ['exec', 'copy'],
    ['remove-helper'], ['restore-focus'], ['message', 'Event link copied.']]);
  const failed = shareFixture({ clipboard: 'blocked', legacyCopy: false });
  failed.open();
  await failed.click();
  assert.equal(failed.fallback.hidden, false);
  assert.deepEqual(failed.calls.slice(-3), [['error', 'Couldn’t copy automatically. Copy the event link below.'],
    ['focus-manual-link'], ['select-manual-link']]);
});

test('the sharing screen only opens for confirmed publication with a live URL', () => {
  for (const data of [{ published: false, eventUrl: live.eventUrl }, { published: true }]) {
    const f = shareFixture();
    f.open(data);
    assert.equal(f.context.html, undefined);
    assert.equal(f.calls[0][0], 'retry');
  }
});
