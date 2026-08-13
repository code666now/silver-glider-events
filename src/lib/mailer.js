const { Resend } = require('resend');
const { DEFAULT_ACCENT, createEmailTheme } = require('../../public/js/artwork-color');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM = process.env.RESEND_FROM || 'events@silverglidertickets.com';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch (_) {
    return '';
  }
}

const EMAIL_EFFECT_POSTERS = Object.freeze({
  paper: 'https://res.cloudinary.com/dhvavjgnw/image/upload/sg-events/textures/kraft-paper.jpg',
  disco: 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_1240,c_limit/sg-events/effects/disco.jpg',
  fog: 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_1240,c_limit/sg-events/effects/fog.jpg',
  saloon: 'https://res.cloudinary.com/dhvavjgnw/image/upload/sg-events/backgrounds/after-hours-saloon.png'
});

function emailSafeImageUrl(value, { adaptiveCanvas = false } = {}) {
  const safeUrl = safeHttpUrl(value);
  if (!safeUrl) return '';
  const url = new URL(safeUrl);
  if (url.protocol === 'https:' && url.hostname === 'res.cloudinary.com' && url.pathname.includes('/image/upload/')) {
    const transformation = adaptiveCanvas
      ? 'if_ar_gt_1.15/b_auto,c_pad,h_560,w_620/if_else/c_limit,w_620/if_end/f_jpg,q_auto'
      : 'f_jpg,q_auto,w_1240,c_limit';
    url.pathname = url.pathname.replace('/image/upload/', `/image/upload/${transformation}/`);
  }
  return url.toString();
}

// Shared premium dark layout. Emails use a system font stack — webfonts are unreliable in clients.
function layout({ kicker, headline, sub, bodyHtml, cta, ctaUrl, footerHtml, footerBrand = 'Silver Glider Events' }) {
  const baseUrl = String(process.env.APP_URL || 'https://silvergliderevents.com').replace(/\/$/, '');
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <style>
    @media only screen and (max-width:620px) {
      .sg-email-shell { padding:36px 20px 28px !important; }
      .sg-email-brand { padding-bottom:42px !important; }
      .sg-email-headline { font-size:39px !important; }
      .sg-email-sub { font-size:17px !important; }
    }
  </style>
</head>
<body style="background:#080808;color:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#080808" style="width:100%;background:#080808">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="sg-email-shell" style="width:100%;max-width:640px;margin:0 auto;padding:56px 28px 36px">
        <tr><td align="center" class="sg-email-brand" style="padding:0 0 54px">
          <img src="${esc(baseUrl)}/logo.png" width="88" height="88" alt="Silver Glider Events" style="display:block;width:88px;height:88px;border:0;outline:none;text-decoration:none;margin:0 auto">
          <p style="color:#6f6f6f;font-size:10px;font-weight:800;letter-spacing:.24em;text-transform:uppercase;margin:12px 0 0">Silver Glider Events</p>
        </td></tr>
        <tr><td>
          ${kicker ? `<p style="font-size:13px;font-weight:800;color:#1CC5BE;letter-spacing:.14em;text-transform:uppercase;margin:0 0 18px">${esc(kicker)}</p>` : ''}
          <h1 class="sg-email-headline" style="font-size:48px;font-weight:800;margin:0 0 20px;color:#f4f4f4;letter-spacing:-.035em;line-height:1.04">${esc(headline)}</h1>
          ${sub ? `<p class="sg-email-sub" style="color:#9a9a9a;font-size:19px;line-height:1.58;margin:0 0 38px">${esc(sub)}</p>` : '<div style="height:18px"></div>'}
          ${bodyHtml || ''}
          ${cta ? `<a href="${esc(ctaUrl)}" style="display:block;background:#1CC5BE;color:#080808;text-align:center;padding:18px 20px;border-radius:999px;text-decoration:none;font-weight:800;font-size:17px;margin:34px 0 28px">${esc(cta)}</a>` : ''}
          ${footerHtml ? `<div style="margin:0 0 34px">${footerHtml}</div>` : '<div style="height:6px"></div>'}
        </td></tr>
        <tr><td style="border-top:1px solid #202020;padding:34px 0 8px;text-align:center">
          <p style="color:#585858;font-size:12px;font-weight:700;letter-spacing:.04em;margin:0">${esc(footerBrand)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// RSVP confirmations use the same dark, spacious visual language as Silver
// Glider's activation emails without changing the shared transactional layout.
function rsvpConfirmationLayout({ event, theme = createEmailTheme(event.artwork_accent_color), sub, bodyHtml, cta, ctaUrl, secondaryHtml, footerBrand = 'Powered by Silver Glider' }) {
  const baseUrl = String(process.env.APP_URL || 'https://silvergliderevents.com').replace(/\/$/, '');
  const outerBackground = '#080808';
  const artworkRow = confirmationArtworkRow(event);
  const hasArtwork = Boolean(artworkRow);
  const hostHtml = confirmationHostHtml(event, baseUrl, theme);
  const listeningHtml = confirmationListeningHtml(event, baseUrl, theme);
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <style>
    @media only screen and (max-width:620px) {
      .sg-email-pad { padding-left:20px !important;padding-right:20px !important; }
      .sg-email-brand { padding-left:20px !important;padding-right:20px !important;padding-top:28px !important; }
      .sg-email-headline { font-size:38px !important; }
      .sg-event-title { font-size:30px !important;line-height:1.12 !important; }
      .sg-email-sub,.sg-email-secondary,.sg-detail-label,.sg-detail-value,.sg-map-link,.sg-email-action-label { font-size:16px !important; }
      .sg-event-artwork { width:100% !important;max-width:560px !important;height:auto !important; }
      .sg-email-cta { width:100% !important; }
    }
  </style>
</head>
<body style="background:${outerBackground};color:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;margin:0;padding:0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${outerBackground}" style="width:100%;background:${outerBackground}">
    <tr><td align="center">
      <!--[if mso]><table role="presentation" width="620" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="sg-email-container" bgcolor="#080808" style="width:100%;max-width:620px;margin:0 auto;background:#080808">
        <tr><td align="center" class="sg-email-brand" style="padding:34px 30px ${hasArtwork ? '18px' : '44px'}">
          <img src="${esc(baseUrl)}/logo.png" width="34" height="34" alt="Silver Glider Events" style="display:block;width:34px;height:34px;border:0;outline:none;text-decoration:none;margin:0 auto">
          <p style="color:#777777;font-size:9px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;margin:9px 0 0">Silver Glider Events</p>
        </td></tr>
        ${artworkRow}
        <tr><td class="sg-email-pad" style="padding:${hasArtwork ? '32px' : '0'} 30px 0">
          <p style="font-size:13px;font-weight:800;color:${theme.secondaryAccentColor};letter-spacing:.14em;text-transform:uppercase;margin:0 0 18px">RSVP Confirmed</p>
          <h1 class="sg-event-title" style="font-size:36px;font-weight:800;margin:0 0 ${hostHtml || listeningHtml ? '10px' : '16px'};color:#f4f4f4;letter-spacing:-.025em;line-height:1.12;overflow-wrap:anywhere;word-break:break-word">${esc(event.title)}</h1>
          ${hostHtml}
          ${listeningHtml}
          <p class="sg-email-sub" style="color:#a7a7a7;font-size:17px;line-height:1.55;margin:18px 0 30px">${esc(sub)}</p>
          ${bodyHtml || ''}
          <div style="height:32px;line-height:32px">&nbsp;</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="sg-email-cta" style="width:100%">
            <tr><td align="center" height="52" bgcolor="${theme.accentColor}" style="height:52px;background:${theme.accentColor};border-radius:12px">
              <a href="${esc(ctaUrl)}" style="display:block;color:${theme.accentTextColor};text-align:center;line-height:52px;text-decoration:none;font-weight:800;font-size:17px">${esc(cta)}</a>
            </td></tr>
          </table>
          <div style="height:26px;line-height:26px">&nbsp;</div>
          ${secondaryHtml || ''}
        </td></tr>
        <tr><td class="sg-email-pad" style="padding:0 30px 36px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-top:1px solid #242424">
            <tr><td align="center" style="padding:30px 0 0"><p style="color:#686868;font-size:12px;font-weight:700;letter-spacing:.04em;margin:0">${esc(footerBrand)}</p></td></tr>
          </table>
        </td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body>
</html>`;
}

function confirmationArtworkRow(event) {
  const eventArtwork = isFlyerEvent(event) ? event.flyer_image_url : event.cover_image_url;
  const effectPoster = eventArtwork ? '' : EMAIL_EFFECT_POSTERS[event.background_theme];
  const source = eventArtwork || effectPoster;
  const imageUrl = emailSafeImageUrl(source, { adaptiveCanvas: Boolean(eventArtwork) });
  if (!imageUrl) return '';
  const alt = eventArtwork ? `${event.title} artwork` : '';
  return `<tr><td align="center" style="padding:0">
    <img class="sg-event-artwork" src="${esc(imageUrl)}" width="620" alt="${esc(alt)}" style="width:100%;max-width:620px;height:auto;display:block;margin:0 auto;border:0;border-radius:12px;outline:none;text-decoration:none">
  </td></tr>`;
}

function confirmationHostHtml(event, baseUrl, theme) {
  const hostName = String(event.org_name || event.presenter_name || '').trim();
  if (!hostName) return '';
  const hostUrl = event.organizer_public_slug
    ? `${baseUrl}/h/${encodeURIComponent(event.organizer_public_slug)}`
    : '';
  const identity = hostUrl
    ? `<a href="${esc(hostUrl)}" style="color:${theme.secondaryAccentColor};text-decoration:none;font-weight:700">${esc(hostName)}</a>`
    : `<strong style="color:#d7d7d7;font-weight:700">${esc(hostName)}</strong>`;
  return `<p style="color:#8e8e8e;font-size:16px;line-height:1.5;margin:0">Presented by ${identity}</p>`;
}

function confirmationIconUrl(baseUrl, icon, theme) {
  if (theme.secondaryAccentColor === DEFAULT_ACCENT) return `${baseUrl}/images/email/${icon}.png`;
  return `${baseUrl}/images/email/${icon}/${theme.secondaryAccentColor.slice(1)}.png`;
}

function confirmationListeningHtml(event, baseUrl, theme) {
  const listeningUrl = safeHttpUrl(event.event_vibe_url);
  if (!listeningUrl) return '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:20px 0 0;border-top:1px solid #242424;border-bottom:1px solid #242424">
    <tr>
      <td width="68" valign="middle" style="width:68px;padding:16px 12px 16px 0">
        <a href="${esc(listeningUrl)}" style="display:block;text-decoration:none"><img src="${esc(confirmationIconUrl(baseUrl, 'music', theme))}" width="52" height="52" alt="" style="display:block;width:52px;height:52px;border:0;outline:none;text-decoration:none"></a>
      </td>
      <td valign="middle" style="padding:16px 8px">
        <a href="${esc(listeningUrl)}" style="display:block;color:${theme.secondaryAccentColor};font-size:17px;line-height:1.35;text-decoration:none;font-weight:800">Music vibe</a>
        <p style="color:#969696;font-size:15px;line-height:1.45;margin:3px 0 0">Check out the music vibe for this event.</p>
      </td>
      <td width="38" valign="middle" align="right" style="width:38px;padding:16px 0 16px 8px">
        <a href="${esc(listeningUrl)}" aria-label="Open music vibe" style="display:block;color:${theme.secondaryAccentColor};font-size:34px;line-height:1;text-decoration:none;font-weight:400">→</a>
      </td>
    </tr>
  </table>`;
}

function confirmationDetailsCard(event) {
  const rows = [];
  if (event.event_date) {
    const date = new Date(event.event_date);
    if (!Number.isNaN(date.getTime())) {
      rows.push(['Date', date.toLocaleDateString('en-US',
        { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })]);
    }
  }
  if (event.start_time && /^\d{1,2}:\d{2}/.test(String(event.start_time))) rows.push(['Time', formatTime(event.start_time)]);
  const venue = String(event.venue_name || event.venue_address || '').trim();
  if (venue) rows.push(['Venue', venue]);
  if (!rows.length) return '';

  const rowHtml = rows.map(([label, value], index) => `${index ? '<tr><td colspan="2" height="1" bgcolor="#242424" style="height:1px;line-height:1px;font-size:1px">&nbsp;</td></tr>' : ''}
    <tr>
      <td class="sg-detail-label" width="32%" valign="top" style="width:32%;padding:14px 16px;color:#8c8c8c;font-size:15px;line-height:1.45">${esc(label)}</td>
      <td class="sg-detail-value" width="68%" valign="top" align="right" style="width:68%;padding:14px 16px;color:#f0f0f0;font-size:15px;font-weight:700;line-height:1.45;overflow-wrap:anywhere;word-break:break-word">${esc(value)}</td>
    </tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#111111" style="width:100%;background:#111111;border:1px solid #292929;border-collapse:separate;border-radius:12px">
    ${rowHtml}
  </table>`;
}

function confirmationActionLinks(event, rsvp, theme) {
  const baseUrl = String(process.env.APP_URL || 'https://silvergliderevents.com').replace(/\/$/, '');
  const location = [event.venue_name, event.venue_address].filter(Boolean).join(', ');
  const actions = [
    {
      label: 'Add to Calendar',
      url: `${baseUrl}/r/${rsvp.manage_token}/calendar.ics`,
      icon: 'calendar.png'
    }
  ];
  if (location) {
    actions.push({
      label: 'Open in Maps',
      url: `https://maps.google.com/?q=${encodeURIComponent(location)}`,
      icon: 'map.png'
    });
  }
  actions.push({
    label: 'Manage RSVP',
    url: `${baseUrl}/r/${rsvp.manage_token}`,
    icon: 'manage.png'
  });
  const width = Math.floor(100 / actions.length);
  const cells = actions.map((action, index) => `<td width="${width}%" valign="top" align="center" style="width:${width}%;padding:12px 6px 4px;${index ? 'border-left:1px solid #242424;' : ''}">
    <a href="${esc(action.url)}" style="display:block;text-decoration:none">
      <img src="${esc(confirmationIconUrl(baseUrl, action.icon.replace(/\.png$/, ''), theme))}" width="36" height="36" alt="" style="display:block;width:36px;height:36px;margin:0 auto 9px;border:0;outline:none;text-decoration:none">
      <span class="sg-email-action-label" style="display:block;color:${theme.secondaryAccentColor};font-size:14px;line-height:1.35;font-weight:500">${esc(action.label)}</span>
    </a>
  </td>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="sg-email-actions" style="width:100%;margin:0 0 24px"><tr>${cells}</tr></table>`;
}

function confirmationFooterNote(rsvp) {
  const reminder = rsvp.wants_reminders ? '<br>We’ll send one reminder the day before.' : '';
  return `<p class="sg-email-secondary" style="color:#858585;font-size:13px;text-align:center;margin:0 0 34px;line-height:1.65">A calendar invite is attached.${reminder}</p>`;
}

function eventCard(event) {
  const dateStr = new Date(event.event_date).toLocaleDateString('en-US',
    { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const timeStr = formatTime(event.start_time);
  const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent([event.venue_name, event.venue_address].filter(Boolean).join(', '))}`;
  return `
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #222;border-radius:18px;padding:22px;margin:0 0 10px">
        <tr><td style="padding:0 0 14px">
          <p style="color:#f0f0f0;font-size:18px;font-weight:800;line-height:1.25;margin:0">${esc(event.title)}</p>
        </td></tr>
        <tr><td style="padding:10px 0;border-top:1px solid #1a1a1a">
          <span style="color:#777;font-size:13px">Date</span>
          <span style="float:right;font-size:13px;color:#f0f0f0;font-weight:700">${esc(dateStr)}</span>
        </td></tr>
        <tr><td style="padding:10px 0;border-top:1px solid #1a1a1a">
          <span style="color:#777;font-size:13px">Time</span>
          <span style="float:right;font-size:13px;color:#f0f0f0;font-weight:700">${esc(timeStr)}</span>
        </td></tr>
        <tr><td style="padding:10px 0 0;border-top:1px solid #1a1a1a">
          <span style="color:#777;font-size:13px">Venue</span>
          <span style="float:right;font-size:13px;color:#f0f0f0;font-weight:700">${esc(event.venue_name)}</span>
        </td></tr>
      </table>
      <p style="margin:0 0 4px;text-align:right"><a href="${esc(mapsUrl)}" style="color:#1CC5BE;font-size:13px;text-decoration:none;font-weight:700">Open in Maps →</a></p>`;
}

function formatTime(t) {
  const [h, m] = String(t).split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hr = h % 12 || 12;
  return `${hr}:${String(m).padStart(2, '0')} ${ampm}`;
}

function attendeeEventUrl(event, rsvp) {
  return event.comments_enabled
    ? `${process.env.APP_URL}/r/${rsvp.manage_token}/event`
    : `${process.env.APP_URL}/e/${event.slug}`;
}

function isFlyerEvent(event) {
  return event?.presentation_mode === 'flyer' && Boolean(event.flyer_image_url);
}

function flyerArtwork(event) {
  if (!isFlyerEvent(event)) return '';
  return `<div style="background:#111;border:1px solid #222;border-radius:18px;overflow:hidden;margin:0 0 22px;text-align:center">
    <img src="${esc(event.flyer_image_url)}" width="584" alt="${esc(event.title)} flyer" style="display:block;width:100%;max-width:584px;height:auto;margin:0 auto;border:0;outline:none;text-decoration:none">
  </div>`;
}

function flyerSecondaryLinks(event, rsvp, { includeManage = true, includeHost = true } = {}) {
  const baseUrl = String(process.env.APP_URL || 'https://silvergliderevents.com').replace(/\/$/, '');
  const calendarUrl = `${baseUrl}/r/${rsvp.manage_token}/calendar.ics`;
  const manageUrl = `${baseUrl}/r/${rsvp.manage_token}`;
  const hostUrl = event.organizer_public_slug ? `${baseUrl}/h/${encodeURIComponent(event.organizer_public_slug)}` : '';
  const links = [
    `<a href="${esc(calendarUrl)}" style="color:#1CC5BE;text-decoration:none;font-weight:700">Add to Calendar</a>`
  ];
  if (includeManage) links.push(`<a href="${esc(manageUrl)}" style="color:#1CC5BE;text-decoration:none;font-weight:700">Manage your RSVP</a>`);
  if (includeHost && hostUrl && event.org_name) links.push(`<a href="${esc(hostUrl)}" style="color:#1CC5BE;text-decoration:none;font-weight:700">${esc(event.org_name)}</a>`);
  return `<p class="sg-email-secondary" style="color:#858585;font-size:13px;text-align:center;margin:0 0 34px;line-height:1.9">${links.join('<span style="color:#444"> &nbsp;·&nbsp; </span>')}</p>`;
}

function renderFlyerRsvpConfirmationEmail({ event, rsvp }) {
  const theme = createEmailTheme(event.artwork_accent_color);
  const greeting = rsvp.first_name ? `${rsvp.first_name}, your spot` : 'Your spot';
  return rsvpConfirmationLayout({
    event,
    theme,
    sub: `${greeting} is confirmed.`,
    bodyHtml: confirmationDetailsCard(event),
    cta: event.comments_enabled ? 'View event & comments' : 'View event',
    ctaUrl: attendeeEventUrl(event, rsvp),
    secondaryHtml: `${confirmationActionLinks(event, rsvp, theme)}${confirmationFooterNote(rsvp)}`,
    footerBrand: 'Powered by Silver Glider'
  });
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

async function sendMagicLink({ to, link, followHostName }) {
  const hostName = String(followHostName || '').trim();
  const isFollow = Boolean(hostName);
  if (!resend) {
    console.log(`[mailer:dev] MAGIC LINK for ${to}: ${link}`);
    return { dev: true };
  }
  return send({
    to,
    subject: isFollow ? `Follow ${hostName} — Silver Glider Events` : 'Your sign-in link — Silver Glider Events',
    html: layout({
      kicker: 'Magic link',
      headline: isFollow ? `Follow ${hostName}` : 'Sign in',
      sub: isFollow
        ? `Tap the button below to verify your email and follow ${hostName}. The link expires in 15 minutes.`
        : 'Tap the button below to sign in to Silver Glider Events. The link expires in 15 minutes.',
      cta: isFollow ? `Follow ${hostName}` : 'Sign in',
      ctaUrl: link,
      footerHtml: `<p style="color:#555;font-size:12px;line-height:1.7;margin:0">If the button doesn't work, paste this link into your browser:<br><a href="${esc(link)}" style="color:#1CC5BE;word-break:break-all">${esc(link)}</a></p>
      <p style="color:#555;font-size:12px;margin-top:14px">Didn't request this? You can safely ignore this email.</p>`
    })
  });
}

function renderRsvpConfirmationEmail({ event, rsvp }) {
  if (isFlyerEvent(event)) return renderFlyerRsvpConfirmationEmail({ event, rsvp });
  const theme = createEmailTheme(event.artwork_accent_color);
  const greeting = rsvp.first_name ? `${rsvp.first_name}, your spot` : 'Your spot';
  return rsvpConfirmationLayout({
    event,
    theme,
    sub: `${greeting} is confirmed.`,
    bodyHtml: confirmationDetailsCard(event),
    cta: event.comments_enabled ? 'View event & comments' : 'View event',
    ctaUrl: attendeeEventUrl(event, rsvp),
    secondaryHtml: `${confirmationActionLinks(event, rsvp, theme)}${confirmationFooterNote(rsvp)}`
  });
}

function renderFlyerReminderEmail({ event, rsvp, kicker, headline }) {
  return layout({
    kicker,
    headline,
    sub: event.title,
    bodyHtml: `${flyerArtwork(event)}${eventCard(event)}`,
    cta: event.comments_enabled ? 'View event & comments' : 'View event',
    ctaUrl: attendeeEventUrl(event, rsvp),
    footerHtml: flyerSecondaryLinks(event, rsvp),
    footerBrand: 'Powered by Silver Glider'
  });
}

async function sendRsvpConfirmation({ to, event, rsvp, icsContent }) {
  return send({
    to,
    subject: rsvpConfirmationSubject(event),
    html: renderRsvpConfirmationEmail({ event, rsvp }),
    attachments: icsContent
      ? [{ filename: 'event.ics', content: Buffer.from(icsContent).toString('base64') }]
      : undefined
  });
}

function rsvpConfirmationSubject(event) {
  return `RSVP confirmed for ${event.title}`;
}

async function sendDayBeforeReminder({ to, event, rsvp }) {
  const manageUrl = `${process.env.APP_URL}/r/${rsvp.manage_token}`;
  return send({
    to,
    subject: `Tomorrow: ${event.title}`,
    html: isFlyerEvent(event) ? renderFlyerReminderEmail({ event, rsvp, kicker: 'Reminder', headline: 'Tomorrow.' }) : layout({
      kicker: 'Reminder',
      headline: 'Tomorrow.',
      sub: event.title,
      bodyHtml: eventCard(event),
      cta: event.comments_enabled ? 'View event & comments' : 'View event',
      ctaUrl: attendeeEventUrl(event, rsvp),
      footerHtml: `<p style="color:#555;font-size:12px;text-align:center;margin:0">Can't make it? <a href="${esc(manageUrl)}" style="color:#1CC5BE">Cancel your RSVP</a> so someone else can go.</p>`
    })
  });
}

async function sendDayOfReminder({ to, event, rsvp }) {
  return send({
    to,
    subject: `Today: ${event.title} at ${formatTime(event.start_time)}`,
    html: isFlyerEvent(event) ? renderFlyerReminderEmail({ event, rsvp, kicker: 'Today', headline: 'See you tonight.' }) : layout({
      kicker: 'Today',
      headline: 'See you tonight.',
      sub: event.title,
      bodyHtml: eventCard(event),
      cta: event.comments_enabled ? 'View event & comments' : 'View event',
      ctaUrl: attendeeEventUrl(event, rsvp)
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
      footerHtml: `<p style="color:#555;font-size:12px;text-align:center;margin:0;line-height:1.7">You're receiving this because you asked ${esc(organizerLabel)} to keep you posted about future events.<br><a href="${esc(unsubscribeUrl)}" style="color:#777;text-decoration:underline">Unsubscribe from this host</a></p>`
    })
  });
}

module.exports = {
  sendMagicLink, sendRsvpConfirmation, sendDayBeforeReminder, sendDayOfReminder,
  sendEventAnnouncement, formatTime, renderRsvpConfirmationEmail,
  renderFlyerRsvpConfirmationEmail, renderFlyerReminderEmail,
  renderSharedEmailLayout: layout, rsvpConfirmationSubject
};
