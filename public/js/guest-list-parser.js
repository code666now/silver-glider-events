(function (root, factory) {
  'use strict';
  const parser = factory();
  if (typeof module === 'object' && module.exports) module.exports = parser;
  else root.SGGuestListParser = parser;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_ROWS = 100;
  const MAX_BYTES = 64 * 1024;
  const MAX_COLUMNS = 20;
  const emailLike = value => /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(String(value || '').trim());
  const labelKey = value => String(value || '').trim().toLowerCase().replace(/[\s_\-]+/g, '');
  const emailHeaders = new Set(['email', 'emailaddress', 'guestemail', 'emailaddressrequired']);
  const nameHeaders = new Set(['name', 'fullname', 'guestname', 'recipientname']);
  const firstHeaders = new Set(['firstname', 'givenname']);
  const lastHeaders = new Set(['lastname', 'surname', 'familyname']);

  function pastedEmails(text) {
    const rows = [];
    // Separators outside quoted display names. Invalid entries remain visible
    // for correction; parsing never silently discards an address.
    const chunks = text.replace(/>\s+(?=\S)/g, '>\n').match(/(?:"[^"]*"|[^,;\r\n])+/g) || [];
    for (const chunk of chunks) {
      const value = chunk.trim();
      if (!value) continue;
      const tokens = value.split(/\s+/);
      if (tokens.length > 1 && tokens.every(emailLike)) {
        rows.push(...tokens.map(email => ({ name: '', email })));
      } else {
        const match = value.match(/^(.*?)\s*<([^<>]+)>$/) || value.match(/^(.*?)\s+([^\s]+@[^\s]+)$/);
        rows.push(match && !match[1].includes('@')
          ? { name: match[1].trim().replace(/^"(.*)"$/, '$1'), email: match[2].trim() }
          : { name: '', email: value });
      }
    }
    return rows;
  }

  function failure(error) {
    return { columns: [], rows: [], needsMapping: false, mapping: null, error };
  }

  function delimiterFor(text) {
    let quoted = false;
    const counts = { '\t': 0, ',': 0, ';': 0 };
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (char === '"') {
        if (quoted && text[i + 1] === '"') i += 1;
        else quoted = !quoted;
      } else if (!quoted) {
        if (char === '\n' || char === '\r') break;
        if (Object.hasOwn(counts, char)) counts[char] += 1;
      }
    }
    // Tabs from spreadsheet paste take precedence over commas inside names.
    return counts['\t'] ? '\t' : counts[','] ? ',' : counts[';'] ? ';' : null;
  }

  function recordsFor(text, delimiter) {
    const records = [];
    let record = [];
    let field = '';
    let quoted = false;
    let closed = false;
    function finishField() {
      record.push(field.trim());
      field = '';
      closed = false;
      if (record.length > MAX_COLUMNS) throw new Error(`Use a file with no more than ${MAX_COLUMNS} columns.`);
    }
    function finishRecord() {
      finishField();
      if (record.some(value => value !== '')) records.push(record);
      record = [];
      if (records.length > MAX_ROWS + 1) throw new Error(`Import up to ${MAX_ROWS} people at a time. Split your list into smaller groups.`);
    }
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (quoted) {
        if (char === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 1; }
          else { quoted = false; closed = true; }
        } else field += char;
      } else if (delimiter && char === delimiter) finishField();
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[i + 1] === '\n') i += 1;
        finishRecord();
      } else if (char === '"' && field.trim() === '' && !closed) {
        field = ''; quoted = true;
      } else if (closed && !/\s/.test(char)) {
        throw new Error('One row has a misplaced quote. Check the CSV, or paste your list from the spreadsheet.');
      } else field += char;
    }
    if (quoted) throw new Error('One row has an unfinished quote. Check the CSV, or paste your list from the spreadsheet.');
    finishRecord();
    return records;
  }

  function parse(text, options = {}) {
    if (typeof text !== 'string') return failure('Paste a list or choose a UTF-8 CSV file.');
    if (new TextEncoder().encode(text).length > MAX_BYTES) return failure('This list is too large. Use a CSV under 64 KB with up to 100 people.');
    if (text.includes('\0')) return failure('Save your spreadsheet as a UTF-8 CSV, or copy and paste its cells here.');
    text = text.replace(/^\uFEFF/, '').trim();
    if (!text) return failure('Add at least one email address to continue.');
    // Explicit paste mode supports mailbox lists; detected CSV headers or tabs
    // still take the spreadsheet path so pasted spreadsheet cells keep names.
    const firstLine = text.split(/[\r\n]/)[0];
    const knownHeader = firstLine.split(/[,;\t]/).some(value => emailHeaders.has(labelKey(value)));
    const bareEmails = text.split(/[\s,;]+/).every(emailLike);
    if (!Object.hasOwn(options, 'emailColumn') && !text.includes('\t') && !knownHeader &&
        (bareEmails || options.mode === 'emails')) {
      const rows = pastedEmails(text);
      if (rows.length > MAX_ROWS) return failure(`Import up to ${MAX_ROWS} people at a time. Split your list into smaller groups.`);
      return { columns: ['Email'], rows, needsMapping: false, mapping: { emailColumn: 0, nameColumn: -1, hasHeader: false } };
    }
    let records;
    const delimiter = delimiterFor(text);
    try { records = recordsFor(text, delimiter); }
    catch (error) { return failure(error.message); }
    if (!records.length) return failure('Add at least one email address to continue.');
    if (!delimiter && !Object.hasOwn(options, 'emailColumn')) {
      // A plain email per line is common. Display-name syntax is convenient,
      // but does not prove identity or grant permission to send anything.
      const hasHeader = emailHeaders.has(labelKey(records[0][0]));
      const source = hasHeader ? records.slice(1) : records;
      if (source.length > MAX_ROWS) return failure(`Import up to ${MAX_ROWS} people at a time. Split your list into smaller groups.`);
      const rows = source.map(record => {
        const value = record[0];
        const bracketed = value.match(/^(.*?)\s*<([^<>]+)>$/);
        const spaced = value.match(/^(.*?)\s+([^\s]+@[^\s]+)$/);
        const match = bracketed || spaced;
        return match ? { name: match[1].trim(), email: match[2].trim() } : { name: '', email: value };
      });
      return { columns: ['Email'], rows, needsMapping: false, mapping: { emailColumn: 0, nameColumn: -1, hasHeader } };
    }

    const width = Math.max(...records.map(record => record.length));
    const header = records[0].map(labelKey);
    const knownEmails = header.flatMap((label, index) => emailHeaders.has(label) ? [index] : []);
    const knownNames = header.flatMap((label, index) => nameHeaders.has(label) ? [index] : []);
    const firstNames = header.flatMap((label, index) => firstHeaders.has(label) ? [index] : []);
    const lastNames = header.flatMap((label, index) => lastHeaders.has(label) ? [index] : []);
    const hasHeader = typeof options.hasHeader === 'boolean' ? options.hasHeader : knownEmails.length > 0 || knownNames.length > 0 || firstNames.length > 0 || lastNames.length > 0;
    const source = hasHeader ? records.slice(1) : records;
    if (!source.length) return failure('This list only has column headings. Add an email address below them.');
    if (source.length > MAX_ROWS) return failure(`Import up to ${MAX_ROWS} people at a time. Split your list into smaller groups.`);
    const possibleEmails = Array.from({ length: width }, (_, index) => index).filter(index => source.some(record => emailLike(record[index])));
    let emailColumn = Number.isInteger(options.emailColumn) ? options.emailColumn
      : knownEmails.length === 1 && hasHeader ? knownEmails[0]
        : possibleEmails.length === 1 ? possibleEmails[0] : -1;
    let nameColumn = Number.isInteger(options.nameColumn) ? options.nameColumn
      : knownNames.length === 1 && hasHeader ? knownNames[0]
        : !hasHeader && width === 2 && emailColumn >= 0 ? 1 - emailColumn : -1;
    const needsMapping = emailColumn < 0 || emailColumn >= width || nameColumn < -1 || nameColumn >= width || nameColumn === emailColumn;
    const columns = Array.from({ length: width }, (_, index) => hasHeader ? (records[0][index] || `Column ${index + 1}`) : `Column ${index + 1}`);
    return {
      columns,
      rows: needsMapping ? [] : source.map(record => ({
        name: (nameColumn >= 0 ? String(record[nameColumn] || '')
          : hasHeader && !Number.isInteger(options.nameColumn) && firstNames.length <= 1 && lastNames.length <= 1
            ? [record[firstNames[0]], record[lastNames[0]]].filter(Boolean).join(' ') : '').replace(/[\r\n]+/g, ' '),
        email: record[emailColumn] || ''
      })),
      needsMapping,
      mapping: { emailColumn, nameColumn, hasHeader },
      sample: source.slice(0, 3).map(record => Array.from({ length: width }, (_, index) => record[index] || ''))
    };
  }

  return { parse, MAX_ROWS, MAX_BYTES, MAX_COLUMNS };
});
