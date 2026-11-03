// Pure shared profile-handle parsing. Existing Host Page behavior is retained;
// narrower consumers may validate the original URL before using this parser.
function cleanInstagramHandle(value) {
  let raw = String(value ?? '').trim();
  if (!raw) return { value: null, error: null };
  if (raw.length > 500) return { value: null, error: 'Instagram handle is too long' };

  let handle = raw;
  try {
    if (/instagram\.com\//i.test(raw)) {
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
      const url = new URL(raw);
      const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
      const parts = url.pathname.split('/').filter(Boolean);
      if (!['http:', 'https:'].includes(url.protocol) || hostname !== 'instagram.com' || parts.length !== 1) {
        throw new Error('profile');
      }
      handle = decodeURIComponent(parts[0]);
    } else {
      handle = raw.replace(/^@/, '');
    }
  } catch (_) {
    return { value: null, error: 'Enter an Instagram handle like @silverglidertix' };
  }

  handle = handle.trim().toLowerCase();
  if (handle.length > 30 || !/^[a-z0-9._]+$/.test(handle) ||
      handle.startsWith('.') || handle.endsWith('.') || handle.includes('..')) {
    return { value: null, error: 'Enter an Instagram handle like @silverglidertix' };
  }
  return { value: handle, error: null };
}

module.exports = { cleanInstagramHandle };
