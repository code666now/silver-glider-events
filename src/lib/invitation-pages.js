const fs = require('fs');
const path = require('path');

const unavailableTemplate = fs.readFileSync(
  path.join(__dirname, '..', 'views', 'invitation-unavailable.html'),
  'utf8'
);

function sendInvitationUnavailable(res, status = 404) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return res.status(status).type('html').send(unavailableTemplate);
}

module.exports = { sendInvitationUnavailable };
