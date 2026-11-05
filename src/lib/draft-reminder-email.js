const { esc } = require('./public-html');
const { renderSharedEmailLayout } = require('./mailer');

function httpUrl(value, label) {
  let url;
  try { url = new URL(String(value || '')); } catch (_) {}
  if (!url || !['http:', 'https:'].includes(url.protocol)) {
    throw new TypeError(`A valid ${label} URL is required`);
  }
  return url.toString();
}

// Pure renderer: no account lookup, draft mutation, or delivery side effect.
function buildDraftReminderEmail({ event = {}, unsubscribeUrl, manageUrl } = {}) {
  const eventId = Number(event.id);
  if (!Number.isSafeInteger(eventId) || eventId <= 0) throw new TypeError('A valid draft event ID is required');
  const baseUrl = new URL(httpUrl(process.env.APP_URL || 'https://silvergliderevents.com', 'application')).origin;
  const unsubscribe = httpUrl(unsubscribeUrl, 'unsubscribe');
  const manage = httpUrl(manageUrl, 'email settings');
  const title = String(event.title || '').replace(/\s+/g, ' ').trim().slice(0, 300) || 'Your event';
  const subject = 'Your event draft is saved';
  const headline = 'Pick up where you left off.';
  const sub = 'The details you added are saved. Continue whenever you’re ready.';
  const privacy = 'Your event stays private until you publish. Nothing has been shared with guests.';
  const reason = 'You’re receiving this optional reminder because you saved an event draft. We send one reminder per draft, at most once every seven days.';
  const cta = 'Continue my event';
  const ctaUrl = `${baseUrl}/login?next=${encodeURIComponent(`/events/${eventId}/edit`)}`;
  const footerHtml = `<div style="color:#999;font-size:12px;text-align:center;line-height:1.65">
    <p style="margin:0">${esc(reason)}</p>
    <p style="margin:12px 0 0">Sent by Silver Glider Entertainment Inc.</p>
    <p style="margin:12px 0 0">490 Post Street, Suite 500<br>San Francisco, CA 94102<br>United States</p>
    <p style="margin:12px 0 0"><a href="${esc(unsubscribe)}" style="color:#aaa;text-decoration:underline">Turn off draft reminders</a> · <a href="${esc(manage)}" style="color:#aaa;text-decoration:underline">Manage host emails</a> · <a href="${esc(baseUrl)}/privacy" style="color:#aaa;text-decoration:underline">Privacy Policy</a></p>
  </div>`;
  return {
    subject,
    html: renderSharedEmailLayout({
      kicker: 'Your private draft', headline, sub, cta, ctaUrl, footerHtml, compact: true,
      bodyHtml: `<div style="padding:20px;border:1px solid #292929;border-radius:12px;background:#111">
        <p style="color:#f4f4f4;font-size:18px;font-weight:700;line-height:1.45;overflow-wrap:anywhere;word-break:break-word;margin:0 0 12px">${esc(title)}</p>
        <p style="color:#aaa;font-size:15px;line-height:1.65;margin:0">${esc(privacy)}</p>
      </div>`
    }),
    text: `${subject}\n\n${headline}\n${sub}\n\n${title}\n${privacy}\n\n${cta}: ${ctaUrl}\n\n${reason}\nTurn off draft reminders: ${unsubscribe}\nManage host emails: ${manage}\nPrivacy Policy: ${baseUrl}/privacy\nSilver Glider Entertainment Inc., 490 Post Street, Suite 500, San Francisco, CA 94102, United States.`
  };
}

module.exports = { buildDraftReminderEmail };
