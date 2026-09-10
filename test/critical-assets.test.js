const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CRITICAL_PNG_ASSETS, inspectCriticalPublicAssets } = require('../src/lib/critical-assets');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test('critical public image assets are present and valid PNG files', () => {
  assert.deepEqual(inspectCriticalPublicAssets(), { ok: true, missing: [], invalid: [] });
});

test('critical public image inspection reports omitted and invalid deployment assets', t => {
  const publicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sge-critical-assets-'));
  t.after(() => fs.rmSync(publicRoot, { recursive: true, force: true }));

  for (const relativePath of CRITICAL_PNG_ASSETS) {
    const absolutePath = path.join(publicRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, Buffer.concat([PNG_SIGNATURE, Buffer.from([1])]));
  }

  fs.rmSync(path.join(publicRoot, 'logo.png'));
  fs.writeFileSync(path.join(publicRoot, 'images/email/calendar.png'), 'not a png');

  assert.deepEqual(inspectCriticalPublicAssets(publicRoot), {
    ok: false,
    missing: ['logo.png'],
    invalid: ['images/email/calendar.png']
  });
});
