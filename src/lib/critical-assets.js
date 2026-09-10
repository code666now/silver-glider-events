const fs = require('node:fs');
const path = require('node:path');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const DEFAULT_PUBLIC_ROOT = path.join(__dirname, '..', '..', 'public');
const CRITICAL_PNG_ASSETS = Object.freeze([
  'logo.png',
  'images/email/calendar.png',
  'images/email/map.png',
  'images/email/manage.png',
  'images/email/music.png'
]);

function inspectCriticalPublicAssets(publicRoot = DEFAULT_PUBLIC_ROOT) {
  const missing = [];
  const invalid = [];

  for (const relativePath of CRITICAL_PNG_ASSETS) {
    try {
      const bytes = fs.readFileSync(path.join(publicRoot, relativePath));
      if (bytes.length <= PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        invalid.push(relativePath);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') missing.push(relativePath);
      else invalid.push(relativePath);
    }
  }

  return {
    ok: missing.length === 0 && invalid.length === 0,
    missing,
    invalid
  };
}

module.exports = { CRITICAL_PNG_ASSETS, inspectCriticalPublicAssets };
