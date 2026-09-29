const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.SESSION_SECRET ||= 'email-compliance-unit-secret';
process.env.APP_URL ||= 'https://silvergliderevents.com';

const {
  signEmailPreference,
  verifyEmailPreference,
  emailPreferenceUrls,
  emailOptedOut,
  setEmailPreference
} = require('../src/lib/email-preferences');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('optional email preference links are signed, scoped, and tamper-resistant', () => {
  const token = signEmailPreference(' Host@Example.Test ', 'host_recaps');
  assert.deepEqual(verifyEmailPreference(token), {
    email: 'host@example.test',
    scope: 'host_recaps'
  });
  assert.equal(verifyEmailPreference(`${token.slice(0, -1)}x`), null);
  assert.throws(() => signEmailPreference('host@example.test', 'security'), /Invalid email preference/);

  const urls = emailPreferenceUrls('host@example.test', 'host_recaps');
  assert.match(urls.manageUrl, /^https:\/\/silvergliderevents\.com\/email-settings\?token=/);
  assert.match(urls.unsubscribeUrl, /^https:\/\/silvergliderevents\.com\/unsubscribe-email\?token=/);
});

test('optional preferences store only opt-outs and can be turned back on', async () => {
  const queries = [];
  const db = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (/^SELECT 1 FROM email_optouts/.test(sql)) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    }
  };
  assert.equal(await emailOptedOut(db, 'HOST@example.test', 'host_recaps'), true);
  await setEmailPreference(db, 'HOST@example.test', 'host_recaps', false);
  await setEmailPreference(db, 'HOST@example.test', 'host_recaps', true);
  assert.match(queries[1].sql, /INSERT INTO email_optouts/);
  assert.deepEqual(queries[1].values, ['host@example.test', 'host_recaps']);
  assert.match(queries[2].sql, /DELETE FROM email_optouts/);
});

test('email policy separates optional unsubscribe from essential notices', () => {
  const migration = read('src/db/migrations/060_email_preferences.sql');
  const routes = read('src/routes/email-preferences.js');
  const publicRoutes = read('src/routes/public.js');
  const mailer = read('src/lib/mailer.js');
  const recap = read('src/jobs/host-recap.js');
  const commerce = read('src/routes/commerce.js');

  assert.match(migration, /scope IN \('host_recaps', 'product_updates'\)/);
  assert.equal((migration.match(/scope IN \([^\n]+\)/g) || []).length, 1);
  assert.match(routes, /router\.post\('\/unsubscribe-email'/);
  assert.match(routes, /router\.post\('\/api\/email-settings\/host'/);
  assert.match(publicRoutes, /router\.post\('\/api\/email\/unsubscribe\/rsvp\/:token'/);
  assert.match(mailer, /'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'/);
  assert.match(recap, /emailOptedOut\(pool, hostEmail, 'host_recaps'\)/);
  assert.match(commerce, /optout\.scope='product_updates'/);
});

test('host-led mail uses the host identity while commercial footers use only the Silver Glider address', () => {
  const mailer = read('src/lib/mailer.js');
  assert.match(mailer, /490 Post Street, Suite 500/);
  assert.match(mailer, /San Francisco, CA 94102/);
  assert.match(mailer, /function hostFrom\(hostLabel\)/);
  assert.match(mailer, /from: hostFrom\(organizerLabel\)[\s\S]*subject: `\$\{organizerLabel\} just announced:/);
  assert.match(mailer, /from: hostFrom\(hostLabel\)[\s\S]*subject: `Tomorrow:/);
  assert.doesNotMatch(mailer, /COMPANY_ADDRESS[\s\S]{0,160}venue_address/);
  assert.match(mailer, /includeAddress: true,[\s\S]*Unsubscribe from/);
});
