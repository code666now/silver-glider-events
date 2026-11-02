const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://silvergliderevents.com';

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const {
  buildHostRecapEmail,
  buildPostEventThankYouEmail,
  sendHostRecap,
  sendPostEventThankYou,
  devOutbox
} = require('../src/lib/mailer');

const event = {
  id: 42,
  title: 'Night <Two>',
  event_date: '2026-10-30',
  start_time: '20:00',
  end_time: '01:00',
  timezone: 'America/Los_Angeles',
  presentation_mode: 'flyer',
  flyer_image_url: 'https://res.cloudinary.com/demo/image/upload/sg-events/flyers/night-two.webp',
  cover_image_url: 'https://images.example.test/unused-cover.jpg',
  artwork_accent_color: '#20BDB7'
};

const stats = {
  markedGoing: 36,
  rsvpSubmissions: 23,
  additionalGuests: 13,
  returning: 3,
  newFaces: 20,
  comments: 2
};

const host = {
  id: 7,
  org_name: 'Host <Collective>',
  name: 'Adrian',
  public_slug: 'host-collective',
  email: 'host@example.test'
};

test('the recap worker keeps one-ever claims, retry safety, consent, account, and end-time gates', () => {
  const job = read('src/jobs/host-recap.js');
  const index = read('src/index.js');
  const migration = read('src/db/migrations/059_host_recap.sql');

  assert.match(job, /const \{ eventEndAtSql, loadPostEventContext \} = require\('\.\.\/lib\/post-event'\)/);
  assert.match(job, /NOW\(\) >= \(\$\{eventEnd\}\)/, 'the job cannot send before the configured or fallback end');
  assert.match(job, /\(\(\(\(\$\{eventEnd\}\) AT TIME ZONE e\.timezone\) - INTERVAL '10 hours'\)::date \+ 1\)[\s\S]*= \(NOW\(\) AT TIME ZONE e\.timezone\)::date/,
    'an overnight event is due at the first local 10am after it ends, not a day late');
  assert.match(job, /const RECAP_HOURS = \[10, 11, 12, 13\]/);
  assert.match(job, /UPDATE events SET host_recap_sent_at=NOW\(\)\s*\n\s*WHERE id=\$1 AND host_recap_sent_at IS NULL/);
  assert.match(job, /releaseRecap\(event\.id\)/, 'a failed send is retried');
  assert.match(job, /EXISTS \(SELECT 1 FROM rsvps WHERE event_id=e\.id AND status='confirmed'\)/);
  assert.match(job, /emailOptedOut\(pool, hostEmail, 'host_recaps'\)/);
  assert.match(job, /withActiveHostAccount/, 'a suspended host is never emailed');
  assert.match(job, /identity\.verification_scope='account'/, 'the recipient email is account-verified');
  assert.match(job, /loadPostEventContext\(pool, \{[\s\S]*eventId: event\.id,[\s\S]*organizerId: event\.organizer_id/);
  assert.match(job, /stats: context\.stats/);
  assert.match(job, /idempotencyKey: `sge-host-recap-v2-\$\{event\.id\}`/);
  assert.doesNotMatch(job, /o\.email AS host_email/, 'legacy contact email is not a delivery credential');
  assert.match(index, /require\('\.\/jobs\/host-recap'\)\.startHostRecapCron\(\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS host_recap_sent_at TIMESTAMPTZ/);
});

test('host recap preview is artwork-led, accurate, neutral, and has one primary action', () => {
  const email = buildHostRecapEmail({
    event,
    stats,
    unsubscribeUrl: 'https://silvergliderevents.com/unsubscribe-email?token=host-safe',
    manageUrl: 'https://silvergliderevents.com/email-settings?token=host-safe'
  });

  assert.equal(email.subject, 'Your night, revisited: Night <Two>');
  assert.match(email.html, /class="sg-event-artwork"/);
  assert.match(email.html, /night-two\.webp/);
  assert.match(email.html, /width:100%;max-width:620px;height:auto;display:block/);
  assert.ok(email.html.indexOf('class="sg-event-artwork"') < email.html.indexOf('Your night, revisited'));
  for (const [value, label] of [
    [36, 'Marked going'],
    [23, 'RSVP submissions'],
    [13, 'Additional guests'],
    [3, 'Returning faces'],
    [20, 'New faces'],
    [2, 'Comments']
  ]) {
    assert.match(email.html, new RegExp(`>${value}<[\\s\\S]*>${label}<`));
  }
  assert.equal((email.html.match(/class="sg-email-cta"/g) || []).length, 1);
  assert.match(email.html, />See your night<\/a>/);
  assert.match(email.html, /\/events\/42\/manage\?postEvent=recap/);
  assert.match(email.html, /not verified attendance/);
  assert.doesNotMatch(email.html, /photo|actually came|verified attendance[^<]*36/i);
  assert.doesNotMatch(email.html, /venue_address|unused-cover|Create your next event/);
  assert.match(email.text, /36 marked going[\s\S]*23 RSVP submissions[\s\S]*13 additional guests/);
});

test('host recap delivery preserves one-click preferences and provider idempotency', async () => {
  devOutbox.length = 0;
  await sendHostRecap({
    to: 'host@example.test',
    event,
    stats,
    unsubscribeUrl: 'https://silvergliderevents.com/unsubscribe-email?token=host-safe',
    manageUrl: 'https://silvergliderevents.com/email-settings?token=host-safe',
    idempotencyKey: 'sge-host-recap-v2-42'
  });
  const sent = devOutbox.at(-1);
  assert.equal(sent.idempotencyKey, 'sge-host-recap-v2-42');
  assert.equal(sent.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(sent.headers['List-Unsubscribe'], /host-safe/);
  assert.match(sent.text, /See your night:/);
});

test('thank-you preview escapes host copy and offers only the existing Host Page', () => {
  const email = buildPostEventThankYouEmail({
    event,
    host,
    subject: 'Thanks\r\nBcc: bad@example.test',
    message: 'What a <night>!\n<script>bad()</script>',
    includeFollow: true,
    alreadyFollowing: false
  });

  assert.equal(email.subject, 'Thanks Bcc: bad@example.test');
  assert.match(email.html, /What a &lt;night&gt;!<br>&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(email.html, /<script>|bad\(\)<\/script>/);
  assert.match(email.html, /class="sg-event-artwork"/);
  assert.match(email.html, /Follow our page for more events/);
  assert.match(email.html, /https:\/\/silvergliderevents\.com\/h\/host-collective/);
  assert.match(email.html, /Preview only — the sent email includes the recipient’s unsubscribe link/);
  assert.doesNotMatch(email.html, /\/e\/|\/events\/42|venue|address|unused-cover/i);
  assert.match(email.text, /Follow Host Collective: https:\/\/silvergliderevents\.com\/h\/host-collective/);
  assert.match(email.text, /Preview only/);
});

test('thank-you suppresses an unnecessary follow prompt for an existing follower', () => {
  const email = buildPostEventThankYouEmail({
    event,
    host,
    subject: 'Thank you',
    message: 'See you next time.',
    includeFollow: true,
    alreadyFollowing: true,
    unsubscribeUrl: 'https://silvergliderevents.com/unsubscribe-email?token=guest-safe'
  });
  assert.doesNotMatch(email.html, /Follow our page|\/h\/host-collective/);
  assert.equal((email.html.match(/class="sg-email-cta"/g) || []).length, 0);
  assert.match(email.html, /RSVP’d to Night &lt;Two&gt; and opted into emails from Host Collective/);
  assert.match(email.html, /Unsubscribe from emails from this host/);
  assert.match(email.html, /490 Post Street, Suite 500/);
});

test('thank-you delivery requires unsubscribe and idempotency, then uses host sender conventions', async () => {
  const base = {
    to: 'guest@example.test', event, host, subject: 'Thank you', message: 'See you next time.',
    includeFollow: false, alreadyFollowing: false
  };
  await assert.rejects(
    sendPostEventThankYou({ ...base, idempotencyKey: 'thank-you-42-1' }),
    /valid unsubscribe URL/
  );
  await assert.rejects(
    sendPostEventThankYou({ ...base, unsubscribeUrl: 'https://silvergliderevents.com/unsubscribe-email?token=safe' }),
    /idempotency key/
  );

  devOutbox.length = 0;
  const result = await sendPostEventThankYou({
    ...base,
    unsubscribeUrl: 'https://silvergliderevents.com/unsubscribe-email?token=safe',
    idempotencyKey: 'sge-post-event-thanks-42-99-v1'
  });
  assert.deepEqual(result, { dev: true });
  const sent = devOutbox.at(-1);
  assert.equal(sent.from, '"Host Collective via Silver Glider" <events@silverglidertickets.com>');
  assert.equal(sent.replyTo, 'host@example.test');
  assert.equal(sent.idempotencyKey, 'sge-post-event-thanks-42-99-v1');
  assert.equal(sent.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(sent.text, /Unsubscribe from emails from this host/);
});
