const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'terms-content-update-unit-secret';
const { renderLegalPage } = require('../src/lib/legal-pages');
const {
  CURRENT_LEGAL_VERSIONS, REQUIRED_LEGAL_REVIEW_VERSION, legalDocumentSnapshots
} = require('../src/lib/legal-acceptance');
const {
  PREVIOUS_TERMS_VERSION, PREVIOUS_TERMS_HASH, CURRENT_TERMS_VERSION,
  ORIGINAL_SECTION_TEN, ADDED_PARAGRAPHS, ADDED_TEXT
} = require('./support/terms-content-update-fixture');
const terms = fs.readFileSync(path.join(__dirname, '../src/legal/terms.txt'), 'utf8');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

test('Section 10 appends the four requested paragraphs without replacing any existing Terms content', () => {
  assert.equal(terms.split(ADDED_TEXT).length, 2, 'the complete addition appears exactly once');
  assert.ok(terms.includes(`${ORIGINAL_SECTION_TEN}\n${ADDED_TEXT}11. Termination; Suspension; Refusal of Service\n`),
    'all four paragraphs follow the original Section 10 text and precede Section 11');
  assert.equal(hash(terms.replace(ADDED_TEXT, '')), PREVIOUS_TERMS_HASH,
    'every pre-existing byte of the Terms remains unchanged');
});

test('current Terms render all four additions as paragraphs in Section 10 while historical rendering stays unchanged', () => {
  const html = renderLegalPage('terms');
  const sectionTen = html.indexOf('<h2 id="10-content-intellectual-property">');
  const sectionEleven = html.indexOf('<h2 id="11-termination-suspension-refusal-of-service">');
  assert.ok(sectionTen > 0 && sectionEleven > sectionTen);
  let previousPosition = sectionTen;
  for (const paragraph of ADDED_PARAGRAPHS) {
    const rendered = `<p>${paragraph}</p>`;
    assert.equal(html.split(rendered).length, 2, 'each new paragraph is rendered exactly once');
    const position = html.indexOf(rendered);
    assert.ok(position > previousPosition && position < sectionEleven);
    previousPosition = position;
  }
  const historical = renderLegalPage('terms', {
    text: terms.replace(ADDED_TEXT, ''), version: PREVIOUS_TERMS_VERSION
  });
  for (const paragraph of ADDED_PARAGRAPHS) assert.equal(historical.includes(paragraph), false);
  assert.ok(historical.includes('<p>Silver Glider owns all rights in and to the Platform, including software, branding, and design.</p>'));
  assert.ok(historical.includes(`/terms?version=${PREVIOUS_TERMS_VERSION}`));
});

test('the additive Terms revision has its own snapshot without changing Privacy or the once-per-account review revision', () => {
  assert.deepEqual(CURRENT_LEGAL_VERSIONS, {
    terms: CURRENT_TERMS_VERSION, privacy: PREVIOUS_TERMS_VERSION, wording: PREVIOUS_TERMS_VERSION
  });
  assert.equal(REQUIRED_LEGAL_REVIEW_VERSION, 'account-review-v1');
  const snapshots = legalDocumentSnapshots();
  const currentTerms = snapshots.find(document => document.kind === 'terms');
  assert.equal(currentTerms.content, terms);
  assert.equal(currentTerms.contentHash, hash(terms));
  assert.notEqual(currentTerms.contentHash, PREVIOUS_TERMS_HASH);
  assert.equal(snapshots.find(document => document.kind === 'privacy').contentHash,
    'bb1155ad1cb8120a26372b09f8f2b384a2b66d952853b15e2f257f708e5430ea');
  assert.equal(snapshots.find(document => document.kind === 'wording').content,
    'Please review our Terms of Service and Privacy Policy to continue.\n\n' +
    'I agree to the Terms of Service and acknowledge the Privacy Policy.\n\n' +
    'Agree and continue\n\nSign out\n');
});
