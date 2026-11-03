const { cleanInstagramHandle } = require('./instagram-handle');

const THANK_YOU_CREDITS_MAX = 3;

class ThankYouCreditsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ThankYouCreditsError';
    this.status = 400;
    this.code = 'invalid_credits';
  }
}

function creditInstagramHandle(value) {
  const raw = String(value ?? '').trim();
  if (raw.includes('/') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    try {
      const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
      const url = new URL(candidate);
      const authority = candidate.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i)?.[1] || '';
      const parts = url.pathname.split('/').filter(Boolean);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || /:\d+$/.test(authority) ||
          !['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase()) || parts.length !== 1 ||
          /^(?:p|reel|reels|tv|stories|explore|accounts|direct)$/i.test(decodeURIComponent(parts[0]))) {
        throw new Error('profile');
      }
    } catch (_) { throw new ThankYouCreditsError('Enter an Instagram handle or profile link'); }
  }
  const instagram = cleanInstagramHandle(value);
  if (instagram.error) throw new ThankYouCreditsError(instagram.error);
  if (instagram.value && /^(?:p|reel|reels|tv|stories|explore|accounts|direct)$/i.test(instagram.value)) {
    throw new ThankYouCreditsError('Enter an Instagram handle or profile link');
  }
  return instagram.value;
}

function normalizeThankYouCredits(value) {
  if (!Array.isArray(value) || value.length > THANK_YOU_CREDITS_MAX) {
    throw new ThankYouCreditsError('Add up to three people to thank');
  }
  return value.map(person => {
    if (!person || typeof person !== 'object' || Array.isArray(person) || typeof person.name !== 'string' ||
        (person.role != null && typeof person.role !== 'string') ||
        (person.instagramHandle != null && typeof person.instagramHandle !== 'string')) {
      throw new ThankYouCreditsError('Add a name for each credit');
    }
    const name = person.name.trim().replace(/\s+/g, ' ');
    const role = String(person.role || '').trim().replace(/\s+/g, ' ');
    if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new ThankYouCreditsError('Each name must be 1–100 characters');
    }
    if (role.length > 80 || /[\u0000-\u001f\u007f]/.test(role)) {
      throw new ThankYouCreditsError('Each role must be 80 characters or fewer');
    }
    return { name, role, instagramHandle: creditInstagramHandle(person.instagramHandle) };
  });
}

module.exports = { THANK_YOU_CREDITS_MAX, ThankYouCreditsError, normalizeThankYouCredits };
