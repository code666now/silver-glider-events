const crypto = require('crypto');

// Notification destinations only: this configuration never grants admin access.
const EMAIL_RE = /^[^\s@<>\u0000-\u001f\u007f]+@[^\s@<>\u0000-\u001f\u007f]+\.[^\s@<>\u0000-\u001f\u007f]+$/;
const MAX_EXTRA_RECIPIENTS = 20;

function extraEventAlertEmails(env = process.env) {
  const emails = [...new Set(String(env.EVENT_ADMIN_ALERT_EXTRA_EMAILS || '')
    .split(/[,\r\n]+/).map(value => value.trim().toLowerCase()).filter(Boolean))];
  if (emails.length > MAX_EXTRA_RECIPIENTS || emails.some(email => email.length > 320 || !EMAIL_RE.test(email))) {
    throw new Error('EVENT_ADMIN_ALERT_EXTRA_EMAILS configuration is invalid.');
  }
  return emails;
}

function extraEventAlertIdempotencyKey(alertId, email) {
  const digest = crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
  return `event-admin-alert-${alertId}-extra-${digest}-v1`;
}

module.exports = { extraEventAlertEmails, extraEventAlertIdempotencyKey };
