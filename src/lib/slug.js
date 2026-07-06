const crypto = require('crypto');

function slugify(title) {
  return String(title)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

function randomBase36(len) {
  let out = '';
  while (out.length < len) {
    out += parseInt(crypto.randomBytes(4).toString('hex'), 16).toString(36);
  }
  return out.slice(0, len);
}

// Public: readable slug + short suffix, e.g. "vinyl-night-at-the-knockout-x7k2"
function makePublicSlug(title) {
  const base = slugify(title) || 'event';
  return `${base}-${randomBase36(4)}`;
}

// Private: unguessable — the link IS the access control
function makePrivateSlug() {
  return crypto.randomBytes(8).toString('hex');
}

module.exports = { makePublicSlug, makePrivateSlug, slugify };
