const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  cleanHostSlug,
  cleanInstagramHandle,
  cleanProfileUrl,
  normalizeHostProfile
} = require('../src/lib/host-profile');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('host profile migration extends organizers without replacing stable identity fields', () => {
  const migration = source('src/db/migrations/014_host_page_profiles.sql');
  for (const column of ['header_image_url', 'bio', 'website_url', 'instagram_url', 'contact_email', 'updated_at']) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  }
  const original = source('src/db/migrations/009_public_host_profiles.sql');
  assert.match(original, /public_slug TEXT/);
  assert.match(original, /logo_url TEXT/);
  assert.match(original, /organizers_public_slug_unique/);
});

test('Instagram handle migration safely backfills existing profile URLs', () => {
  const migration = source('src/db/migrations/015_instagram_handles.sql');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS instagram_handle/);
  assert.match(migration, /instagram_url IS NOT NULL/);
  assert.match(migration, /instagram_handle=c\.handle/);
  assert.doesNotMatch(migration, /DROP COLUMN|DELETE FROM/);
});
test('host slug and link validation reject unsafe or misleading values', () => {
  assert.deepEqual(cleanHostSlug('heat-wave-booking'), { value: 'heat-wave-booking', error: null });
  assert.ok(cleanHostSlug('Heat Wave!').error);
  assert.ok(cleanHostSlug('-broken-').error);
  assert.equal(cleanProfileUrl('javascript:alert(1)', 'website').value, null);
  assert.equal(cleanProfileUrl('example.com', 'website').value, 'https://example.com/');
  assert.equal(cleanProfileUrl('https://instagram.com/silverglidertix', 'Instagram', { instagramOnly: true }).error, null);
  assert.ok(cleanProfileUrl('https://example.com/not-instagram', 'Instagram', { instagramOnly: true }).error);
});

test('Instagram handles accept friendly input and profile URLs but reject non-profiles', () => {
  assert.deepEqual(cleanInstagramHandle('@SilverGliderTix'), { value: 'silverglidertix', error: null });
  assert.deepEqual(cleanInstagramHandle('silver.glider_tix'), { value: 'silver.glider_tix', error: null });
  assert.deepEqual(cleanInstagramHandle('https://www.instagram.com/SilverGliderTix/?hl=en'), { value: 'silverglidertix', error: null });
  assert.ok(cleanInstagramHandle('https://instagram.com/p/abc123').error);
  assert.ok(cleanInstagramHandle('https://example.com/silverglidertix').error);
  assert.ok(cleanInstagramHandle('bad handle').error);
});

test('host profile normalization keeps contact details optional and server validated', () => {
  const parsed = normalizeHostProfile({
    org_name: ' Heat Wave Booking ',
    public_slug: 'heat-wave',
    bio: '  Independent events.  ',
    website_url: 'heatwave.example',
    instagram_handle: '@HeatWave',
    contact_email: 'HELLO@HEATWAVE.EXAMPLE'
  }, { public_slug: 'heat-wave' });
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.value, {
    orgName: 'Heat Wave Booking',
    publicSlug: 'heat-wave',
    bio: 'Independent events.',
    websiteUrl: 'https://heatwave.example/',
    instagramHandle: 'heatwave',
    contactEmail: 'hello@heatwave.example'
  });
  assert.ok(normalizeHostProfile({ org_name: '', bio: 'Orphan bio' }, {}).error);
  assert.ok(normalizeHostProfile({ org_name: 'Host', contact_email: 'not-an-email' }, {}).error);
  const preserved = normalizeHostProfile(
    { org_name: 'Host' },
    { public_slug: 'host', contact_email: 'bookings@example.com' }
  );
  assert.equal(preserved.value.contactEmail, 'bookings@example.com');
});

test('public host page separates upcoming and past public events in the requested order', () => {
  const routes = source('src/routes/public-hosts.js');
  assert.match(routes, /status='published'/);
  assert.match(routes, /visibility='public'/);
  assert.match(routes, /event_date >= CURRENT_DATE ORDER BY event_date ASC, start_time ASC/);
  assert.match(routes, /event_date < CURRENT_DATE ORDER BY event_date DESC, start_time DESC/);
  assert.match(routes, /No upcoming events yet\./);
  assert.match(routes, /No past events yet\./);

  const view = source('src/views/host-public.html');
  assert.ok(view.indexOf('{{HOST_HEADER}}') < view.indexOf('{{HOST_AVATAR}}'));
  assert.ok(view.indexOf('{{HOST_AVATAR}}') < view.indexOf('{{HOST_BIO}}'));
  assert.ok(view.indexOf('{{HOST_LINKS}}') < view.indexOf('Upcoming Events'));
  assert.ok(view.indexOf('Upcoming Events') < view.indexOf('Past Events'));
  assert.match(view, /<title>{{HOST_NAME}} events \| Silver Glider<\/title>/);
  assert.match(view, /Powered by <a href="\/">Silver Glider<\/a>/);
  assert.match(view, /data-host-follow/);
  assert.match(view, /\.host-owner-dashboard \{[\s\S]*?right:clamp\(24px,2vw,40px\)/);
  assert.match(view, /@media\(max-width:680px\)[\s\S]*?\.host-owner-dashboard \{ top:15px;right:16px;/);
});

test('host social links are conditional, icon-only, accessible, and safe', () => {
  const routes = source('src/routes/public-hosts.js');
  assert.match(routes, /aria-label="Instagram"/);
  assert.match(routes, /aria-label="Website"/);
  assert.match(routes, /target="_blank" rel="noopener noreferrer"/);
  assert.match(routes, /links\.length \? `<nav class="host-links"/);
  assert.match(routes, /hostInitials/);
  assert.match(routes, /cleanProfileUrl\(host\.header_image_url/);
  assert.match(routes, /cleanInstagramHandle\(host\.instagram_handle \|\| host\.instagram_url\)/);
});

test('event pages keep the linked Presented by host attribution', () => {
  const routes = source('src/routes/public.js');
  assert.match(routes, /<span>Presented by<\/span>/);
  assert.match(routes, /href="\/h\/\$\{encodeURIComponent\(event\.organizer_public_slug\)\}"/);
});

test('host and super-admin settings expose only the requested profile controls', () => {
  const settings = source('src/views/settings.html');
  for (const id of ['org_name', 'public_slug', 'bio', 'instagram_handle', 'website_url', 'header-input', 'logo-input']) {
    assert.match(settings, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(settings, /id="contact_email"|>Contact email</);
  assert.match(settings, /placeholder="@silverglidertix"/);
  const admin = source('src/views/admin-hosts.html');
  assert.match(admin, /id="host-profile-form"/);
  assert.match(admin, /\/api\/admin\/hosts\/\$\{activeHostId\}\/profile/);
  assert.doesNotMatch(admin, /profile-contact-email|>Contact email</);
  for (const excluded of ['Follow Host', 'Mailchimp', 'ticket-click', 'CRM', 'SMS']) {
    assert.equal(settings.includes(excluded), false);
    assert.equal(admin.includes(excluded), false);
  }
});

test('settings use progressive disclosure and separate account from host-page saves', () => {
  const settings = source('src/views/settings.html');
  assert.match(settings, /class="sg-shell settings-shell"/);
  assert.match(settings, /settings-account-card/);
  assert.match(settings, /settings-host-card/);
  assert.match(settings, /@media\(min-width:1024px\)[\s\S]*\.settings-shell\s*\{[\s\S]*max-width:1260px/);
  assert.match(settings, /grid-template-columns:minmax\(340px,\.78fr\) minmax\(0,1\.22fr\)/);
  assert.match(settings, /@media\(min-width:1200px\) and \(min-height:900px\)[\s\S]*position:sticky/);
  assert.match(settings, /@media\(max-width:560px\)/);
  assert.match(settings, /id="account-form"/);
  assert.match(settings, /id="account-save-btn">Save account</);
  assert.match(settings, /id="host-summary-view"[^>]*hidden>View page</);
  assert.match(settings, /\.host-summary-actions \[hidden\] \{ display:none; \}/);
  assert.match(settings, /id="host-editor-toggle"[^>]*aria-expanded="false"/);
  assert.match(settings, /class="host-editor" id="host-editor" hidden/);
  assert.match(settings, /id="host-profile-form"/);
  assert.match(settings, /id="host-save-btn">Save host page</);
  assert.ok(settings.indexOf('id="account-form"') < settings.indexOf('id="host-profile-form"'));
  assert.ok(settings.indexOf('id="host-summary-name"') < settings.indexOf('for="org_name"'));
  assert.doesNotMatch(settings, /id="settings-form"|id="save-btn"/);
});
