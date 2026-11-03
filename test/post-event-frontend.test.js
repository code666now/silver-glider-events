const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const postEvent = require('../public/js/post-event');
const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

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
  assert.match(retrying.title, /need another try/i);
  assert.match(retrying.copy, /remaining eligible messages will retry/i);
  assert.doesNotMatch(retrying.copy, /10 retrying/i);
  assert.doesNotMatch(retrying.title, /most/i);
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
  assert.match(manage, /event\.key === 'Escape' && \$\('post-event-thank-dialog'\)\?\.open\) return/);
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
