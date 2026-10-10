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
  assert.match(route, /flyer-intake\/:id\/recover-draft/);
  assert.match(route, /flyer_request_recovery_has_live_activity/);
  assert.match(workspace, /flyer_request_id/);
  assert.match(workspace, /\/admin\/done-for-you\/flyer-requests\/\$\{Number\(workspace\.flyer_request_id\)\}/);
  assert.match(editor, /flyerRequest/);
  assert.match(quickCreate, /presentation_mode: flyerRequestDefaults \? 'flyer' : 'standard'/);
  assert.match(quickCreate, /background_theme: flyerRequestDefaults \? 'adaptive' : 'midnight'/);
  assert.match(detail, /existing private Done For You editor/i);
  assert.match(route, /publishEventInTransaction/);
  assert.match(read('public/js/admin-flyer-request.js'), /Return to private draft/);
  assert.match(read('public/js/admin-flyer-request.js'), /preview text is sent only after Super Admin review/i);
});

test('secure flyer previews expose look, fix, and verified auto-publish controls', () => {
  const migration = read('src/db/migrations/063_flyer_preview_approval.sql');
  const route = read('src/routes/flyer-intake.js');
  const access = read('src/lib/flyer-preview-access.js');
  const publicRoute = read('src/routes/public.js');
  const selfServe = read('src/routes/events.js');
  const script = read('public/js/flyer-preview.js');
  const css = read('public/css/flyer-preview.css');
  const getPreviewRoute = route.slice(
    route.indexOf("router.get('/api/flyer-preview'"),
    route.indexOf("router.post('/api/flyer-preview/look'")
  );

  assert.match(migration, /admin_flyer_request_phone_challenges/);
  assert.match(migration, /never an account authentication credential/i);
  assert.match(access, /crypto\.randomBytes\(32\)/);
  assert.match(access, /preview_token_hash=\$1/);
  assert.match(route, /flyer-intake\/:id\/send-preview/);
  assert.match(route, /Your Silver Glider event page is ready!/);
  assert.match(route, /router\.get\('\/preview\/:token'/);
  assert.doesNotMatch(route, /router\.get\('\/p\/:token'/);
  assert.match(route, /\/api\/flyer-preview\/look/);
  assert.match(route, /\/api\/flyer-preview\/fix/);
  assert.match(route, /\/api\/flyer-preview\/approve\/start/);
  assert.match(route, /\/api\/flyer-preview\/approve\/verify/);
  assert.match(route, /router\.post\('\/api\/flyer-preview\/publish'/);
  assert.match(getPreviewRoute, /status:\s*preview\.status/);
  assert.match(getPreviewRoute, /published:\s*preview\.status\s*===\s*'published'/);
  assert.match(getPreviewRoute, /eventUrl/);
  assert.match(route, /presentation_mode='flyer'/);
  assert.match(publicRoute, /readFlyerPreviewAccess/);
  assert.match(script, /Change the look/);
  assert.match(script, /Request a fix/);
  assert.match(publicRoute, /data-preview-action="approve"[^>]*>[^<]*publish/i);
  assert.doesNotMatch(publicRoute, /data-preview-action="approve"[^>]*>Looks good</i);
  assert.match(publicRoute, /data-preview-action="retry"[^>]*>Try publishing again</i);
  assert.match(script, /action === 'retry'[\s\S]*?showPublishRetry\(''\)[\s\S]*?retryPublication\(document\.getElementById\('flyer-publish-retry'\)\)/);
  assert.match(script, /\/api\/flyer-preview\/publish/);
  assert.match(script, /function showShare\(data, \{ celebrate = false \} = \{\}\)/);
  assert.match(script, /celebrate \? confettiHtml\(\) : ''/);
  assert.match(script, /showShare\(result, \{ celebrate: true \}\)/);
  assert.match(script, /showShare\(current, \{ celebrate: true \}\)/);
  assert.match(script, /load\(true\)\.then\(showShare\)/);
  assert.match(script, />Share your event<\/h2>/);
  assert.match(script, /Your event is live\. Here’s your link!/);
  assert.match(script, />Your event link<\/span>/);
  assert.match(script, />Copy link<\/span>/);
  assert.match(script, />Share event<\/span>/);
  assert.match(script, /Your event is published and ready to share\./);
  assert.match(script, /state\.eventUrl\.replace\(\/\^https\?:/);
  assert.doesNotMatch(script, /showCelebration|flyer-publish-continue|Your event is published!/);
  assert.match(script, /navigator\.share/);
  assert.match(script, /navigator\.clipboard|execCommand\(['"]copy['"]\)/);
  assert.match(script, /navigator\.clipboard[\s\S]*?catch \(_\)[\s\S]*?document\.execCommand\('copy'\)/);
  assert.doesNotMatch(script, /Home Base/i);
  assert.match(script, /flyer-publish-share/);
  assert.match(css, /\.flyer-publish-step/);
  assert.match(css, /\.flyer-publish-confirmation/);
  assert.match(css, /\.flyer-publish-confetti/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
  assert.match(`${script}\n${css}`, /prefers-reduced-motion/);
  assert.match(selfServe, /router\.post\('\/api\/events\/:id\/publish'/);
  assert.doesNotMatch(route, /setSessionCookie|attachIdentity|account_phone_credentials/);
});

test('verified flyer approval auto-publishes once and exposes a public retry without another OTP', () => {
  const migration = read('src/db/migrations/064_flyer_publish_handoff.sql');
  const route = read('src/routes/flyer-intake.js');
  const auth = read('src/routes/auth.js');
  const editor = read('src/routes/admin-editor.js');
  const adminUi = read('public/js/admin-flyer-request.js');
  const editorUi = read('public/js/event-form.js');
  const mailer = read('src/lib/mailer.js');
  const publicationJob = read('src/jobs/flyer-publication-notifications.js');
  const verifyRoute = route.slice(
    route.indexOf("router.post('/api/flyer-preview/approve/verify'"),
    route.indexOf("router.use('/api/admin/done-for-you/flyer-intake'")
  );
  const publicPublishRoute = route.slice(
    route.indexOf("router.post('/api/flyer-preview/publish'"),
    route.indexOf("router.use('/api/admin/done-for-you/flyer-intake'")
  );

  assert.match(migration, /claim_invitation_id/);
  assert.match(migration, /claim_invitation_status/);
  assert.match(verifyRoute, /completeApprovedFlyer/);
  assert.match(route, /approvedFlyerRequestId/);
  assert.match(route, /router\.post\('\/api\/flyer-preview\/publish'/);
  assert.match(publicPublishRoute, /promoter_approved/);
  assert.match(publicPublishRoute, /published/);
  assert.doesNotMatch(route, /\/api\/admin\/done-for-you\/flyer-intake\/:id\/publish/);
  assert.match(route, /status:\s*'published'/);
  assert.match(route, /published:\s*true/);
  assert.match(route, /event:\s*\{[\s\S]*?url:/);
  assert.match(`${route}\n${publicationJob}`, /['"]live['"]/);
  assert.match(publicationJob, /['"]pilot_publish['"]/);
  assert.match(publicationJob, /\+14152053302/);
  assert.match(publicationJob, /Your show is live!/);
  assert.match(publicationJob, /sendDoneForYouClaimInvitation/);
  assert.match(auth, /WHERE claim_invitation_id=\$1/);
  assert.match(editor, /flyer_request_publish_requires_approval/);
  assert.match(editorUi, /Save draft & return/);
  assert.doesNotMatch(adminUi, /Publish and notify/);
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
  assert.match(html, /class="flyer-intake-preview-empty" id="flyer-preview-empty"[^>]*type="button"/);
  assert.match(html, /<legend>About you<\/legend>/);
  assert.match(html, /<legend>About the show<\/legend>/);
  assert.match(html, /This stays private and becomes your account name if you’re new\./);
  assert.match(html, /The promoter, venue, collective, artist, or public name guests should see\./);
  assert.match(html, /We’ll text you when the page is ready\./);
  assert.match(html, /Used later to securely claim your Home Base\./);
  assert.match(html, /images\/flyer-intake\/boombox\.png/);
  assert.match(html, /images\/flyer-intake\/music-notes\.png/);
  assert.match(html, /images\/flyer-intake\/disco-ball\.png/);
  assert.match(html, /text you a preview within 24 hours/);
  assert.match(script, /new FormData\(form\)/);
  assert.match(script, /previewEmpty\.addEventListener\('click'/);
  assert.match(script, /previewCard\.classList\.add\('has-file'\)/);
  assert.match(script, /5 \* 1024 \* 1024/);
  assert.match(css, /@media\(max-width:780px\)/);
  assert.match(css, /\.flyer-intake-benefits \{ display:grid; grid-template-columns:repeat\(3/);
  assert.match(css, /\.flyer-benefit \{[^}]*background:#f7f2e8/);
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
