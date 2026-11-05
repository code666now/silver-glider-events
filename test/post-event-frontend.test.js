const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const postEvent = require('../public/js/post-event');
const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

// Exercise the actual controller without a browser dependency or test DB.
function postEventDom() {
  const previousDocument = global.document;
  const previousWindow = global.window;
  const nodes = new Map();
  const makeNode = id => ({
    id, hidden: false, disabled: false, open: false, value: '', textContent: '', dataset: {}, isConnected: true,
    attributes: new Map(), listeners: {},
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    removeAttribute(name) { this.attributes.delete(name); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    focus() { global.document.activeElement = this; },
    reportValidity() { return true; },
    setCustomValidity() {},
    dispatch(type) { for (const listener of this.listeners[type] || []) listener({ target: this, preventDefault() {} }); },
    click() {
      if (this.disabled) return;
      this.dispatch('click');
      if (this.id === 'post-event-dialog-next') nodes.get('post-event-thank-form').dispatch('submit');
    },
    showModal() { this.open = true; },
    close() { this.open = false; this.dispatch('close'); }
  });
  for (const [, id] of read('src/views/event-manage.html').matchAll(/\bid="([^"]+)"/g)) nodes.set(id, makeNode(id));
  global.document = { getElementById: id => nodes.get(id), activeElement: nodes.get('post-event-thank-guests') };
  global.window = { requestAnimationFrame: fn => fn(), setTimeout: () => 1, clearTimeout() {} };
  return {
    get: id => nodes.get(id),
    async settle() { for (let step = 0; step < 20; step += 1) await Promise.resolve(); },
    restore() {
      if (previousDocument === undefined) delete global.document; else global.document = previousDocument;
      if (previousWindow === undefined) delete global.window; else global.window = previousWindow;
    }
  };
}

test('post-event state keeps RSVP, plus-one, returning, new and comment counts separate', () => {
  const state = postEvent.normalizeState({
    ended: true,
    stats: {
      rsvpSubmissions: 23,
      additionalGuests: 13,
      markedGoing: 36,
      returning: 3,
      newFaces: 20,
      comments: 2
    },
    draw: { estimatedTurnout: 58, updatedAt: '2030-10-31T17:00:00.000Z' },
    thankYou: { eligibleCount: 19, status: 'draft', canIncludeFollow: true }
  });

  assert.deepEqual(state.stats, {
    rsvpSubmissions: 23,
    additionalGuests: 13,
    markedGoing: 36,
    returning: 3,
    newFaces: 20,
    comments: 2
  });
  assert.equal(state.draw.estimatedTurnout, 58);
  assert.equal(state.thankYou.eligibleCount, 19);
});

test('thank-you delivery language reports provider acceptance, never inbox delivery', () => {
  const sent = postEvent.deliveryStatus({ status: 'sent', sentCount: 12, recipientCount: 12 });
  const partial = postEvent.deliveryStatus({ status: 'partial_failed', completedAt: '2030-10-31T20:00:00.000Z', sentCount: 9, failedCount: 3, recipientCount: 12 });
  const suppressed = postEvent.deliveryStatus({ status: 'sent', sentCount: 0, skippedCount: 12, recipientCount: 12 });
  const retrying = postEvent.deliveryStatus({ status: 'partial_failed', sentCount: 2, failedCount: 10, recipientCount: 12 });

  assert.match(sent.copy, /accepted by the email provider/i);
  assert.match(sent.copy, /not the same as inbox delivery/i);
  assert.doesNotMatch(sent.copy, /12 delivered/i);
  assert.match(partial.copy, /9 accepted by the email provider/i);
  assert.match(partial.copy, /3 failed/i);
  assert.match(suppressed.copy, /accepted 0 messages/i);
  assert.match(suppressed.copy, /12 skipped/i);
  assert.doesNotMatch(suppressed.copy, /12 messages? accepted/i);
  assert.match(retrying.title, /still processing/i);
  assert.match(retrying.copy, /remaining eligible messages will retry/i);
  assert.doesNotMatch(retrying.copy, /10 retrying/i);
  assert.doesNotMatch(retrying.title, /most/i);
  assert.equal(sent.title, 'You thanked your guests.');
  assert.doesNotMatch(suppressed.title, /You thanked your guests/);
});

test('thank-you recap card reports completed positive sends without claiming success for zero or failures', () => {
  assert.equal(postEvent.thankYouCardTitle({ status: 'draft' }), 'Thank your guests');
  assert.equal(postEvent.thankYouCardTitle({ status: 'sent', sentCount: 16 }), 'You thanked your guests');
  assert.equal(postEvent.thankYouCardTitle({ status: 'sent', sentCount: 0 }), 'No thank-yous were accepted');
  assert.equal(postEvent.thankYouCardTitle({ status: 'pending' }), 'Thank-you queued');
  assert.equal(postEvent.thankYouCardTitle({ status: 'processing' }), 'Thank-you in progress');
  assert.equal(postEvent.thankYouCardTitle({ status: 'partial_failed', sentCount: 5 }), 'Thank-you in progress');
  assert.equal(postEvent.thankYouCardTitle({ status: 'partial_failed', sentCount: 5, completedAt: '2030-10-31' }), 'Thank-you needs attention');
  assert.equal(postEvent.thankYouCardTitle({ status: 'failed' }), 'Thank-you needs attention');
});

test('real controller keeps completed send controls hidden and disabled after busy cleanup and blocks repeated submissions', async () => {
  const dom = postEventDom();
  const calls = [];
  const draft = { subject: 'Thanks for our night', message: 'Thanks for coming.', credits: [], status: 'draft', eligibleCount: 16 };
  try {
    const experience = postEvent.create({ eventId: '123', request: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET' });
      if (url.endsWith('/preview')) return { previewToken: 'synthetic', html: '<p>Thanks</p>', eligibleCount: 16 };
      if (url.endsWith('/send')) return { thankYou: { ...draft, status: 'sent', sentCount: 16, recipientCount: 16, skippedCount: 7 } };
      return options.method === 'PUT' ? { thankYou: draft } : { ended: true, thankYou: draft };
    } });
    await experience.load({ title: 'Our night' });
    experience.openDialog();
    dom.get('post-event-thank-form').dispatch('submit');
    await dom.settle();
    assert.equal(dom.get('post-event-dialog-next').textContent, 'Send to 16 guests');
    dom.get('post-event-thank-form').dispatch('submit');
    await dom.settle();
    const next = dom.get('post-event-dialog-next');
    assert.equal(next.hidden, true);
    assert.equal(next.disabled, true, 'send cleanup must not re-enable the read-only action');
    assert.equal(dom.get('post-event-edit-panel').hidden, true);
    assert.equal(dom.get('post-event-preview-panel').hidden, true);
    assert.equal(dom.get('post-event-dialog-tabs').hidden, true);
    assert.equal(dom.get('post-event-thank-subject').disabled, true);
    assert.equal(dom.get('post-event-thank-action-title').textContent, 'You thanked your guests');
    assert.equal(dom.get('post-event-send-status-title').textContent, 'You thanked your guests.');
    assert.match(dom.get('post-event-send-status-copy').textContent, /not the same as inbox delivery/);
    const before = calls.length;
    next.click();
    dom.get('post-event-thank-form').dispatch('submit');
    dom.get('post-event-edit-tab').dispatch('click');
    dom.get('post-event-preview-tab').dispatch('click');
    await dom.settle();
    assert.equal(calls.length, before, 'status clicks and forced submits never preview or send again');
    assert.equal(calls.filter(call => call.url.endsWith('/send')).length, 1);
    dom.get('post-event-dialog-back').click();
    assert.equal(dom.get('post-event-thank-dialog').open, false);
    experience.openDialog();
    assert.equal(next.hidden, true);
    assert.equal(next.disabled, true);
    assert.equal(dom.get('post-event-dialog-back').textContent, 'Close');
    assert.equal(calls.length, before);
  } finally { dom.restore(); }
});

test('every saved thank-you history opens a truthful read-only status, including zero accepted and ongoing retries', async () => {
  for (const history of [
    { status: 'sent', sentCount: 0 }, { status: 'pending' }, { status: 'processing' },
    { status: 'partial_failed', sentCount: 2 }, { status: 'partial_failed', sentCount: 2, completedAt: '2030-10-31' }, { status: 'failed' }
  ]) {
    const dom = postEventDom();
    const calls = [];
    try {
      const experience = postEvent.create({ eventId: '123', request: async (url, options = {}) => {
        calls.push({ url, method: options.method || 'GET' });
        return { ended: true, thankYou: { subject: 'Thanks', message: 'A note.', ...history } };
      } });
      await experience.load();
      experience.openDialog();
      dom.get('post-event-thank-form').dispatch('submit');
      dom.get('post-event-edit-tab').dispatch('click');
      await dom.settle();
      assert.equal(dom.get('post-event-dialog-next').hidden, true);
      assert.equal(dom.get('post-event-dialog-next').disabled, true);
      assert.equal(dom.get('post-event-edit-panel').hidden, true);
      assert.equal(dom.get('post-event-preview-panel').hidden, true);
      assert.equal(dom.get('post-event-edit-tab').disabled, true);
      assert.equal(dom.get('post-event-preview-tab').disabled, true);
      assert.doesNotMatch(dom.get('post-event-thank-action-title').textContent, /You thanked your guests/);
      assert.equal(calls.filter(call => call.method !== 'GET').length, 0);
    } finally { dom.restore(); }
  }
});

test('ended-event manage UI extends Recap with one private draw and an exact sandboxed preview', () => {
  const view = read('src/views/event-manage.html');
  const client = read('public/js/post-event.js');
  const manage = read('public/js/manage.js');

  for (const id of [
    'post-event-stats',
    'post-event-draw-form',
    'post-event-turnout',
    'post-event-see-guests',
    'post-event-thank-guests',
    'post-event-thank-action-title',
    'post-event-thank-dialog',
    'post-event-thank-subject',
    'post-event-thank-message',
    'post-event-include-follow',
    'post-event-preview-frame'
  ]) assert.match(view, new RegExp(`id="${id}"`));

  assert.match(view, /id="post-event-preview-frame"[^>]*sandbox/);
  assert.match(view, /id="post-event-thank-subject"[^>]*maxlength="160"/);
  assert.match(view, /For guests marked Going with an email, excluding email opt-outs and unsubscribes\./);
  assert.match(view, /No account or future-event subscription is needed\. Additional guests are not contacted\./);
  assert.match(view, /Only you can see this estimate\. Your RSVP count stays the same\./);
  assert.match(client, /post-event\/thank-you\/preview/);
  assert.match(client, /post-event\/thank-you\/send/);
  assert.match(client, /srcdoc = previewHtml/);
  assert.match(client, /error\.status === 409/);
  assert.match(client, /STATUS_POLL_LIMIT/);
  assert.match(client, /partial_failed'[\s\S]*!state\.thankYou\.completedAt/);
  assert.match(client, /if \(hasHistory\) currentPanel = 'status'/);
  assert.match(client, /else if \(currentPanel === 'edit'\) createPreview\(\)/);
  assert.match(client, /Your private recap will be available after this event ends\./);
  assert.match(manage, /get\('postEvent'\)[\s\S]*'thank-you'/);
  assert.match(manage, /setMobileManageView\('promote'/);
  assert.match(manage, /const eventEnded = isPostEventEligible\(\)/);
  assert.match(manage, /event\.key === 'Escape' && \(\$\('post-event-thank-dialog'\)\?\.open \|\| \$\('publish-event-dialog'\)\.open\)\) return/);
});

test('past events reuse Familiar Faces cards while separating identifiable returning, new and additional guests', () => {
  const manage = read('public/js/manage.js');

  assert.match(manage, /Familiar faces marked going again/);
  assert.match(manage, /Number\(face\.visitCount\) > 1/);
  assert.match(manage, /New faces marked going/);
  assert.match(manage, /Number\(face\.visitCount\) === 1/);
  assert.match(manage, /Additional guests marked going/);
  assert.match(manage, /face\.plusOne/);
  assert.match(manage, /const groups = isPostEventEligible\(\) \? PAST_FAMILIAR_GROUPS : FAMILIAR_GROUPS/);
  assert.match(manage, /\/familiar-faces/);
  assert.match(manage, /\/rsvps\.csv/);
});

test('post-event styling preserves the existing desktop card and phone bottom-sheet patterns', () => {
  const styles = read('public/css/post-event.css');
  assert.match(styles, /\.post-event-dialog/);
  assert.match(styles, /\.post-event-dialog \[hidden\]\s*\{\s*display:none !important/);
  assert.match(styles, /\.post-event-dialog-tabs\[hidden\]\s*\{\s*display:none !important/);
  assert.match(styles, /@media \(max-width:879px\)/);
  assert.match(styles, /margin:auto 0 0/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(styles, /\.post-event-dialog-body\s*\{[^}]*flex:1 1 auto;min-height:0/);
  assert.match(styles, /\.post-event-dialog-foot\s*\{[^}]*flex:0 0 auto/);
  assert.match(styles, /@media \(hover:hover\)/);
  assert.match(styles, /:focus-visible/);
  assert.doesNotMatch(styles, /overflow-x:\s*scroll/);
});
