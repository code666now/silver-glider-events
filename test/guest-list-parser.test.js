const test = require('node:test');
const assert = require('node:assert/strict');
const parser = require('../public/js/guest-list-parser');

test('guest list recognizes first and last name headers and prefers full name when present', () => {
  assert.deepEqual(parser.parse('First Name,Last Name,Email\nAna,Ríos,ana@example.test').rows,
    [{ name: 'Ana Ríos', email: 'ana@example.test' }]);
  assert.deepEqual(parser.parse('Email,Last_Name,First_Name,Full Name\na@example.test,Ríos,Ana,Ana R.').rows,
    [{ name: 'Ana R.', email: 'a@example.test' }]);
});

test('pasted mailbox lists accept all separators and names without silently losing invalid entries', () => {
  const expected = ['a','b','c','d'].map(value => ({ name: '', email: `${value}@example.test` }));
  assert.deepEqual(parser.parse('a@example.test, b@example.test;c@example.test d@example.test').rows, expected);
  assert.deepEqual(parser.parse('"Ríos, Ana" <ana@example.test>; Bo Test <bo@example.test>\ninvalid', { mode: 'emails' }).rows,
    [{ name: 'Ríos, Ana', email: 'ana@example.test' }, { name: 'Bo Test', email: 'bo@example.test' }, { name: '', email: 'invalid' }]);
  assert.deepEqual(parser.parse('Name,Email\nAna,ana@example.test', { mode: 'emails' }).rows,
    [{ name: 'Ana', email: 'ana@example.test' }]);
});

test('guest list parses spreadsheet tabs and CSV with optional names and headers', () => {
  for (const delimiter of [',', '\t', ';']) {
    const result = parser.parse(`Name${delimiter}Email\r\nEmber Test${delimiter}ember@example.test\r\n${delimiter}cedar@example.test`);
    assert.equal(result.needsMapping, false);
    assert.deepEqual(result.rows, [{ name: 'Ember Test', email: 'ember@example.test' }, { name: '', email: 'cedar@example.test' }]);
  }
  assert.deepEqual(parser.parse('Email Address,Full Name\nember@example.test,Ember').rows, [{ name: 'Ember', email: 'ember@example.test' }]);
});

test('guest list preserves quoted commas, escaped quotes, Unicode, BOM and multiline names', () => {
  const result = parser.parse('\uFEFFName,Email\n"Ríos, Ana ""A""",ana@example.test\n"Cedar\nTest",cedar@example.test\n\n');
  assert.deepEqual(result.rows, [{ name: 'Ríos, Ana "A"', email: 'ana@example.test' }, { name: 'Cedar Test', email: 'cedar@example.test' }]);
});

test('guest list accepts one mailbox per line and display names without inventing email addresses', () => {
  assert.deepEqual(parser.parse('ember@example.test\nCedar Test <cedar@example.test>\nNova Test nova@example.test\ninvalid').rows, [
    { name: '', email: 'ember@example.test' }, { name: 'Cedar Test', email: 'cedar@example.test' },
    { name: 'Nova Test', email: 'nova@example.test' }, { name: '', email: 'invalid' }
  ]);
  assert.deepEqual(parser.parse('Email\nember@example.test').rows, [{ name: '', email: 'ember@example.test' }]);
});

test('guest list detects unheaded email columns but asks when ambiguous and supports explicit mapping', () => {
  assert.deepEqual(parser.parse('ember@example.test,Ember').rows, [{ name: 'Ember', email: 'ember@example.test' }]);
  const ambiguous = 'Contact,Primary,Backup\nEmber,ember@example.test,other@example.test';
  assert.equal(parser.parse(ambiguous).needsMapping, true);
  const mapped = parser.parse(ambiguous, { hasHeader: true, emailColumn: 1, nameColumn: 0 });
  assert.deepEqual(mapped.rows, [{ name: 'Ember', email: 'ember@example.test' }]);
  assert.deepEqual(mapped.columns, ['Contact', 'Primary', 'Backup']);
  assert.equal(parser.parse(ambiguous, { hasHeader: true, emailColumn: 0, nameColumn: 0 }).needsMapping, true);
});

test('guest list never silently truncates rows, columns or oversized input', () => {
  const rows = Array.from({ length: 100 }, (_, i) => `Test ${i},test${i}@example.test`);
  assert.equal(parser.parse(`Name,Email\n${rows.join('\n')}`).rows.length, 100);
  assert.match(parser.parse(`Name,Email\n${rows.join('\n')}\nExtra,extra@example.test`).error, /100/);
  assert.match(parser.parse(Array.from({ length: 101 }, (_, i) => `t${i}@example.test`).join('\n')).error, /100/);
  assert.match(parser.parse('a'.repeat(65537)).error, /64 KB/);
  assert.match(parser.parse('é'.repeat(32769)).error, /64 KB/);
  assert.match(parser.parse(Array(21).fill('x').join(',')).error, /20 columns/);
});

test('guest list rejects malformed CSV, binary encoding and empty input while leaving row validation to server', () => {
  assert.match(parser.parse('Name,Email\n"broken,ember@example.test').error, /unfinished quote/);
  assert.match(parser.parse('Name,Email\n"Ember"junk,ember@example.test').error, /misplaced quote/);
  assert.match(parser.parse('e\0m\0a\0i\0l').error, /UTF-8/);
  assert.match(parser.parse('  ').error, /at least one/);
  assert.match(parser.parse('Name,Email').error, /column headings/);
  assert.deepEqual(parser.parse('Name,Email\n=1+2,<script>').rows, [{ name: '=1+2', email: '<script>' }]);
  assert.equal(parser.parse('Name,Email\nEmber,not-an-email').needsMapping, false);
});
