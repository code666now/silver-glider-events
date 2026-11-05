const test = require('node:test');
const assert = require('node:assert/strict');
process.env.SESSION_SECRET ||= 'guest-import-unit-test-secret';
const { normalizeRows, inputDigest, signReview, readReview, validEmail } = require('../src/lib/guest-import');
const { buildImportedGuestInvitationEmail } = require('../src/lib/mailer');

test('guest import normalizes bounded rows, preserves order, and flags duplicate or invalid addresses', () => {
  const rows = normalizeRows([
    { name: '  Ada   Guest ', email: ' ADA@Example.test ' },
    { name: 'Duplicate', email: 'ada@example.test' },
    { email: 'bad\r\nBcc:other@example.test' },
    { email: 'other@example.test', name: '' }
  ]);
  assert.deepEqual(rows.map(row => row.status), ['ready', 'duplicate', 'invalid', 'ready']);
  assert.equal(rows[0].name, 'Ada Guest');
  assert.equal(rows[0].email, 'ada@example.test');
  assert.throws(() => normalizeRows(Array.from({ length: 101 }, () => ({ email: 'a@example.test' }))));
  assert.throws(() => normalizeRows([{ email: 'a'.repeat(513) }]));
  assert.throws(() => normalizeRows([{ email: {}, name: 'A' }]));
  assert.equal(normalizeRows([{ name: 'a'.repeat(121), email: 'a@example.test' }])[0].status, 'invalid');
  for (const value of ['a..b@example.test', '.a@example.test', 'a@-example.test', 'a@example', 'a@x..test', 'a@x_test.test']) {
    assert.equal(validEmail(value), false, value);
  }
});

test('guest import review is authenticated and binds normalized ordered rows', () => {
  const rows = normalizeRows([{ name: 'A', email: 'A@example.test' }, { name: 'B', email: 'B@example.test' }]);
  const data = { eventId: 12, organizerId: 7, rowsHash: inputDigest(rows), audienceHash: 'a', contextHash: 'b' };
  const token = signReview(data, 1000);
  assert.equal(readReview(token).expires, 901000);
  assert.equal(readReview(token).rowsHash, data.rowsHash);
  assert.equal(readReview(`${token}x`), null);
  assert.equal(readReview(`${token}.extra`), null);
  assert.notEqual(inputDigest(rows), inputDigest([...rows].reverse()));
  assert.equal(inputDigest(rows), inputDigest(normalizeRows([{ name: 'A', email: 'a@example.test' }, { name: 'B', email: 'b@example.test' }])));
});

test('import invitation is neutral, escaped, unsubscribable, and protects RSVP-only exact addresses', () => {
  const rendered = buildImportedGuestInvitationEmail({
    to: 'guest@example.test', recipientName: '<Ari>', organizerLabel: 'Host & Friends',
    event: { slug: 'new-night', title: 'Night <One>', event_date: '2099-01-01', start_time: '19:30',
      timezone: 'America/Los_Angeles', visibility: 'private', admission_type: 'free_rsvp',
      hide_address_until_rsvp: true, venue_name: 'Secret Hall', venue_address: '100 Hidden Lane',
      venue_city: 'San Francisco', venue_state: 'CA' },
    unsubscribeUrl: 'https://silvergliderevents.com/unsubscribe?token=example'
  });
  assert.match(rendered.html, /Host &amp; Friends/);
  assert.match(rendered.html, /Night &lt;One&gt;/);
  assert.match(rendered.html, /does not subscribe you to future updates/);
  assert.match(rendered.html, /Unsubscribe from Host &amp; Friends/);
  assert.match(rendered.html, /\/e\/new-night/);
  assert.doesNotMatch(rendered.html, /RSVP’d to|previous event|Secret Hall|100 Hidden Lane|\/g\//);
  assert.doesNotMatch(rendered.html, /<Ari>/);
  assert.equal(rendered.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});
