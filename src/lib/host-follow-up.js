const { esc } = require('./public-html');
const { renderSharedEmailLayout } = require('./mailer');

const FOLLOW_UP_SCOPE = 'host_followups';
const FOLLOW_UP_MAX_ATTEMPTS = 3;

function followUpSnapshot(row = {}) {
  const draftId = Number(row.draft_event_id);
  return {
    version: 1,
    draftId: Number.isSafeInteger(draftId) && draftId > 0 ? draftId : null,
    draftTitle: String(row.draft_event_title || '').trim().slice(0, 300),
    sourceTitle: String(row.title || '').trim().slice(0, 300)
  };
}

function buildHostFollowUpEmail({ snapshot = {}, unsubscribeUrl, manageUrl } = {}) {
  const baseUrl = String(process.env.APP_URL || 'https://silvergliderevents.com').replace(/\/$/, '');
  const draftId = Number(snapshot.draftId);
  const hasDraft = Number.isSafeInteger(draftId) && draftId > 0;
  const subject = hasDraft ? 'Your next event is taking shape' : 'Got another one in mind?';
  const cta = hasDraft ? 'Continue your event' : 'Create your next event';
  const destination = hasDraft ? `/events/${draftId}/edit` : '/events/new';
  const ctaUrl = `${baseUrl}/login?next=${encodeURIComponent(destination)}`;
  const sub = hasDraft
    ? `${String(snapshot.draftTitle || 'Your draft').trim()} is saved. Pick up where you left off, whenever you’re ready.`
    : 'Bring your people together again. Your next event can start with a title, a date, and a place.';
  const body = 'After you publish, Familiar Faces can help you choose whom to invite. You review the people and the message before anything is sent.';
  const reason = 'You turned on optional nudges toward your next event. We send at most one every 30 days, only when you have no upcoming event.';
  const footerHtml = `<div style="color:#777;font-size:12px;text-align:center;line-height:1.65">
    <p style="margin:0">${esc(reason)}</p>
    <p style="margin:12px 0 0">Sent by Silver Glider Entertainment Inc.</p>
    <p style="margin:12px 0 0">490 Post Street, Suite 500<br>San Francisco, CA 94102<br>United States</p>
    <p style="margin:12px 0 0"><a href="${esc(unsubscribeUrl)}" style="color:#aaa;text-decoration:underline">Turn off next-event nudges</a> · <a href="${esc(manageUrl)}" style="color:#aaa;text-decoration:underline">Manage host emails</a> · <a href="${esc(baseUrl)}/privacy" style="color:#aaa;text-decoration:underline">Privacy Policy</a></p>
  </div>`;
  return {
    subject,
    html: renderSharedEmailLayout({
      kicker: 'Your next gathering',
      headline: subject,
      sub,
      bodyHtml: `<p style="color:#9a9a9a;font-size:16px;line-height:1.65;margin:0">${esc(body)}</p>`,
      cta,
      ctaUrl,
      footerHtml
    }),
    text: `${subject}\n\n${sub}\n\n${body}\n\n${cta}: ${ctaUrl}\n\n${reason}\nTurn off next-event nudges: ${unsubscribeUrl}\nManage host emails: ${manageUrl}\nSilver Glider Entertainment Inc., 490 Post Street, Suite 500, San Francisco, CA 94102, United States.`
  };
}

module.exports = { FOLLOW_UP_SCOPE, FOLLOW_UP_MAX_ATTEMPTS, followUpSnapshot, buildHostFollowUpEmail };
