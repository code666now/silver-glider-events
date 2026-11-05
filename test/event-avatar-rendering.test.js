const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const client = read('public/js/manage.js');
const api = read('public/js/api.js');
const helpers = [
  api.slice(api.indexOf('function sgSafeHttpUrl('), api.indexOf('function sgAccountDisplayName(')),
  client.slice(client.indexOf('function escapeHtml('), client.indexOf('const createdFromEventFlow')),
  client.slice(client.indexOf('function familiarInitials('), client.indexOf('function familiarFaceCard('))
].join('\n');

function render(face) {
  return vm.runInNewContext(`${helpers}\nfamiliarAvatar(face);`, {
    URL, location: { origin: 'https://example.test' }, face
  });
}

test('event-only bride badge preserves the familiar face photo', () => {
  const html = render({ name: 'Example guest', avatarUrl: 'https://res.cloudinary.com/demo/image/upload/photo.jpg', avatarEmoji: '👰', avatarBadge: '👰' });
  assert.match(html, /^<img src="https:\/\/res\.cloudinary\.com\/demo\/image\/upload\/photo\.jpg" alt="" loading="lazy">/);
  assert.match(html, /<i class="familiar-face-badge" aria-hidden="true">👰<\/i>$/);
  assert.doesNotMatch(html, /familiar-face-emoji/);
});

test('photos do not receive badges by default or from unrecognized badge values', () => {
  const base = { name: 'Example guest', avatarUrl: 'https://res.cloudinary.com/demo/image/upload/photo.jpg', avatarEmoji: '🐬' };
  for (const avatarBadge of [undefined, '', '🐬', '<img src=x onerror=alert(1)>']) {
    const html = render({ ...base, avatarBadge });
    assert.match(html, /^<img /);
    assert.doesNotMatch(html, /familiar-face-badge|onerror|🐬/);
  }
});

test('without a photo, event-specific or marine emojis stay the full avatar', () => {
  for (const avatarEmoji of ['👰', '🐳', '🐟', '🐬', '🦭', '🦀']) {
    assert.equal(render({ name: 'Example guest', avatarEmoji, avatarBadge: '👰' }), `<span class="familiar-face-emoji" aria-hidden="true">${avatarEmoji}</span>`);
  }
});

test('unsafe photos use the escaped emoji fallback without a badge', () => {
  const html = render({ name: 'Example guest', avatarUrl: 'javascript:alert(1)', avatarEmoji: '<svg onload=alert(1)>', avatarBadge: '👰' });
  assert.equal(html, '<span class="familiar-face-emoji" aria-hidden="true">&lt;svg onload=alert(1)&gt;</span>');
  assert.doesNotMatch(html, /<svg|<img|familiar-face-badge/);
  assert.equal(render({ name: 'Example Guest' }), '<span class="familiar-face-emoji" aria-hidden="true">EG</span>');
});

test('both public layouts keep circular photos and place event badges opposite the edit control', () => {
  for (const relative of ['public/css/event-public-flyer.css', 'src/views/event-public.html']) {
    const styles = read(relative);
    assert.match(styles, /(?:^|\n)\s*\.guest-avatar \{[^}]*overflow:\s*visible;/);
    assert.match(styles, /\.guest-avatar img \{[^}]*border-radius:inherit;/);
    assert.match(styles, /\.guest-avatar-badge \{[^}]*left:0;bottom:0;[^}]*pointer-events:none;/);
    assert.match(styles, /\.guest-avatar-edit b \{[^}]*right:-3px;bottom:-3px;/);
  }
  const familiarStyles = read('public/css/familiar-faces.css');
  assert.match(familiarStyles, /\.familiar-face-avatar \{[^}]*position:relative;[^}]*overflow:visible;/);
  assert.match(familiarStyles, /\.familiar-face-avatar img \{[^}]*border-radius:inherit;/);
  assert.match(familiarStyles, /\.familiar-face-badge \{[^}]*left:0;bottom:0;[^}]*pointer-events:none;/);
});
