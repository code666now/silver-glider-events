const test = require('node:test');
const assert = require('node:assert/strict');

const { renderRsvpConfirmationEmail } = require('../src/lib/mailer');
const { createEmailTheme } = require('../public/js/artwork-color');

const event = {
  title: 'Midnight Listening Party',
  cover_image_url: 'https://res.cloudinary.com/demo/image/upload/sg-events/covers/midnight-listening-party.webp',
  event_date: '2026-08-22',
  start_time: '20:30',
  venue_name: 'The Silver Room',
  venue_address: '1420 Valencia St, San Francisco, CA',
  slug: 'midnight-listening-party',
  comments_enabled: true,
  org_name: 'The Night Archive',
  organizer_public_slug: 'the-night-archive',
  event_vibe_url: 'https://bandcamp.com/album/midnight-listening-party',
  artwork_accent_color: '#E72D88',
  background_theme: 'ocean'
};

const rsvp = {
  first_name: 'Avery',
  manage_token: 'private-manage-token',
  wants_reminders: true
};

test('RSVP confirmation follows the premium Silver Glider hierarchy', () => {
  const html = renderRsvpConfirmationEmail({ event, rsvp });
  const theme = createEmailTheme(event.artwork_accent_color);
  const markers = [
    'logo.png',
    'class="sg-event-artwork"',
    'RSVP Confirmed',
    "You're on the list.",
    'class="sg-event-title"',
    'Presented by',
    '/h/the-night-archive',
    'Listen here →',
    'Avery, your spot is confirmed.',
    'class="sg-detail-label"',
    'View event &amp; comments',
    'A calendar invite is attached.',
    'Manage your RSVP',
    'Powered by Silver Glider'
  ];

  for (let index = 1; index < markers.length; index += 1) {
    assert.ok(html.indexOf(markers[index - 1]) < html.indexOf(markers[index]), `${markers[index - 1]} should precede ${markers[index]}`);
  }
  assert.match(html, new RegExp(`height="52" bgcolor="${theme.accentColor}"`));
  assert.match(html, new RegExp(`background:${theme.accentColor};border-radius:12px`));
  assert.match(html, new RegExp(`color:${theme.accentTextColor};text-align:center`));
  assert.equal((html.match(new RegExp(theme.accentColor, 'g')) || []).length, 2);
  assert.ok((html.match(/color:#1CC5BE/g) || []).length >= 5);
  assert.equal((html.match(/bgcolor="#080808"/g) || []).length, 2);
  assert.match(html, /<body style="background:#080808/);
  assert.match(html, /width:100%;background:#080808/);
  assert.match(html, /background:#111111;border:1px solid #292929/);
  assert.doesNotMatch(html, /var\(--|gradient\(/);
  assert.equal((html.match(/Midnight Listening Party<\/h2>/g) || []).length, 1);
});

test('RSVP email preserves event information, management, and calendar messaging', () => {
  const html = renderRsvpConfirmationEmail({ event, rsvp });
  for (const value of ['Midnight Listening Party', 'Saturday, August 22, 2026', '8:30 PM', 'The Silver Room', 'Open in Maps →']) {
    assert.match(html, new RegExp(value));
  }
  assert.match(html, /\/r\/private-manage-token\/event/);
  assert.match(html, /\/r\/private-manage-token/);
  assert.match(html, /We’ll send one reminder the day before\./);

  const fallbackHtml = renderRsvpConfirmationEmail({
    event: {
      ...event,
      cover_image_url: null,
      event_date: null,
      start_time: null,
      venue_name: null,
      venue_address: null,
      org_name: null,
      organizer_public_slug: null,
      event_vibe_url: null,
      artwork_accent_color: null
    },
    rsvp
  });
  assert.doesNotMatch(fallbackHtml, /<img class="sg-event-artwork"/);
  assert.doesNotMatch(fallbackHtml, />Presented by |Listen here →|<td class="sg-detail-label"|>Open in Maps →/);
  assert.match(fallbackHtml, /class="sg-event-title"/);
  assert.match(fallbackHtml, /height="52" bgcolor="#1CC5BE"/);
});

test('RSVP confirmation remains responsive and dark', () => {
  const html = renderRsvpConfirmationEmail({ event, rsvp });
  assert.match(html, /@media only screen and \(max-width:620px\)/);
  assert.match(html, /bgcolor="#080808"/);
  assert.match(html, /max-width:620px/);
  assert.match(html, /\[if mso\][\s\S]*width="620"/);
  assert.match(html, /class="sg-email-headline"/);
  assert.match(html, /width="34" height="34" alt="Silver Glider Events"/);
  assert.doesNotMatch(html, /bgcolor="#071522"|background:#071522/);
  assert.match(html, /class="sg-event-artwork"[\s\S]*width="620"[\s\S]*width:100%;max-width:620px;height:auto;display:block/);
  assert.match(html, /if_ar_gt_1\.15[\s\S]*b_auto,c_pad,h_560,w_620[\s\S]*f_jpg,q_auto/);
  assert.match(html, /padding-left:20px !important;padding-right:20px !important/);
  assert.match(html, /height="52" bgcolor="#E72D88"/);
  assert.match(html, /overflow-wrap:anywhere;word-break:break-word/);
  assert.doesNotMatch(html, /float:right|display:grid|display:flex|position:absolute/);
  assert.doesNotMatch(html, /<video|\.mp4|\.gif/);

  const effectFallbackHtml = renderRsvpConfirmationEmail({
    event: { ...event, cover_image_url: null, background_theme: 'fog' },
    rsvp
  });
  assert.match(effectFallbackHtml, /video\/upload\/so_0,f_jpg,q_auto,w_1240,c_limit\/sg-events\/effects\/fog\.jpg/);
  assert.equal((effectFallbackHtml.match(/bgcolor="#080808"/g) || []).length, 2);
  assert.doesNotMatch(effectFallbackHtml, /bgcolor="#100B18"|background:#100B18/);
  assert.doesNotMatch(effectFallbackHtml, /<video|\.mp4|\.gif/);
});
