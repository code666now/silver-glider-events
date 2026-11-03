const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ui = require('../public/js/contributors');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('contributor UI keeps safe links and a bounded known status without trusting HTML', () => {
  const normalized = ui.normalizeContributor({ id: 5, name: '<img onerror=x>', email: 'invited@example.com', role: 'DJ', status: 'arbitrary', selected: true, profileUrl: 'javascript:alert(1)' });
  assert.equal(normalized.status, 'invited');
  assert.equal(normalized.name, '<img onerror=x>');
  assert.equal(normalized.profileUrl, '');
  assert.equal(ui.safeLink('https://example.com/work'), 'https://example.com/work');
  assert.equal(ui.safeLink('/people/artist'), 'https://silvergliderevents.com/people/artist');
  assert.equal(ui.safeLink('data:text/html,hello'), '');
});

test('pending follows explain the claim gate and do not promise automatic subscription', () => {
  assert.match(ui.followMessage({ pending: true }), /only after this person claims their page/);
  assert.match(ui.followMessage({ pending: true }), /unfollow any time/);
  assert.match(ui.followMessage({ following: true }), /unsubscribe whenever/);
  assert.match(ui.followMessage({}), /Following is optional/);
  assert.equal(ui.APPROVAL_VERSION, 'contributor-spotlight-v1');
  assert.equal(ui.FOLLOW_VERSION, 'contributor-follow-v1');
});

test('thank-you editor exposes optional approved spotlight selection and explicit contributor email invitation', () => {
  const view = read('src/views/event-manage.html');
  const source = read('public/js/contributors.js');
  const thankYou = read('public/js/post-event.js');
  assert.match(view, /People who made the night/);
  assert.match(view, /Pending invitations never hold up your thank-you/);
  assert.match(view, /This sends only their invitation—not your guest thank-you/);
  assert.match(view, /id="post-event-contributor-invite" type="button"/);
  assert.match(view, /id="post-event-contributor-email" form="post-event-contributor-invite-form"/);
  assert.match(view, /src="\/js\/contributors.js"/);
  assert.match(source, /person.status === 'approved'/);
  assert.match(source, /body: \{ selected: input.checked \}/);
  assert.match(source, /body: \{ revoked: true \}/);
  assert.match(source, /result.invitationSent === false/);
  assert.match(source, /Invitation saved, but the email was not delivered/);
  assert.match(thankYou, /await contributorEditor\?\.preparePreview\(\)/);
  assert.match(source, /Promise.allSettled\(\[\.\.\.selectionWrites\]\)/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /Adrian Martinez/);
});

test('mobile contributor approval keeps invitation email read-only and approval explicit', () => {
  const view = read('src/views/contributor-intake.html');
  const client = read('public/js/contributors.js');
  assert.match(view, /id="contributor-email"[^>]*readonly/);
  assert.match(view, /id="contributor-approval" type="checkbox" required/);
  assert.doesNotMatch(view, /id="contributor-approval"[^>]*checked/);
  assert.match(view, /Looks good—include me/);
  assert.match(view, /name, role, photo, and links to appear in this event’s thank-you and on my public introduction page/);
  assert.match(client, /text\('contributor-approval-text', result.approvalText\)/);
  assert.match(view, /does not subscribe me to marketing emails/);
  assert.match(view, /Not me \/ Don’t feature me/);
  assert.match(view, /id="contributor-claim-retry" type="button" hidden>Retry claim email/);
  assert.match(client, /request\(endpoint, \{ method: 'POST', body: approvalBody\(\) \}\)/);
  assert.match(client, /await request\(endpoint, \{ method: 'DELETE' \}\)/);
  assert.match(view, /name="referrer" content="no-referrer"/);
  assert.match(client, /approvalVersion/);
  assert.match(client, /const person = result.contributor \|\| result/);
  assert.match(client, /result.approved === true/);
  assert.match(client, /data.append\('image', file\)/);
  assert.match(client, /file.size > 5 \* 1024 \* 1024/);
  const sharedApi = read('public/js/api.js');
  const mountFeedback = sharedApi.slice(sharedApi.indexOf('function mountFeedbackBubble()'));
  assert.ok(mountFeedback.indexOf("document.body.dataset.contributorPage === 'intake'") < mountFeedback.indexOf("const draftKey = 'sge_feedback_draft'"),
    'bearer intake never mounts feedback or reaches its URL-persisting draft code');
});

test('public contributor follow is an unchecked deliberate action and claim offers existing event creation', () => {
  const profile = read('src/views/contributor-public.html');
  const claim = read('src/views/contributor-claim.html');
  const client = read('public/js/contributors.js');
  assert.match(profile, /id="contributor-follow-consent" type="checkbox"/);
  assert.doesNotMatch(profile, /id="contributor-follow-consent"[^>]*checked/);
  assert.match(client, /emailConsent: true, consentVersion:/);
  assert.match(client, /if \(!following && !consent.checked\)/);
  assert.match(claim, /href="\/events\/new"/);
  assert.match(claim, /href="\/settings\/host-page"/);
  assert.match(claim, /does not send an announcement automatically/);
  assert.match(client, /count\s*\? `[\s\S]*from \$\{result.eventTitle\}/);
  assert.match(client, /get\('intro'\)/);
  assert.match(client, /\^\[A-Za-z0-9_-\]\{16,64\}\$/);
  assert.match(client, /profileEndpoint\}\/follow\$\{attribution/);
});

test('contributor forms match site typography with mobile-sized inputs and visible keyboard focus', () => {
  const styles = read('public/css/contributors.css');
  assert.match(styles, /@media \(max-width:600px\)/);
  assert.match(styles, /min-height:58px;font-size:16px/);
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(styles, /overflow-wrap:anywhere/);
  for (const page of ['contributor-intake.html', 'contributor-public.html', 'contributor-claim.html']) {
    assert.match(read(`src/views/${page}`), /href="\/css\/main.css"/);
  }
});
