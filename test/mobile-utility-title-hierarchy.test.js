const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('mobile utility pages use the shared compact title hierarchy', () => {
  const login = read('src/views/login.html');
  const rsvp = read('src/views/rsvp-manage.html');
  const addPhoto = read('public/css/add-photo.css');
  const photoUpload = read('src/views/event-photo-upload.html');

  assert.match(login, /\.auth-heading \{[^}]*font-size:var\(--sg-mobile-page-title-size\)/);
  assert.match(login, /\.auth-copy \{[^}]*font-size:var\(--sg-mobile-helper-size\)/);
  assert.match(login, /#returning-title \{ font-size:var\(--sg-mobile-section-title-size\) !important; \}/);

  assert.match(rsvp, /\.rsvp-manage-heading \{[^}]*font-size:var\(--sg-mobile-page-title-size\)/);
  assert.match(rsvp, /\.rsvp-manage-card h2 \{[^}]*font-size:var\(--sg-mobile-section-title-size\)/);
  assert.match(rsvp, /\.rsvp-cancelled h1 \{ font-size:var\(--sg-mobile-page-title-size\); \}/);

  assert.match(addPhoto, /\.add-photo-card h1 \{ font-size:var\(--sg-mobile-page-title-size\)/);
  assert.match(addPhoto, /\.add-photo-success h2 \{ font-size:var\(--sg-mobile-section-title-size\); \}/);
  assert.match(photoUpload, /@media\(max-width:560px\)[\s\S]*h1 \{ font-size:var\(--sg-mobile-page-title-size\)/);
});

test('mobile settings show one useful title for each level', () => {
  const view = read('src/views/settings-v2.html');
  const styles = read('public/css/settings.css');

  assert.doesNotMatch(view, /Choose a section/);
  assert.doesNotMatch(view, /Your account settings are grouped by what you want to manage/);
  assert.match(view, /<div class="settings-mobile-index">[\s\S]*<nav class="settings-index-list" aria-label="Settings sections">/);
  assert.match(styles, /body\[data-settings-route\]:not\(\[data-settings-route="index"\]\) \.settings-page-intro \{[\s\S]*position:absolute;[\s\S]*clip:rect\(0 0 0 0\);/);
  assert.match(styles, /\.settings-page-intro \.sg-page-title \{ font-size:var\(--sg-mobile-page-title-size\)/);
  assert.match(styles, /\.settings-section-head h2 \{ font-size:var\(--sg-mobile-page-title-size\)/);
  assert.match(styles, /\.settings-group-head h3,\.host-form-group-head h3,\.credits-activity h3 \{ font-size:var\(--sg-mobile-section-title-size\); \}/);
});

test('mobile utility dialogs use section-sized titles instead of page-sized headings', () => {
  const main = read('public/css/main.css');
  const sms = read('public/css/sms-notifications.css');
  const changeDialog = read('public/css/event-change-dialog.css');
  const familiar = read('public/css/familiar-faces.css');
  const confirmation = read('public/css/rsvp-confirmation.css');

  assert.match(main, /@media \(max-width: 879px\)[\s\S]*\.feedback-modal-head h2 \{\s*font-size: var\(--sg-mobile-section-title-size\);/);
  assert.match(sms, /@media \(max-width:879px\)[\s\S]*\.sms-dialog-head h2 \{ font-size:var\(--sg-mobile-section-title-size\)/);
  assert.match(changeDialog, /@media \(max-width:620px\)[\s\S]*\.event-change-card h2 \{ font-size:var\(--sg-mobile-section-title-size\); \}/);
  assert.match(familiar, /@media \(max-width:879px\)[\s\S]*\.familiar-invite-dialog h2 \{ font-size:var\(--sg-mobile-section-title-size\)/);
  assert.match(confirmation, /@media \(max-width:640px\)[\s\S]*\.rsvp-confirmation-status h2 \{ font-size:var\(--sg-mobile-page-title-size\); \}/);
});
