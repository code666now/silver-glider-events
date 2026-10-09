const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.SESSION_SECRET ||= 'flyer-intake-unit-secret';

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const { normalizeSubmission, SMS_CONSENT_VERSION } = require('../src/routes/flyer-intake')._test;

test('flyer intake stays human-reviewed, bounded, and off by default', () => {
  const migration = read('src/db/migrations/061_done_for_you_flyer_intake.sql');
  const route = read('src/routes/flyer-intake.js');
  const publicRoute = route.slice(
    route.indexOf("router.post('/api/flyer-intake'"),
    route.indexOf("router.use('/api/admin/done-for-you/flyer-intake'")
  );
  const index = read('src/index.js');

  assert.match(migration, /accepting_submissions\s+BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(migration, /'submitted','building','ready_for_review','preview_sent'/);
  assert.match(migration, /admin_flyer_request_messages/);
  assert.match(migration, /UNIQUE \(flyer_request_id,message_kind,revision\)/);
  assert.match(route, /LIMIT_FILE_SIZE/);
  assert.match(route, /max: 6/);
  assert.match(route, /sms_consent_at,sms_consent_version/);
  assert.match(route, /nothing was submitted/i);
  assert.doesNotMatch(publicRoute, /sendSms|createEvent|INSERT INTO events|provisionDoneForYouClient/);
  assert.match(index, /app\.get\('\/flyer'/);
});

test('reviewed flyer requests enter the existing isolated editor without publishing', () => {
  const migration = read('src/db/migrations/062_flyer_request_editor_handoff.sql');
  const route = read('src/routes/flyer-intake.js');
  const workspace = read('src/lib/admin-editor-workspace.js');
  const editor = read('src/routes/admin-editor.js');
  const quickCreate = read('public/js/event-create.js');
  const detail = read('src/views/admin-flyer-request.html');

  assert.match(migration, /ADD COLUMN IF NOT EXISTS flyer_request_id/);
  assert.match(migration, /flyer_request_id IS DISTINCT FROM NEW\.flyer_request_id/);
  assert.match(route, /provisionDoneForYouClient/);
  assert.match(route, /flyer-intake\/:id\/editor-workspace/);
  assert.match(route, /flyer-intake\/:id\/ready/);
  assert.match(workspace, /flyer_request_id/);
  assert.match(editor, /flyerRequest/);
  assert.match(quickCreate, /presentation_mode: flyerRequestDefaults \? 'flyer' : 'standard'/);
  assert.match(quickCreate, /background_theme: flyerRequestDefaults \? 'adaptive' : 'midnight'/);
  assert.match(detail, /existing private Done For You editor/i);
  assert.match(route, /publishEventInTransaction/);
});

test('secure flyer previews expose only look, fix, and recipient approval controls', () => {
  const migration = read('src/db/migrations/063_flyer_preview_approval.sql');
  const route = read('src/routes/flyer-intake.js');
  const access = read('src/lib/flyer-preview-access.js');
  const publicRoute = read('src/routes/public.js');
  const script = read('public/js/flyer-preview.js');
  const css = read('public/css/flyer-preview.css');

  assert.match(migration, /admin_flyer_request_phone_challenges/);
  assert.match(migration, /never an account authentication credential/i);
  assert.match(access, /crypto\.randomBytes\(32\)/);
  assert.match(access, /preview_token_hash=\$1/);
  assert.match(route, /flyer-intake\/:id\/send-preview/);
  assert.match(route, /Your Silver Glider event page is ready!/);
  assert.match(route, /\/api\/flyer-preview\/look/);
  assert.match(route, /\/api\/flyer-preview\/fix/);
  assert.match(route, /\/api\/flyer-preview\/approve\/start/);
  assert.match(route, /\/api\/flyer-preview\/approve\/verify/);
  assert.match(route, /presentation_mode='flyer'/);
  assert.match(publicRoute, /readFlyerPreviewAccess/);
  assert.match(script, /Change the look/);
  assert.match(script, /Request a fix/);
  assert.match(script, /Looks good/);
  assert.match(css, /@media\(max-width:720px\)/);
  assert.doesNotMatch(route, /setSessionCookie|attachIdentity|account_phone_credentials/);
});

test('approved flyer publishing is Super Admin controlled, retry-safe, and records the real account claim', () => {
  const migration = read('src/db/migrations/064_flyer_publish_handoff.sql');
  const route = read('src/routes/flyer-intake.js');
  const auth = read('src/routes/auth.js');
  const editor = read('src/routes/admin-editor.js');
  const adminUi = read('public/js/admin-flyer-request.js');
  const editorUi = read('public/js/event-form.js');
  const mailer = read('src/lib/mailer.js');

  assert.match(migration, /claim_invitation_id/);
  assert.match(migration, /claim_invitation_status/);
  assert.match(route, /flyer-intake\/:id\/publish/);
  assert.match(route, /requireSuperAdmin/);
  assert.match(route, /message_kind='live'/);
  assert.match(route, /Your show is live!/);
  assert.match(route, /sendDoneForYouClaimInvitation/);
  assert.match(auth, /WHERE claim_invitation_id=\$1/);
  assert.match(editor, /flyer_request_publish_requires_approval/);
  assert.match(editorUi, /Save draft/);
  assert.match(adminUi, /Publish and notify/);
  assert.match(mailer, /sendDoneForYouWelcome/);
});

test('public flyer page asks for private identity, public host identity, and explicit text consent', () => {
  const html = read('src/views/flyer-intake.html');
  const script = read('public/js/flyer-intake.js');
  const css = read('public/css/flyer-intake.css');

  assert.match(html, /Your flyer deserves its own event page\./);
  assert.match(html, /id="flyer-name"[^>]*required/);
  assert.match(html, /id="flyer-host-name"[^>]*required/);
  assert.match(html, /id="flyer-phone"[^>]*required/);
  assert.match(html, /id="flyer-email"[^>]*required/);
  assert.match(html, /id="flyer-consent"[^>]*required/);
  assert.match(html, /text you a preview within 24 hours/);
  assert.match(script, /new FormData\(form\)/);
  assert.match(script, /5 \* 1024 \* 1024/);
  assert.match(css, /@media\(max-width:780px\)/);
  assert.match(css, /min-height:60px/);
});

test('submission normalization keeps account name and public host name separate', () => {
  const result = normalizeSubmission({
    submitterName: '  Adrian   Martinez ',
    hostName: ' Heat Wave Booking ',
    email: ' ADRIAN@EXAMPLE.COM ',
    phone: '(415) 555-0123',
    artworkCredit: '  Ziggy  ',
    smsConsent: 'yes'
  });
  assert.deepEqual(result, {
    submitterName: 'Adrian Martinez',
    hostName: 'Heat Wave Booking',
    email: 'adrian@example.com',
    phone: '+14155550123',
    artworkCredit: 'Ziggy'
  });
  assert.equal(SMS_CONSENT_VERSION, 'dfy-transactional-v1');
  assert.equal(normalizeSubmission({ submitterName: 'A', hostName: 'H' }).error, 'invalid_email');
  assert.equal(normalizeSubmission({
    submitterName: 'A', hostName: 'H', email: 'a@example.com', phone: '+14155550123'
  }).error, 'sms_consent_required');
});

test('Done For You exposes the pilot link, queue, metrics, and Super Admin switch', () => {
  const html = read('src/views/admin-done-for-you.html');
  const script = read('public/js/admin-done-for-you.js');
  const route = read('src/routes/flyer-intake.js');
  const auth = read('src/routes/admin-auth.js');

  assert.match(html, /value="https:\/\/silvergliderevents\.com\/flyer"/);
  assert.match(html, /Accepting Submissions/);
  assert.match(html, /New flyer requests/);
  assert.match(script, /api\('\/api\/admin\/done-for-you\/flyer-intake'/);
  assert.match(script, /api\('\/api\/admin\/done-for-you\/flyer-intake\/settings'/);
  assert.match(route, /requireSuperAdmin/);
  assert.match(route, /percentile_cont\(0\.5\)/);
  assert.match(auth, /manageFlyerIntake: dedicatedSuperAdmin/);
});
