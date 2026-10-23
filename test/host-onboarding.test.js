const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://silvergliderevents.com';
process.env.SESSION_SECRET ||= 'host-onboarding-unit-secret';

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const {
  devOutbox,
  sendFirstEventNudge,
  sendHostProfileNudge
} = require('../src/lib/mailer');
const {
  emailPreferenceUrls,
  signEmailPreference,
  verifyEmailPreference
} = require('../src/lib/email-preferences');

async function capture(sendEmail) {
  devOutbox.length = 0;
  await sendEmail();
  const message = devOutbox.at(-1);
  assert.ok(message?.html, 'expected a rendered development email');
  return message;
}

test('host onboarding schema is additive, optional, and does not enroll existing Host Pages', () => {
  const migration = read('src/db/migrations/071_host_onboarding.sql');

  for (const column of [
    'host_page_created_at',
    'host_page_success_seen_at',
    'host_profile_nudge_sent_at',
    'first_event_nudge_sent_at',
    'first_event_published_at'
  ]) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column} TIMESTAMPTZ`));
  }
  assert.match(migration, /'host_recaps', 'product_updates', 'host_onboarding'/);
  assert.doesNotMatch(migration, /UPDATE\s+organizers\s+SET\s+host_page_created_at/i,
    'existing Host Pages are never backfilled into onboarding');
  assert.match(migration, /CREATE TRIGGER events_mark_first_publication[\s\S]*NEW\.status = 'published'/);
  assert.match(migration, /first_event_published_at=COALESCE\(first_event_published_at,NOW\(\)\)/);

  const profile = read('src/lib/host-profile.js');
  assert.equal((profile.match(/host_page_created_at/g) || []).length, 2,
    'the timestamp appears only in the new-slug update and its COALESCE expression');
  assert.match(profile, /host_page_created_at=COALESCE\(host_page_created_at,NOW\(\)\)[\s\S]*WHERE id=\$1 AND public_slug IS NULL/);
});

test('host onboarding email preference is independently signed and reversible', () => {
  const token = signEmailPreference(' Host@Example.Test ', 'host_onboarding');
  assert.deepEqual(verifyEmailPreference(token), {
    email: 'host@example.test',
    scope: 'host_onboarding'
  });
  const urls = emailPreferenceUrls('host@example.test', 'host_onboarding');
  assert.match(urls.unsubscribeUrl, /^https:\/\/silvergliderevents\.com\/unsubscribe-email\?token=/);
  assert.match(urls.manageUrl, /^https:\/\/silvergliderevents\.com\/email-settings\?token=/);
});

test('the worker gates recipients, content, ordering, and concurrent claims', () => {
  const job = read('src/jobs/host-onboarding.js');

  assert.match(job, /const EMAIL_SCOPE = 'host_onboarding'/);
  assert.match(job, /identity\.verification_scope='account'/);
  assert.match(job, /identity\.verified_at IS NOT NULL/);
  assert.match(job, /identity\.revoked_at IS NULL/);
  assert.match(job, /account\.account_status='active'/);
  assert.doesNotMatch(job, /host\.email AS|o\.email AS/, 'legacy contact email is never a delivery credential');
  assert.match(job, /host_page_created_at <= NOW\(\) - INTERVAL '24 hours'/);
  assert.match(job, /host_page_created_at <= NOW\(\) - INTERVAL '72 hours'/);
  assert.match(job, /first_event_published_at IS NULL/,
    'a publication milestone permanently stops first-event prompts');
  for (const field of ['logo_url', 'bio', 'instagram_handle', 'website_url']) {
    assert.match(job, new RegExp(`NULLIF\\(BTRIM\\(host\\.${field}\\),'\\'\\) IS NULL`));
  }
  assert.match(job, /event\.status='draft'/);
  assert.match(job, /host_profile_nudge_sent_at <= NOW\(\) - INTERVAL '24 hours'/,
    'a second email cannot follow the profile email inside 24 hours');
  assert.doesNotMatch(job, /SET host_profile_nudge_sent_at=NOW\(\)[\s\S]*RETURNING/,
    'sent timestamps are not used as pre-send claims');
  assert.doesNotMatch(job, /claimedAt|releaseClaim/,
    'delivery no longer depends on lossy timestamp equality');
  const profileSend = job.indexOf('await sendHostProfileNudge');
  const profileMark = job.indexOf("return markNudgeSent(host.id, 'host_profile_nudge_sent_at')");
  const eventSend = job.indexOf('await sendFirstEventNudge');
  const eventMark = job.indexOf("return markNudgeSent(host.id, 'first_event_nudge_sent_at')");
  assert.ok(profileSend > 0 && profileMark > profileSend, 'profile delivery is marked only after send success');
  assert.ok(eventSend > 0 && eventMark > eventSend, 'event delivery is marked only after send success');
  assert.match(job, /withActiveHostAccount\(pool, host\.id, async \(\) => \{[\s\S]*eligibleProfileNudge/);
  assert.match(job, /withActiveHostAccount\(pool, host\.id, async \(\) => \{[\s\S]*eligibleFirstEventNudge/);
  assert.match(job, /sge-host-onboarding-profile-v1-\$\{host\.id\}/);
  assert.match(job, /sge-host-onboarding-first-event-v1-\$\{host\.id\}/);
  assert.match(job, /withActiveHostAccount/);
  assert.match(job, /emailOptedOut\(pool, email, EMAIL_SCOPE\)/);

  const profileLoop = job.indexOf('for (const host of await pendingProfileNudges())');
  const eventLoop = job.indexOf('for (const host of await pendingFirstEventNudges())');
  assert.ok(profileLoop > 0 && eventLoop > profileLoop, 'profile delivery is processed before event delivery');
});

test('onboarding mail uses one-click preferences and safe post-login destinations', async () => {
  const preferences = {
    unsubscribeUrl: 'https://silvergliderevents.com/unsubscribe-email?token=safe',
    manageUrl: 'https://silvergliderevents.com/email-settings?token=safe'
  };
  const profile = await capture(() => sendHostProfileNudge({
    to: 'host@example.test',
    hostName: 'Late Night People',
    hostPageUrl: 'https://silvergliderevents.com/h/late-night-people',
    ...preferences,
    idempotencyKey: 'profile-key'
  }));
  assert.equal(profile.idempotencyKey, 'profile-key');
  assert.equal(profile.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(profile.html, /Finish your Host Page/);
  assert.match(profile.html, /\/login\?next=%2Fsettings%2Fhost-page/);
  assert.match(profile.html, /Turn off Host Page setup tips/);
  assert.match(profile.html, /Manage host emails/);

  const draft = await capture(() => sendFirstEventNudge({
    to: 'host@example.test',
    draftEvent: { id: 42, title: 'Night at the Arcade' },
    ...preferences,
    idempotencyKey: 'event-key'
  }));
  assert.equal(draft.subject, 'Your first event is waiting');
  assert.equal(draft.idempotencyKey, 'event-key');
  assert.match(draft.html, /Continue your event/);
  assert.match(draft.html, /\/login\?next=%2Fevents%2F42%2Fedit/);

  const blank = await capture(() => sendFirstEventNudge({
    to: 'host@example.test',
    draftEvent: null,
    ...preferences,
    idempotencyKey: 'blank-key'
  }));
  assert.equal(blank.subject, 'Ready to put something on the calendar?');
  assert.match(blank.html, /Create your first event/);
  assert.match(blank.html, /\/login\?next=%2Fevents%2Fnew/);
});

test('authenticated onboarding state is private, one-time, and mounted with its worker', () => {
  const route = read('src/routes/host-onboarding.js');
  const index = read('src/index.js');

  assert.match(route, /router\.get\('\/api\/host-onboarding', requireOrganizer/);
  assert.match(route, /router\.post\('\/api\/host-onboarding\/seen', requireOrganizer/);
  assert.match(route, /showHostPageSuccess:/);
  assert.match(route, /hostPageUrl:/);
  assert.match(route, /profileComplete/);
  assert.match(route, /hasEvent:/);
  assert.match(route, /hostName:/);
  assert.match(route, /host_page_success_seen_at=COALESCE\(host_page_success_seen_at,NOW\(\)\)/);
  assert.match(route, /Cache-Control', 'private, no-store'/);
  assert.match(index, /app\.use\(require\('\.\/routes\/host-onboarding'\)\)/);
  assert.match(index, /require\('\.\/jobs\/host-onboarding'\)\.startHostOnboardingCron\(\)/);
});
