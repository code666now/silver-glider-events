const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const postEvent = require('../public/js/post-event');

function editorHarness(canIncludeFollow) {
  const nodes = new Map();
  function byId(id) {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', textContent: '', hidden: false, checked: false, disabled: false,
      dataset: {}, open: false, listeners: {},
      addEventListener(type, listener) { this.listeners[type] = listener; },
      setAttribute() {}, removeAttribute() {}, focus() {}, reportValidity() { return true; },
      showModal() { this.open = true; }, close() { this.open = false; }
    });
    return nodes.get(id);
  }
  const calls = [];
  const thankYou = {
    subject: 'Thanks for coming', message: 'It was great to see you.',
    canIncludeFollow, includeFollow: false, eligibleCount: 2, status: 'draft'
  };
  const request = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/preview')) return { previewToken: 'preview-token', html: '<p>Guest preview</p>', eligibleCount: 2 };
    if (options?.method === 'PUT') return { thankYou };
    return { ended: true, stats: {}, thankYou };
  };
  return { byId, calls, request };
}

for (const hasHostPage of [true, false]) {
  test(`thank-you editor ${hasHostPage ? 'always includes' : 'does not invent'} the Host Page button`, async () => {
    const previousDocument = global.document;
    const previousWindow = global.window;
    const harness = editorHarness(hasHostPage);
    global.document = { getElementById: harness.byId };
    global.window = { requestAnimationFrame: callback => callback() };
    try {
      const editor = postEvent.create({ eventId: 'event-id', request: harness.request });
      await editor.load({ title: 'A great night' });

      assert.equal(harness.byId('post-event-include-follow').checked, hasHostPage);
      assert.match(harness.byId('post-event-follow-title').textContent,
        hasHostPage ? /“Follow my page” is included/ : /No Host Page yet/);
      assert.match(harness.byId('post-event-follow-copy').textContent,
        hasHostPage ? /guests choose whether to follow\. Nobody is subscribed automatically\./ : /will not include a Follow button/);

      // Even an old saved draft (includeFollow:false) or altered hidden checkbox
      // cannot remove the standard Host Page button when the page exists.
      harness.byId('post-event-include-follow').checked = !hasHostPage;
      harness.byId('post-event-thank-form').listeners.submit({ preventDefault() {} });
      await new Promise(resolve => setImmediate(resolve));
      const save = harness.calls.find(call => call.options?.method === 'PUT');
      const preview = harness.calls.find(call => call.url.endsWith('/preview'));
      assert.equal(save.options.body.includeFollow, hasHostPage);
      assert.equal(preview.options.body.includeFollow, hasHostPage);
    } finally {
      if (previousDocument === undefined) delete global.document;
      else global.document = previousDocument;
      if (previousWindow === undefined) delete global.window;
      else global.window = previousWindow;
    }
  });
}

test('Host Page explanation is informational rather than a disabled permission checkbox', () => {
  const view = fs.readFileSync(path.join(__dirname, '../src/views/event-manage.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../public/css/post-event.css'), 'utf8');
  assert.match(view, /class="post-event-follow-option" role="note"/);
  assert.match(view, /id="post-event-include-follow"[^>]*hidden[^>]*tabindex="-1"/);
  assert.doesNotMatch(view, /separate host-email permission|separately agreed to emails from you/);
  assert.doesNotMatch(css, /\.post-event-follow-option:has\(input:disabled\)/);
});
