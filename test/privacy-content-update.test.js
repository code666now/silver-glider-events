const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'privacy-content-update-unit-secret';
const { renderLegalPage } = require('../src/lib/legal-pages');
const {
  CURRENT_LEGAL_VERSIONS, REQUIRED_LEGAL_REVIEW_VERSION, legalDocumentSnapshots
} = require('../src/lib/legal-acceptance');
const {
  PREVIOUS_PRIVACY_VERSION, PREVIOUS_PRIVACY_HASH, CURRENT_PRIVACY_VERSION,
  ADDED_HEADING, ADDED_PARAGRAPHS, ADDED_TEXT
} = require('./support/privacy-content-update-fixture');
const privacy = fs.readFileSync(path.join(__dirname, '../src/legal/privacy.txt'), 'utf8');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

test('Section 13 adds the exact requested Children\'s Privacy text and preserves every existing policy byte', () => {
  assert.equal(privacy.split(ADDED_TEXT).length, 2);
  assert.ok(privacy.includes(`${ADDED_TEXT}Contact\n`));
  assert.equal(hash(privacy.replace(ADDED_TEXT, '')), PREVIOUS_PRIVACY_HASH);
});

test('Children\'s Privacy renders as Section 13 with a contents link, four paragraphs and a working email link', () => {
  const html = renderLegalPage('privacy');
  const heading = `<h2 id="13-children-s-privacy">${ADDED_HEADING}</h2>`;
  assert.ok(html.includes(heading));
  assert.ok(html.includes(`<a href="#13-children-s-privacy">${ADDED_HEADING}</a>`));
  const start = html.indexOf(heading);
  const end = html.indexOf('<h2 id="contact">Contact</h2>');
  assert.ok(end > start);
  const section = html.slice(start, end);
  for (const paragraph of ADDED_PARAGRAPHS) {
    const linked = paragraph.replace('support@silverglidertickets.com',
      '<a href="mailto:support@silverglidertickets.com">support@silverglidertickets.com</a>');
    assert.equal(section.split(`<p>${linked}</p>`).length, 2);
  }
  const historical = renderLegalPage('privacy', {
    text: privacy.replace(ADDED_TEXT, ''), version: PREVIOUS_PRIVACY_VERSION
  });
  assert.equal(historical.includes(ADDED_HEADING), false);
  assert.ok(historical.includes(`/privacy?version=${PREVIOUS_PRIVACY_VERSION}`));
});

test('Privacy revision has a new snapshot but preserves Terms and the existing once-per-account review', () => {
  assert.deepEqual(CURRENT_LEGAL_VERSIONS, {
    terms: '2026-11-11', privacy: CURRENT_PRIVACY_VERSION, wording: '2026-11-10'
  });
  assert.equal(REQUIRED_LEGAL_REVIEW_VERSION, 'account-review-v1');
  const snapshots = legalDocumentSnapshots();
  const current = snapshots.find(document => document.kind === 'privacy');
  assert.equal(current.content, privacy);
  assert.equal(current.contentHash, hash(privacy));
  assert.notEqual(current.contentHash, PREVIOUS_PRIVACY_HASH);
  assert.equal(snapshots.find(document => document.kind === 'terms').contentHash,
    'ee858d05eaee1bb3fcee272f433a43c06e75d2590d75beed494fc089d711171b');
});
