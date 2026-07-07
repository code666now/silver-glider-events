const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM = process.env.RESEND_FROM || 'events@silverglidertickets.com';

// Shared dark layout. Emails use a system font stack — webfonts are unreliable in clients.
function layout({ kicker, headline, sub, bodyHtml, cta, ctaUrl, footerHtml }) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="background:#0E0E0E;color:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:0">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;padding:40px 20px">
    <tr><td>
      <p style="font-size:11px;letter-spacing:.25em;color:#555;margin:0 0 32px;text-transform:uppercase;font-weight:700">Silver Glider Events</p>
      ${kicker ? `<p style="font-size:13px;font-weight:600;color:#1CC5BE;letter-spacing:.06em;text-transform:uppercase;margin:0 0 14px">${kicker}</p>` : ''}
      <h1 style="font-size:30px;font-weight:800;margin:0 0 8px;color:#f0f0f0;letter-spacing:-.02em;line-height:1.15">${headline}</h1>
      ${sub ? `<p style="color:#999;font-size:15px;margin:0 0 28px">${sub}</p>` : '<div style="height:20px"></div>'}
      ${bodyHtml || ''}
      ${cta ? `<a href="${ctaUrl}" style="display:block;background:#1CC5BE;color:#0a0a0a;text-align:center;padding:16px;border-radius:999px;text-decoration:none;font-weight:700;font-size:16px;margin:28px 0 24px">${cta}</a>` : ''}
      ${footerHtml || ''}
      <p style="color:#444;font-size:12px;text-align:center;margin-top:36px">Silver Glider Events</p>
    </td></tr>
  </table>
</body>
</html>`;
}

function eventCard(event) {
  const dateStr = new Date(event.event_date).toLocaleDateString('en-US',
    { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const timeStr = formatTime(event.start_time);
  const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent([event.venue_name, event.venue_address].filter(Boolean).join(', '))}`;
  return `
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #222;border-radius:16px;padding:22px;margin-bottom:8px">
        <tr><td style="padding:8px 0;border-bottom:1px solid #1a1a1a">
          <span style="color:#555;font-size:13px">Date</span>
          <span style="float:right;font-size:13px;color:#f0f0f0;font-weight:600">${dateStr}</span>
        </td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #1a1a1a">
          <span style="color:#555;font-size:13px">Time</span>
          <span style="float:right;font-size:13px;color:#f0f0f0;font-weight:600">${timeStr}</span>
        </td></tr>
        <tr><td style="padding:8px 0">
          <span style="color:#555;font-size:13px">Venue</span>
          <span style="float:right;font-size:13px;color:#f0f0f0;font-weight:600">${event.venue_name}</span>
        </td></tr>
      </table>
      <p style="margin:0 0 4px;text-align:right"><a href="${mapsUrl}" style="color:#1CC5BE;font-size:13px;text-decoration:none;font-weight:600">Open in Maps →</a></p>`;
}

function formatTime(t) {
  const [h, m] = String(t).split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hr = h % 12 || 12;
  return `${hr}:${String(m).padStart(2, '0')} ${ampm}`;
}

async function send({ to, subject, html, attachments, replyTo }) {
  if (!resend) {
    console.log(`[mailer:dev] to=${to} subject="${subject}" (RESEND_API_KEY not set — email not sent)`);
    return { dev: true };
  }
  const payload = { from: FROM, to, subject, html, attachments };
  if (replyTo) payload.replyTo = replyTo;
  const result = await resend.emails.send(payload);
  if (result.error) throw new Error(result.error.message || 'Resend send failed');
  return result.data;
}

async function sendMagicLink({ to, link }) {
  if (!resend) {
    console.log(`[mailer:dev] MAGIC LINK for ${to}: ${link}`);
    return { dev: true };
  }
  return send({
    to,
    subject: 'Your sign-in link — Silver Glider Events',
    html: layout({
      headline: 'Sign in',
      sub: 'Tap the button below to sign in to Silver Glider Events. The link expires in 15 minutes.',
      cta: 'Sign in',
      ctaUrl: link,
      footerHtml: `<p style="color:#555;font-size:12px;line-height:1.7;margin:0">If the button doesn't work, paste this link into your browser:<br><a href="${link}" style="color:#1CC5BE;word-break:break-all">${link}</a></p>
      <p style="color:#555;font-size:12px;margin-top:14px">Didn't request this? You can safely ignore this email.</p>`
    })
  });
}

async function sendRsvpConfirmation({ to, event, rsvp, icsContent }) {
  const manageUrl = `${process.env.APP_URL}/r/${rsvp.manage_token}`;
  return send({
    to,
    subject: `You're on the list — ${event.title}`,
    html: layout({
      kicker: 'RSVP confirmed',
      headline: "You're on the list.",
      sub: event.title,
      bodyHtml: eventCard(event),
      cta: 'View event',
      ctaUrl: `${process.env.APP_URL}/e/${event.slug}`,
      footerHtml: `<p style="color:#555;font-size:12px;text-align:center;margin:0">A calendar invite is attached. Can't make it? <a href="${manageUrl}" style="color:#1CC5BE">Manage your RSVP</a>.</p>`
    }),
    attachments: icsContent
      ? [{ filename: 'event.ics', content: Buffer.from(icsContent).toString('base64') }]
      : undefined
  });
}

async function sendDayBeforeReminder({ to, event, rsvp }) {
  const manageUrl = `${process.env.APP_URL}/r/${rsvp.manage_token}`;
  return send({
    to,
    subject: `Tomorrow: ${event.title}`,
    html: layout({
      kicker: 'Reminder',
      headline: 'Tomorrow.',
      sub: event.title,
      bodyHtml: eventCard(event),
      cta: 'View event',
      ctaUrl: `${process.env.APP_URL}/e/${event.slug}`,
      footerHtml: `<p style="color:#555;font-size:12px;text-align:center;margin:0">Can't make it? <a href="${manageUrl}" style="color:#1CC5BE">Cancel your RSVP</a> so someone else can go.</p>`
    })
  });
}

async function sendDayOfReminder({ to, event, rsvp }) {
  return send({
    to,
    subject: `Today: ${event.title} at ${formatTime(event.start_time)}`,
    html: layout({
      kicker: 'Today',
      headline: 'See you tonight.',
      sub: event.title,
      bodyHtml: eventCard(event),
      cta: 'View event',
      ctaUrl: `${process.env.APP_URL}/e/${event.slug}`
    })
  });
}

// Organizer-triggered announcement to opted-in followers.
async function sendEventAnnouncement({ to, event, organizerLabel, replyTo, unsubscribeUrl }) {
  return send({
    to,
    replyTo,
    subject: `${organizerLabel} just announced: ${event.title}`,
    html: layout({
      kicker: 'New event',
      headline: event.title,
      sub: `${organizerLabel} has a new event coming up.`,
      bodyHtml: eventCard(event),
      cta: 'View & RSVP',
      ctaUrl: `${process.env.APP_URL}/e/${event.slug}`,
      footerHtml: `<p style="color:#555;font-size:12px;text-align:center;margin:0;line-height:1.7">You're receiving this because you asked ${organizerLabel} to keep you posted about future events.<br><a href="${unsubscribeUrl}" style="color:#777;text-decoration:underline">Unsubscribe from this organizer</a></p>`
    })
  });
}

module.exports = {
  sendMagicLink, sendRsvpConfirmation, sendDayBeforeReminder, sendDayOfReminder,
  sendEventAnnouncement, formatTime
};
