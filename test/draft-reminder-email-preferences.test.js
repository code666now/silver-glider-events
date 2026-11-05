const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.SESSION_SECRET ||= 'draft-reminder-preference-test-secret';
process.env.APP_URL = 'https://silvergliderevents.com';

const { buildDraftReminderEmail } = require('../src/lib/draft-reminder-email');
const {
  EMAIL_PREFERENCE_SCOPES, emailOptedOut, setEmailPreference,
  signEmailPreference, verifyEmailPreference, emailPreferenceUrls
} = require('../src/lib/email-preferences');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const links = {
  unsubscribeUrl: 'https://silvergliderevents.com/unsubscribe-email?token=unit-only',
  manageUrl: 'https://silvergliderevents.com/email-settings?token=unit-only'
};

test('draft email has one resume action, private-draft context, and scoped unsubscribe in both formats', () => {
  const email = buildDraftReminderEmail({ event: { id: 41, title: 'Music & friends' }, ...links });
  assert.equal(email.subject, 'Your event draft is saved');
  assert.match(email.html, /class="sg-email-shell"/);
  assert.equal((email.html.match(/>Continue my event<\/a>/g) || []).length, 1);
  assert.match(email.html, /login\?next=%2Fevents%2F41%2Fedit/);
  assert.match(email.html, /Music &amp; friends/);
  for (const format of [email.html, email.text]) {
    assert.match(format, /Your event stays private until you publish/);
    assert.match(format, /Nothing has been shared with guests/);
    assert.match(format, /one reminder per draft, at most once every seven days/);
    assert.match(format, /Turn off draft reminders/);
    assert.doesNotMatch(format, /50 texts|buy|invite your guests|follow my page|share your event/i);
  }
});

test('draft renderer escapes user content, bounds titles, rejects unsafe destinations and never guesses an event', () => {
  const email = buildDraftReminderEmail({ event: { id: 41, title: '<img src=x onerror="boom()">\n& hello' }, ...links });
  assert.match(email.html, /&lt;img src=x onerror=&quot;boom\(\)&quot;&gt; &amp; hello/);
  assert.doesNotMatch(email.html, /<img src=x/);
  assert.match(email.text, /<img src=x/);
  assert.doesNotMatch(email.subject, /[\r\n]/);
  assert.match(buildDraftReminderEmail({ event: { id: 41, title: ' ' }, ...links }).text, /Your event\nYour event stays private/);
  assert.doesNotMatch(buildDraftReminderEmail({ event: { id: 41, title: 'x'.repeat(400) }, ...links }).text, /x{301}/);
  for (const id of [undefined, 0, -1, 'bad', 1.5]) assert.throws(() => buildDraftReminderEmail({ event: { id }, ...links }), /valid draft event ID/);
  assert.throws(() => buildDraftReminderEmail({ event: { id: 1 }, ...links, unsubscribeUrl: 'javascript:alert(1)' }), /valid unsubscribe URL/);
  assert.throws(() => buildDraftReminderEmail({ event: { id: 1 }, ...links, manageUrl: '' }), /valid email settings URL/);
});

test('draft category has independently signed preference tokens and visible frequency/privacy copy', () => {
  const token = signEmailPreference(' HOST@example.test ', 'host_drafts');
  assert.deepEqual(verifyEmailPreference(token), { email: 'host@example.test', scope: 'host_drafts' });
  assert.equal(verifyEmailPreference(`${token}invalid`), null);
  assert.equal(EMAIL_PREFERENCE_SCOPES.host_drafts.consentVersion, 'host_drafts_v1');
  assert.match(EMAIL_PREFERENCE_SCOPES.host_drafts.description, /one optional reminder/);
  assert.match(EMAIL_PREFERENCE_SCOPES.host_drafts.description, /every seven days/);
  assert.match(EMAIL_PREFERENCE_SCOPES.host_drafts.description, /private until you publish/);
  for (const url of Object.values(emailPreferenceUrls('host@example.test', 'host_drafts'))) {
    assert.deepEqual(verifyEmailPreference(new URL(url).searchParams.get('token')), { email: 'host@example.test', scope: 'host_drafts' });
  }
});

function preferenceFixture() {
  const optouts = new Map(), optins = new Map(), queries = [];
  let timestamp = 0;
  const db = { async query(sql, values) {
    queries.push({ sql, values });
    const [, scope] = values;
    if (sql.startsWith('DELETE FROM email_optouts')) optouts.delete(scope);
    else if (sql.includes('INSERT INTO email_optouts')) optouts.set(scope, ++timestamp);
    else if (sql.startsWith('DELETE FROM email_optins')) optins.delete(scope);
    else if (sql.includes('INSERT INTO email_optins')) optins.set(scope, { timestamp: ++timestamp, version: values[2] });
    else if (sql.startsWith('SELECT 1 FROM email_optouts optout')) {
      assert.match(sql, /optout.scope=\$2 OR/);
      assert.match(sql, /optout.scope IN \('host_onboarding','host_followups'\)/);
      assert.match(sql, /optin.consent_version=\$3/);
      assert.match(sql, /optin.updated_at > optout.updated_at/);
      const override = optins.get(scope);
      const inherited = ['host_onboarding', 'host_followups'].some(other => optouts.has(other) &&
        !(override?.version === values[2] && override.timestamp > optouts.get(other)));
      return { rows: optouts.has(scope) || inherited ? [{}] : [] };
    } else if (sql.includes('SELECT 1 FROM email_optins')) {
      return { rows: optins.get(scope)?.version === values[2] && !optouts.has(scope) ? [{}] : [] };
    } else if (sql.startsWith('SELECT 1 FROM email_optouts')) return { rows: optouts.has(scope) ? [{}] : [] };
    return { rows: [] };
  } };
  return { db, optouts, optins, queries };
}

test('draft default does not change the independent default-off next-event follow-up category', async () => {
  const { db } = preferenceFixture();
  assert.equal(await emailOptedOut(db, 'host@example.test', 'host_followups'), true);
  assert.equal(await emailOptedOut(db, 'host@example.test', 'host_drafts'), false);
});

test('drafts respect inherited opt-outs; only a newer explicit draft choice overrides them', async () => {
  const { db, optouts, optins, queries } = preferenceFixture();
  const email = 'HOST@example.test';
  await setEmailPreference(db, email, 'host_onboarding', false);
  assert.equal(await emailOptedOut(db, email, 'host_drafts'), true);
  await setEmailPreference(db, email, 'host_drafts', true);
  assert.equal(await emailOptedOut(db, email, 'host_drafts'), false);
  assert.equal(optouts.has('host_onboarding'), true, 'enabling drafts must not enable setup tips');
  await setEmailPreference(db, email, 'host_followups', false);
  assert.equal(await emailOptedOut(db, email, 'host_drafts'), true, 'newer inherited opt-out wins');
  await setEmailPreference(db, email, 'host_drafts', true);
  assert.equal(await emailOptedOut(db, email, 'host_drafts'), false);
  assert.equal(await emailOptedOut(db, email, 'host_followups'), true, 'draft opt-in cannot grant next-event permission');
  optins.get('host_drafts').timestamp = optouts.get('host_followups');
  assert.equal(await emailOptedOut(db, email, 'host_drafts'), true, 'equal timestamps are not newer consent');
  await setEmailPreference(db, email, 'host_drafts', true);
  optins.get('host_drafts').version = 'old_version';
  assert.equal(await emailOptedOut(db, email, 'host_drafts'), true);
  assert.ok(queries.every(query => query.values[0] === 'host@example.test'));
});

test('a direct draft opt-out wins and is reversible without changing unrelated preferences', async () => {
  const { db, optins } = preferenceFixture();
  await setEmailPreference(db, 'host@example.test', 'host_drafts', true);
  await setEmailPreference(db, 'host@example.test', 'host_drafts', false);
  assert.equal(optins.has('host_drafts'), false);
  assert.equal(await emailOptedOut(db, 'host@example.test', 'host_drafts'), true);
  optins.set('host_drafts', { timestamp: 100, version: 'host_drafts_v1' });
  assert.equal(await emailOptedOut(db, 'host@example.test', 'host_drafts'), true, 'direct opt-out cannot be overridden by a stale opt-in row');
  await setEmailPreference(db, 'host@example.test', 'host_drafts', true);
  assert.equal(await emailOptedOut(db, 'host@example.test', 'host_drafts'), false);
});

test('existing host email settings expose drafts and reconcile inherited changes without concurrent saves', () => {
  const route = read('src/routes/email-preferences.js');
  const view = read('src/views/email-settings.html');
  assert.match(route, /\['host_onboarding', 'host_followups', 'host_recaps'\]\.includes\(data.scope\)/);
  assert.match(route, /data-email-scope="host_drafts"/);
  assert.match(route, /result.draftsEnabled = !await emailOptedOut/);
  assert.match(view, /settingsInputs.forEach\(setting => \{ setting.disabled = true;/);
  assert.match(view, /draftInput.checked = data.draftsEnabled/);
  assert.match(view, /settingsInputs.forEach\(setting => \{ setting.disabled = false;/);
});
