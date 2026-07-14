const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const pool = require('../config/db');
const { buildIcs } = require('../lib/calendar');
const { sendRsvpConfirmation } = require('../lib/mailer');
const { formatTime } = require('../lib/mailer');
const { verifyOptout } = require('../lib/followers');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const publicTemplate = fs.readFileSync(path.join(__dirname, '..', 'views', 'event-public.html'), 'utf8');
const hostTemplate = fs.readFileSync(path.join(__dirname, '..', 'views', 'host-public.html'), 'utf8');
const rsvpManageTemplate = fs.readFileSync(path.join(__dirname, '..', 'views', 'rsvp-manage.html'), 'utf8');

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function fmtTicketPrice(price) {
  if (price == null) return 'Paid admission';
  const n = Number(price);
  if (!Number.isFinite(n)) return 'Paid admission';
  return n === 0 ? 'Paid admission' : `$${n.toFixed(2).replace(/\.00$/, '')}`;
}

function youtubeId(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || '';
  const isHost = domain => host === domain || host.endsWith(`.${domain}`);
  if (isHost('youtube.com') || isHost('youtube-nocookie.com')) {
    if (url.pathname === '/watch') return url.searchParams.get('v') || '';
    const parts = url.pathname.split('/').filter(Boolean);
    if (['embed', 'shorts', 'live'].includes(parts[0])) return parts[1] || '';
  }
  return '';
}

function youtubePlaylistId(url) {
  const list = url.searchParams.get('list') || '';
  return /^[\w-]{6,}$/.test(list) ? list : '';
}

function vibeEmbed(urlString) {
  if (!urlString) return '';
  let url;
  try { url = new URL(urlString); } catch (_) { return ''; }
  if (!['http:', 'https:'].includes(url.protocol)) return '';
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const isHost = domain => host === domain || host.endsWith(`.${domain}`);

  if (isHost('youtube.com') || isHost('youtube-nocookie.com') || host === 'youtu.be') {
    const id = youtubeId(url);
    if (id && /^[\w-]{6,}$/.test(id)) {
      return `<iframe class="vibe-embed vibe-embed-video" src="https://www.youtube-nocookie.com/embed/${esc(id)}" title="YouTube music preview" loading="lazy" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
    }
    const list = youtubePlaylistId(url);
    if (list) {
      return `<iframe class="vibe-embed vibe-embed-video" src="https://www.youtube-nocookie.com/embed/videoseries?list=${esc(list)}" title="YouTube music preview" loading="lazy" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
    }
  }

  if (isHost('soundcloud.com')) {
    const src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(url.toString())}&color=%231cc5be&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=true`;
    return `<iframe class="vibe-embed vibe-embed-audio" src="${esc(src)}" title="SoundCloud music preview" loading="lazy" allow="autoplay"></iframe>`;
  }

  if (isHost('spotify.com')) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] && parts[0].startsWith('intl-')) parts.shift();
    const type = parts[0];
    const id = parts[1];
    if (['track', 'album', 'artist', 'playlist'].includes(type) && id && /^[A-Za-z0-9]+$/.test(id)) {
      const src = `https://open.spotify.com/embed/${type}/${id}`;
      return `<iframe class="vibe-embed vibe-embed-spotify" src="${esc(src)}" title="Spotify music preview" loading="lazy" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"></iframe>`;
    }
  }

  if (isHost('bandcamp.com') && url.pathname.startsWith('/EmbeddedPlayer/')) {
    return `<iframe class="vibe-embed vibe-embed-bandcamp" src="${esc(url.toString())}" title="Bandcamp music preview" loading="lazy"></iframe>`;
  }

  if (isHost('bandcamp.com') || isHost('soundcloud.com') || isHost('spotify.com')) {
    return `<a class="sg-btn sg-btn-ghost vibe-listen" href="${esc(url.toString())}" target="_blank" rel="noopener">Listen</a>`;
  }
  return '';
}

function renderVibe(url) {
  const embed = vibeEmbed(url);
  if (!embed) return '';
  return `<section class="vibe-section"><h2>Event Vibe</h2>${embed}</section>`;
}

async function loadEventBySlug(slug) {
  const { rows } = await pool.query(
    `SELECT e.*,
            COALESCE((SELECT COUNT(*) FROM rsvps WHERE event_id=e.id AND status='confirmed'), 0)::int AS rsvp_count,
            o.org_name, o.name AS organizer_name, o.public_slug AS organizer_public_slug, o.logo_url AS organizer_logo_url
       FROM events e JOIN organizers o ON o.id = e.organizer_id
      WHERE e.slug=$1 AND e.status <> 'draft'`,
    [slug]
  );
  return rows[0] || null;
}

function eventCardVisual(event) {
  if (event.cover_image_url) {
    return `<img src="${esc(event.cover_image_url)}" alt="" loading="lazy">`;
  }
  const posters = {
    paper: 'https://res.cloudinary.com/dhvavjgnw/image/upload/f_auto,q_auto,w_900/sg-events/textures/kraft-paper.jpg',
    disco: 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_900/sg-events/effects/disco.jpg',
    fog: 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_900/sg-events/effects/fog.jpg'
  };
  if (posters[event.background_theme]) {
    return `<img src="${posters[event.background_theme]}" alt="" loading="lazy">`;
  }
  const themes = ['midnight', 'aurora', 'sunset', 'ocean', 'violet', 'ember'];
  const theme = themes.includes(event.background_theme) ? event.background_theme : 'midnight';
  return `<div class="host-event-placeholder bg-${theme}" aria-hidden="true"></div>`;
}

function renderHostEventCard(event) {
  const time = formatTime(event.start_time);
  return `<a class="host-event-card" href="/e/${encodeURIComponent(event.slug)}">
    <div class="host-event-art">${eventCardVisual(event)}</div>
    <div class="host-event-copy">
      <p>${esc(fmtDate(event.event_date))} · ${esc(time)}</p>
      <h2>${esc(event.title)}</h2>
      <span>${esc(event.venue_name)}${event.venue_city ? ` · ${esc(event.venue_city)}` : ''}</span>
    </div>
  </a>`;
}

// GET /h/:slug — one public home for an organizer's upcoming events
router.get('/h/:slug', async (req, res, next) => {
  try {
    const { rows: hosts } = await pool.query(
      `SELECT id, org_name, public_slug, logo_url
         FROM organizers
        WHERE LOWER(public_slug)=LOWER($1) AND org_name IS NOT NULL`,
      [req.params.slug]
    );
    const host = hosts[0];
    if (!host) return res.status(404).send(render404());

    const { rows: events } = await pool.query(
      `SELECT slug, title, cover_image_url, event_date, start_time, venue_name, venue_city, background_theme
         FROM events
        WHERE organizer_id=$1
          AND status='published'
          AND visibility='public'
          AND event_date >= CURRENT_DATE
        ORDER BY event_date ASC, start_time ASC, id ASC`,
      [host.id]
    );
    const cardsHtml = events.length
      ? events.map(renderHostEventCard).join('')
      : '<div class="host-empty"><h2>No upcoming events yet.</h2><p>Check back soon for the next one.</p></div>';
    const logoHtml = host.logo_url
      ? `<img class="host-logo" src="${esc(host.logo_url)}" alt="${esc(host.org_name)} logo">`
      : '';

    res.send(hostTemplate
      .replace(/{{HOST_NAME}}/g, esc(host.org_name))
      .replace(/{{HOST_LOGO}}/g, logoHtml)
      .replace(/{{EVENT_CARDS}}/g, cardsHtml)
      .replace(/{{OG_URL}}/g, esc(`${process.env.APP_URL}/h/${host.public_slug}`))
      .replace(/{{OG_IMAGE}}/g, esc(host.logo_url || `${process.env.APP_URL}/logo.png`)));
  } catch (err) { next(err); }
});

// GET /e/:slug — server-rendered so OG tags work for link previews
router.get('/e/:slug', async (req, res, next) => {
  try {
    const event = await loadEventBySlug(req.params.slug);
    if (!event) return res.status(404).send(render404());

    const isFull = event.capacity != null && event.rsvp_count >= event.capacity;
    const organizerLabel = event.org_name || event.organizer_name || 'Silver Glider Events';
    const presenterHtml = event.org_name
      ? `<div class="host-attribution">
          ${event.organizer_logo_url ? `<img src="${esc(event.organizer_logo_url)}" alt="">` : ''}
          <p><span>Presented by</span>${event.organizer_public_slug
            ? `<a href="/h/${encodeURIComponent(event.organizer_public_slug)}">${esc(event.org_name)} <b aria-hidden="true">→</b></a>`
            : `<strong>${esc(event.org_name)}</strong>`}</p>
        </div>`
      : '';
    const isPaid = event.admission_type === 'paid';
    const ticketHtml = isPaid
      ? `<div class="ticket-note"><span>${esc(fmtTicketPrice(event.ticket_price))}</span>${event.ticket_url ? `<a href="${esc(event.ticket_url)}" target="_blank" rel="noopener">Ticket link →</a>` : '<em>At the door</em>'}</div>`
      : '<div class="ticket-note"><span>Free</span><em>RSVP required</em></div>';
    const vibeHtml = renderVibe(event.event_vibe_url);

    // Violet and ember are legacy-only: hidden from the MVP picker, but still
    // rendered for already-published events that selected them.
    const THEMES = ['midnight', 'aurora', 'sunset', 'ocean', 'violet', 'ember'];
    const EFFECTS = ['static', 'paper', 'disco', 'fog'];
    const VIDEO_EFFECTS = {
      disco: 'sg-events/effects/disco',
      fog: 'sg-events/effects/fog'
    };
    const chosen = event.background_theme;
    const isEffect = EFFECTS.includes(chosen);
    const theme = (THEMES.includes(chosen) || isEffect) ? chosen : 'midnight';
    const bgClass = isEffect ? `fx-${theme}` : `bg-${theme}`;
    const videoPublicId = VIDEO_EFFECTS[theme];
    const fxMedia = videoPublicId
      ? `<video class="fx-video-media" autoplay muted loop playsinline webkit-playsinline preload="auto" poster="https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_1600/${videoPublicId}.jpg" aria-hidden="true" tabindex="-1"><source src="https://res.cloudinary.com/dhvavjgnw/video/upload/f_mp4,vc_h264,q_auto:eco,w_1280,c_limit,fl_progressive/${videoPublicId}.mp4" type="video/mp4"></video>`
      : '';
    // Effects sit behind everything and need a darkening veil for legibility
    const fxVeil = isEffect
      ? `<div class="fx-veil${theme === 'paper' ? ' fx-veil-soft' : ''}" aria-hidden="true"></div>`
      : '';
    const heroHtml = event.cover_image_url
      ? `<div class="hero" id="hero"><img src="${esc(event.cover_image_url)}" alt="" onerror="this.parentElement.classList.add('no-image'${isEffect ? '' : `,'bg-theme','bg-${theme}'`});this.remove()"></div>`
      : (isEffect
          ? `<div class="hero no-image" id="hero"></div>`
          : `<div class="hero no-image bg-theme bg-${theme}" id="hero"></div>`);

    // Unsplash attribution (only when a credited photo is the cover)
    const creditHtml = (event.cover_image_url && event.cover_credit_name)
      ? `<p class="photo-credit">Photo by <a href="${esc(event.cover_credit_link || '#')}" target="_blank" rel="noopener">${esc(event.cover_credit_name)}</a> on <a href="https://unsplash.com/?utm_source=silver_glider_events&utm_medium=referral" target="_blank" rel="noopener">Unsplash</a></p>`
      : '';

    const eventJson = {
      slug: event.slug,
      title: event.title,
      status: event.status,
      isFull,
      capacity: event.capacity,
      organizerLabel,
      coverImageUrl: event.cover_image_url || null,
      bgEffect: isEffect ? theme : null
    };

    const html = publicTemplate
      .replace(/{{TITLE}}/g, esc(event.title))
      .replace(/{{OG_DESCRIPTION}}/g, esc(`${fmtDate(event.event_date)} · ${event.venue_name}`))
      .replace(/{{OG_IMAGE}}/g, esc(event.cover_image_url || `${process.env.APP_URL}/logo.png`))
      .replace(/{{OG_URL}}/g, esc(`${process.env.APP_URL}/e/${event.slug}`))
      .replace(/{{BODY_CLASS}}/g, bgClass)
      .replace(/{{FX_MEDIA}}/g, fxMedia)
      .replace(/{{FX_VEIL}}/g, fxVeil)
      .replace(/{{HERO}}/g, heroHtml)
      .replace(/{{PHOTO_CREDIT}}/g, creditHtml)
      .replace(/{{DATE_STR}}/g, esc(fmtDate(event.event_date)))
      .replace(/{{TIME_STR}}/g, esc(formatTime(event.start_time) + (event.end_time ? ` – ${formatTime(event.end_time)}` : '')))
      .replace(/{{VENUE_NAME}}/g, esc(event.venue_name))
      .replace(/{{VENUE_ADDRESS}}/g, esc(event.venue_address || ''))
      .replace(/{{MAPS_URL}}/g, esc(`https://maps.google.com/?q=${encodeURIComponent([event.venue_name, event.venue_address].filter(Boolean).join(', '))}`))
      .replace(/{{TICKET_HTML}}/g, ticketHtml)
      .replace(/{{DESCRIPTION_HTML}}/g, esc(event.description || '').replace(/\n/g, '<br>'))
      .replace(/{{VIBE_HTML}}/g, vibeHtml)
      .replace(/{{PRESENTER_HTML}}/g, presenterHtml)
      .replace(/{{CATEGORY}}/g, esc(event.category || ''))
      .replace(/{{RSVP_CTA}}/g, isPaid ? 'RSVP' : "RSVP — it's free")
      .replace(/{{EVENT_JSON}}/g, JSON.stringify(eventJson).replace(/</g, '\\u003c'));

    res.send(html);
  } catch (err) { next(err); }
});

function render404() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Event not found</title><link rel="stylesheet" href="/css/brand.css"></head>
<body><main style="max-width:400px;margin:0 auto;padding:20vh 24px;text-align:center">
<p class="sg-label" style="margin-bottom:20px">Silver Glider Events</p>
<h1 style="font-size:30px;margin-bottom:10px">Event not found</h1>
<p style="color:var(--sg-text-dim);font-size:15px">This event may have been removed, or the link is wrong.</p>
</main></body></html>`;
}

// POST /api/public/events/:slug/rsvp — capacity-safe
router.post('/api/public/events/:slug/rsvp', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const fullName = String(req.body.full_name || '').trim().replace(/\s+/g, ' ').slice(0, 160);
    const legacyFirstName = String(req.body.first_name || '').trim().slice(0, 80);
    const legacyLastName = String(req.body.last_name || '').trim().slice(0, 80);
    const nameParts = fullName.split(' ').filter(Boolean);
    const firstName = (fullName ? nameParts.shift() : legacyFirstName).slice(0, 80);
    const lastName = (fullName ? nameParts.join(' ') : legacyLastName).slice(0, 80);
    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = String(req.body.phone || '').trim().slice(0, 30) || null;
    const wantsReminders = req.body.wants_reminders !== false;
    const organizerOptin = req.body.organizer_optin === true;

    if (!firstName) return res.status(400).json({ error: 'Enter your name' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email' });

    await client.query('BEGIN');
    const { rows: evRows } = await client.query(
      `SELECT * FROM events WHERE slug=$1 AND status='published' FOR UPDATE`, [req.params.slug]
    );
    if (!evRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found' });
    }
    const event = evRows[0];

    const { rows: existing } = await client.query(
      `SELECT * FROM rsvps WHERE event_id=$1 AND LOWER(email)=LOWER($2)`, [event.id, email]
    );
    if (existing.length && existing[0].status === 'confirmed') {
      await client.query('COMMIT');
      resendConfirmation(event, existing[0]);
      return res.json({ ok: true, alreadyRsvpd: true });
    }

    const { rows: cnt } = await client.query(
      `SELECT COUNT(*)::int AS n FROM rsvps WHERE event_id=$1 AND status='confirmed'`, [event.id]
    );
    if (event.capacity != null && cnt[0].n >= event.capacity) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'full' });
    }

    let rsvp;
    if (existing.length) {
      // previously cancelled — re-confirm
      rsvp = (await client.query(
        `UPDATE rsvps SET status='confirmed', first_name=$2, last_name=$3, phone=$4,
                wants_reminders=$5, organizer_optin=$6
          WHERE id=$1 RETURNING *`,
        [existing[0].id, firstName, lastName, phone, wantsReminders, organizerOptin]
      )).rows[0];
    } else {
      rsvp = (await client.query(
        `INSERT INTO rsvps (event_id, first_name, last_name, email, phone, wants_reminders, organizer_optin, manage_token)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [event.id, firstName, lastName, email, phone, wantsReminders, organizerOptin,
         crypto.randomBytes(16).toString('hex')]
      )).rows[0];
    }
    await client.query('COMMIT');

    resendConfirmation(event, rsvp);
    res.status(201).json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// Confirmation email — fire-and-forget after commit, logged to message_log
function resendConfirmation(event, rsvp) {
  (async () => {
    try {
      const ics = buildIcs(event);
      const result = await sendRsvpConfirmation({ to: rsvp.email, event, rsvp, icsContent: ics });
      await pool.query(
        `INSERT INTO message_log (rsvp_id, event_id, recipient, message_type, channel, status, provider_id, sent_at)
         VALUES ($1,$2,$3,'rsvp_confirmation','email','sent',$4,NOW())
         ON CONFLICT (rsvp_id, message_type, channel) WHERE rsvp_id IS NOT NULL
         DO UPDATE SET status='sent', sent_at=NOW()`,
        [rsvp.id, event.id, rsvp.email, result?.id || null]
      );
    } catch (err) {
      console.error('[rsvp-confirmation]', err.message);
      pool.query(
        `INSERT INTO message_log (rsvp_id, event_id, recipient, message_type, channel, status, error)
         VALUES ($1,$2,$3,'rsvp_confirmation','email','failed',$4)
         ON CONFLICT (rsvp_id, message_type, channel) WHERE rsvp_id IS NOT NULL DO NOTHING`,
        [rsvp.id, event.id, rsvp.email, err.message]
      ).catch(() => {});
    }
  })();
}

// GET /e/:slug/calendar.ics
router.get('/e/:slug/calendar.ics', async (req, res, next) => {
  try {
    const event = await loadEventBySlug(req.params.slug);
    if (!event) return res.status(404).send('Not found');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${event.slug}.ics"`);
    res.send(buildIcs(event));
  } catch (err) { next(err); }
});

// GET /e/:slug/qr.png
router.get('/e/:slug/qr.png', async (req, res, next) => {
  try {
    const event = await loadEventBySlug(req.params.slug);
    if (!event) return res.status(404).send('Not found');
    const png = await QRCode.toBuffer(`${process.env.APP_URL}/e/${event.slug}`, {
      width: 600, margin: 2,
      // Brand teal modules on near-black — high contrast so it still scans reliably
      color: { dark: '#1CC5BE', light: '#0E0E0E' }
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(png);
  } catch (err) { next(err); }
});

// GET /r/:manageToken — attendee RSVP management
router.get('/r/:token', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.first_name, r.status AS rsvp_status, e.*
         FROM rsvps r JOIN events e ON e.id = r.event_id
        WHERE r.manage_token=$1`,
      [req.params.token]
    );
    if (!rows.length) return res.status(404).send(render404());
    const row = rows[0];

    const html = rsvpManageTemplate
      .replace(/{{TITLE}}/g, esc(row.title))
      .replace(/{{FIRST_NAME}}/g, esc(row.first_name))
      .replace(/{{DATE_STR}}/g, esc(fmtDate(row.event_date)))
      .replace(/{{TIME_STR}}/g, esc(formatTime(row.start_time)))
      .replace(/{{VENUE_NAME}}/g, esc(row.venue_name))
      .replace(/{{EVENT_URL}}/g, esc(`/e/${row.slug}`))
      .replace(/{{ICS_URL}}/g, esc(`/e/${row.slug}/calendar.ics`))
      .replace(/{{TOKEN}}/g, esc(req.params.token))
      .replace(/{{RSVP_STATUS}}/g, esc(row.rsvp_status))
      .replace(/{{EVENT_STATUS}}/g, esc(row.status));
    res.send(html);
  } catch (err) { next(err); }
});

// GET /unsubscribe?token= — remove an email from an organizer's follower list
router.get('/unsubscribe', async (req, res, next) => {
  try {
    const data = verifyOptout(req.query.token);
    if (!data) {
      return res.status(400).send(unsubscribePage('That unsubscribe link is invalid or expired.', false));
    }
    await pool.query(
      `INSERT INTO follower_optouts (organizer_id, email)
       SELECT $1, $2
       WHERE NOT EXISTS (SELECT 1 FROM follower_optouts WHERE organizer_id=$1 AND LOWER(email)=LOWER($2))`,
      [data.organizerId, data.email]
    );
    res.send(unsubscribePage("You're unsubscribed. You won't get future-event emails from this organizer.", true));
  } catch (err) { next(err); }
});

function unsubscribePage(message, ok) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribe — Silver Glider Events</title><link rel="stylesheet" href="/css/brand.css"></head>
<body><main style="max-width:420px;margin:0 auto;padding:18vh 24px;text-align:center">
<p class="sg-label" style="margin-bottom:20px">Silver Glider Events</p>
<h1 style="font-size:28px;margin-bottom:12px">${ok ? 'Unsubscribed' : 'Link problem'}</h1>
<p style="color:var(--sg-text-dim);font-size:15px;line-height:1.7">${message}</p>
</main></body></html>`;
}

// POST /api/public/rsvps/:token/cancel
router.post('/api/public/rsvps/:token/cancel', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE rsvps SET status='cancelled' WHERE manage_token=$1 RETURNING id`,
      [req.params.token]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
