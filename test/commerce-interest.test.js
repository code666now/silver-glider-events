const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('ticketing launch interest is explicit, reversible, and separate from other consent', () => {
  const migration = read('src/db/migrations/025_commerce_feature_interest.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS commerce_feature_interests/);
  assert.match(migration, /organizer_id[\s\S]*REFERENCES organizers\(id\) ON DELETE CASCADE/);
  assert.match(migration, /feature_key[\s\S]*commerce_ticketing/);
  assert.match(migration, /requested_at/);
  assert.match(migration, /removed_at/);
  assert.match(migration, /launch_sent_at/);
  assert.match(migration, /UNIQUE \(organizer_id, feature_key\)/);
  assert.doesNotMatch(migration, /ALTER TABLE (rsvps|host_follows)/i);
});

test('event editor offers a one-click launch notification without another identity form', () => {
  const html = read('src/views/event-form.html');
  const js = read('public/js/event-form.js');
  const apiClient = read('public/js/api.js');
  assert.match(html, /id="commerce-interest"[^>]*hidden/);
  assert.match(html, /id="commerce-interest-toggle"[\s\S]*Join the waitlist/);
  assert.match(html, /<fieldset class="admission-options">[\s\S]*<legend class="event-choice-legend">Admission type<\/legend>/);
  assert.match(html, /<fieldset class="sg-field visibility-settings"[^>]*>[\s\S]*<legend class="desktop-visibility-label">Visibility<\/legend>/);
  assert.match(html, /\.event-choice-legend \{[\s\S]*clip:rect\(0,0,0,0\)/);
  assert.match(html, /#event-form \.desktop-visibility-label \{[\s\S]*clip: rect\(0,0,0,0\)/);
  assert.doesNotMatch(html, /#event-form \.desktop-visibility-label,[\s\S]*display: none !important/);
  assert.match(html, /Sell with Silver Glider is coming soon/);
  assert.match(html, /Join the waitlist using your account email/);
  assert.match(html, /id="commerce-interest-copy" role="status" aria-live="polite" aria-atomic="true" tabindex="-1"/);
  assert.match(html, /body\.event-mobile-flow-enabled \.sg-toast \{ bottom: calc\(100px \+ env\(safe-area-inset-bottom\)\); \}/);
  assert.doesNotMatch(html, /id="commerce-interest-(?:email|name)"/i);
  assert.match(js, /api\('\/api\/commerce\/interest'/);
  assert.match(js, /body: \{ interested: nextInterested \}/);
  assert.match(js, /function focusCommerceInterestConfirmation\(\)/);
  assert.match(js, /renderCommerceInterest\(\);[\s\S]*focusCommerceInterestConfirmation\(\)/);
  assert.match(js, /We’ll contact you at your account email when ticketing is available/);
  assert.match(js, /commerceInterested \? 'Leave waitlist' : 'Join the waitlist'/);
  assert.match(apiClient, /el\.setAttribute\('role', 'status'\)/);
  assert.match(apiClient, /el\.setAttribute\('aria-live', 'polite'\)/);
  assert.match(apiClient, /el\.setAttribute\('aria-atomic', 'true'\)/);
});

test('admin launch workflow is previewable, feature-gated, and retry-safe', () => {
  const route = read('src/routes/commerce.js');
  const view = read('src/views/admin-ticketing.html');
  const mailer = read('src/lib/mailer.js');
  assert.match(route, /router\.get\('\/api\/admin\/commerce-interest', requireAdmin/);
  assert.match(route, /router\.post\('\/api\/admin\/commerce-interest\/test', requireAdmin/);
  assert.match(route, /router\.post\('\/api\/admin\/commerce-interest\/send', requireAdmin/);
  assert.match(route, /if \(!commerceAdmissionEnabled\(\)\)/);
  assert.match(route, /confirm !== 'SEND_LAUNCH'/);
  assert.match(route, /launch_sent_at IS NULL/);
  assert.match(route, /launch_claimed_at IS NULL OR launch_claimed_at < NOW\(\) - INTERVAL '15 minutes'/);
  assert.match(view, /Silver Glider Tickets is ready/);
  assert.match(view, /id="send-test"/);
  assert.match(view, /id="send-launch"[^>]*disabled/);
  assert.match(mailer, /async function sendCommerceLaunch/);
  assert.match(mailer, /one-time email because you asked us to notify you/);
});
