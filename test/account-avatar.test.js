const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('personal avatars extend accounts and RSVPs without changing Host Page artwork', () => {
  const migration = read('src/db/migrations/026_account_avatars.sql');
  assert.match(migration, /ALTER TABLE organizers[\s\S]*ADD COLUMN IF NOT EXISTS avatar_url TEXT/);
  assert.match(migration, /ALTER TABLE rsvps[\s\S]*ADD COLUMN IF NOT EXISTS account_id INT REFERENCES organizers\(id\) ON DELETE SET NULL/);
  assert.doesNotMatch(migration, /UPDATE rsvps|DROP COLUMN|DELETE FROM/);

  const settings = read('src/views/settings.html');
  assert.match(settings, /id="account-avatar-title">Your RSVP photo/);
  assert.match(settings, /Your Host Page logo stays separate/);
  assert.match(settings, /id="account-avatar-fallback">😎/);
  assert.match(settings, /id="account-avatar-btn"[^>]*>Add photo/);
  assert.match(settings, /id="account-avatar-remove" hidden>Remove photo/);
});

test('profile-photo changes are bound to the authenticated session', () => {
  const uploads = read('src/routes/uploads.js');
  const auth = read('src/routes/auth.js');

  assert.match(uploads, /router\.post\('\/api\/uploads\/avatar', requireOrganizer, handleUpload/);
  assert.match(uploads, /UPDATE organizers SET avatar_url=\$2[\s\S]*WHERE id=\$1/);
  assert.match(uploads, /\[req\.organizer\.id, result\.secure_url\]/);
  assert.doesNotMatch(uploads, /api\/uploads\/users\/:|api\/users\/:.*avatar/);

  assert.match(auth, /router\.get\('\/api\/me', requireOrganizer/);
  assert.match(auth, /router\.patch\('\/api\/me\/profile', requireOrganizer/);
  assert.match(auth, /UPDATE organizers SET avatar_url=NULL[\s\S]*WHERE id=\$1/);
  assert.match(auth, /\[req\.organizer\.id\]/);
});

test('guest-list avatars link only through a verified matching session and keep smiley fallbacks', () => {
  const routes = read('src/routes/public.js');
  const cloudinary = read('src/lib/cloudinary.js');

  assert.match(routes, /verifiedSessionAccountId\(client, req, email\)/);
  assert.match(routes, /SELECT id FROM organizers WHERE id=\$1 AND LOWER\(email\)=LOWER\(\$2\)/);
  assert.match(routes, /LEFT JOIN organizers o ON o\.id=r\.account_id/);
  assert.match(routes, /account_id=COALESCE\(account_id,\$10\)/);
  assert.match(routes, /guest-avatar/);
  assert.match(cloudinary, /CLOUDINARY_ACCOUNT_AVATAR_FOLDER/);
  assert.match(cloudinary, /width: 512, height: 512, crop: 'fill', gravity: 'auto'/);
});
