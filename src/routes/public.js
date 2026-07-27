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
const { parseSession, readSessionCookie } = require('../lib/session');
const { createRateLimiter, clientIp } = require('../lib/rate-limit');
const {
  ensureAttemptSession,
  hasUnlockCookie,
  setUnlockCookie,
  verifyCode
} = require('../lib/secret-show');
const {
  attendeeCookieName,
  cleanComment,
  parseNamedGuest,
  publicGuestNames,
  readCookie,
  robotsDirective
} = require('../lib/private-events');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RSVP_RATE_WINDOW_MS = 15 * 60 * 1000;
const rsvpRateLimiter = createRateLimiter({
  windowMs: RSVP_RATE_WINDOW_MS,
  rules: [
    { name: 'ip-event', max: 8, key: ({ ip, slug }) => `${ip}:${slug}` },
    { name: 'email-event', max: 4, key: ({ email, slug }) => email ? `${email}:${slug}` : '' },
    { name: 'ip-global', max: 30, key: ({ ip }) => ip }
  ]
});
setInterval(() => rsvpRateLimiter.prune(), RSVP_RATE_WINDOW_MS).unref();

const SECRET_UNLOCK_WINDOW_MS = 15 * 60 * 1000;
const secretUnlockLimiter = createRateLimiter({
  windowMs: SECRET_UNLOCK_WINDOW_MS,
  rules: [
    { name: 'secret-session-event', max: 6, key: ({ session, slug }) => `${session}:${slug}` },
    { name: 'secret-ip-event', max: 30, key: ({ ip, slug }) => `${ip}:${slug}` },
    { name: 'secret-ip-global', max: 100, key: ({ ip }) => ip }
  ]
});
setInterval(() => secretUnlockLimiter.prune(), SECRET_UNLOCK_WINDOW_MS).unref();

function protectRsvp(req, res, next) {
  const result = rsvpRateLimiter.consume({
    ip: clientIp(req),
    slug: String(req.params.slug || '').trim().toLowerCase().slice(0, 220),
    email: String(req.body?.email || '').trim().toLowerCase().slice(0, 320)
  });
  if (result.allowed) return next();
  res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
  return res.status(429).json({ error: 'Too many RSVP attempts. Please wait a few minutes and try again.' });
}

const publicTemplate = fs.readFileSync(path.join(__dirname, '..', 'views', 'event-public.html'), 'utf8');
const hostTemplate = fs.readFileSync(path.join(__dirname, '..', 'views', 'host-public.html'), 'utf8');
const rsvpManageTemplate = fs.readFileSync(path.join(__dirname, '..', 'views', 'rsvp-manage.html'), 'utf8');
const secretShowTemplate = fs.readFileSync(path.join(__dirname, '..', 'views', 'secret-show.html'), 'utf8');

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
            COALESCE((SELECT COUNT(guest_first_name) FROM rsvps WHERE event_id=e.id AND status='confirmed'), 0)::int AS guest_count,
            COALESCE((SELECT COUNT(*) + COUNT(guest_first_name) FROM rsvps WHERE event_id=e.id AND status='confirmed'), 0)::int AS total_attendance,
            COALESCE((SELECT COUNT(*) FROM event_comments WHERE event_id=e.id), 0)::int AS comment_count,
            o.org_name, o.name AS organizer_name, o.public_slug AS organizer_public_slug, o.logo_url AS organizer_logo_url
       FROM events e JOIN organizers o ON o.id = e.organizer_id
      WHERE e.slug=$1 AND e.status <> 'draft'`,
    [slug]
  );
  return rows[0] || null;
}

async function loadEventAccessEnvelope(slug) {
  const { rows } = await pool.query(
    `SELECT id, slug, organizer_id, visibility, status,
            secret_show_enabled, secret_show_version
       FROM events
      WHERE slug=$1 AND status <> 'draft'`,
    [slug]
  );
  return rows[0] || null;
}

function secretShowLocked(req, event) {
  return Boolean(event?.secret_show_enabled) &&
    !organizerViewer(req, event) &&
    !hasUnlockCookie(req, event);
}

function rejectLockedSecret(res) {
  return res.status(404).json({ error: 'Event not found' });
}

function renderGuestList(event, rows) {
  if (event.visibility !== 'private' || !event.show_guest_list) return '';
  const names = publicGuestNames(rows);
  const visibleLimit = 8;
  const items = names.map((entry, index) =>
    `<li${index >= visibleLimit ? ' class="guest-name-extra" hidden' : ''}>${esc(entry.firstName)}</li>`
  ).join('');
  const toggle = names.length > visibleLimit
    ? '<button class="guest-list-toggle" id="guest-list-toggle" type="button" aria-expanded="false">See everyone</button>'
    : '';
  const count = Number(event.total_attendance) || 0;
  return `<section class="public-guest-list" aria-labelledby="guest-list-title">
    <div class="section-heading">
      <h2 id="guest-list-title">${count} ${count === 1 ? 'person is' : 'people are'} going</h2>
    </div>
    ${items ? `<ul class="guest-name-list">${items}</ul>` : '<p class="section-empty">Be the first to RSVP.</p>'}
    ${toggle}
  </section>`;
}

function renderGuestFields(event) {
  if (event.visibility !== 'private' || !event.allow_guests) return '';
  return `<fieldset class="party-size-field">
    <legend>Who is attending?</legend>
    <label><input type="radio" name="party_size" value="solo" checked> Just me</label>
    <label><input type="radio" name="party_size" value="guest"> I’m bringing someone</label>
  </fieldset>
  <div id="guest-fields" hidden>
    <div class="sg-field"><label for="guest_name">Guest name</label><input class="sg-input" id="guest_name" maxlength="160" autocomplete="name"></div>
    <div class="sg-field"><label for="guest_email">Guest email <span style="opacity:.5;text-transform:none;letter-spacing:0">(optional)</span></label><input class="sg-input" type="email" id="guest_email" maxlength="254" autocomplete="email"></div>
  </div>`;
}

function renderComments(event) {
  if (event.visibility !== 'private' || !event.comments_enabled) return '';
  return `<section class="event-wall" id="event-wall" aria-labelledby="event-wall-title">
    <div class="section-heading">
      <h2 id="event-wall-title">Comments</h2>
      <span id="comment-count">${Number(event.comment_count) || 0}</span>
    </div>
    <div id="comment-list" class="comment-list"><p class="section-empty">Loading comments…</p></div>
    <form id="comment-form" hidden>
      <label for="comment-message">Add a comment</label>
      <textarea id="comment-message" class="sg-textarea" maxlength="300" placeholder="Say something to the group"></textarea>
      <div class="comment-compose-foot"><span id="comment-length">0/300</span><button class="sg-btn sg-btn-ghost" id="comment-submit" type="submit">Post</button></div>
      <p class="comment-error" id="comment-error"></p>
    </form>
    <p class="comment-locked" id="comment-locked">Confirmed attendees can comment. Open your RSVP confirmation link to join in.</p>
  </section>`;
}

function setAttendeeCookie(res, eventId, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${attendeeCookieName(eventId)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${180 * 24 * 3600}${secure}`);
}

async function confirmedAttendee(req, event) {
  const token = readCookie(req, attendeeCookieName(event.id));
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT id, first_name
       FROM rsvps
      WHERE event_id=$1 AND manage_token=$2 AND status='confirmed'`,
    [event.id, token]
  );
  return rows[0] || null;
}

function organizerViewer(req, event) {
  const session = parseSession(readSessionCookie(req));
  return session?.id === event.organizer_id;
}

function eventCardVisual(event) {
  if (event.cover_image_url) {
    return `<img src="${esc(event.cover_image_url)}" alt="" loading="lazy">`;
  }
  const posters = {
    paper: 'https://res.cloudinary.com/dhvavjgnw/image/upload/f_auto,q_auto,w_900/sg-events/textures/kraft-paper.jpg',
    disco: 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_900/sg-events/effects/disco.jpg',
    fog: 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_900/sg-events/effects/fog.jpg',
    saloon: 'https://res.cloudinary.com/dhvavjgnw/image/upload/f_auto,q_auto,w_900/sg-events/backgrounds/after-hours-saloon.png'
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

// POST /api/public/events/:slug/unlock — access-code gate only; no event data.
router.post('/api/public/events/:slug/unlock', async (req, res, next) => {
  try {
    const event = await loadEventAccessEnvelope(req.params.slug);
    if (!event || event.visibility !== 'private' || !event.secret_show_enabled) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const attemptSession = ensureAttemptSession(req, res);
    const rate = secretUnlockLimiter.consume({
      session: attemptSession,
      ip: clientIp(req),
      slug: event.slug
    });
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)));
      return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
    }

    const { rows } = await pool.query(
      'SELECT code_hash FROM event_secret_codes WHERE event_id=$1',
      [event.id]
    );
    const valid = rows.length && await verifyCode(req.body?.code, rows[0].code_hash);
    if (!valid) return res.status(401).json({ error: 'That code does not open this event.' });

    setUnlockCookie(res, event);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /e/:slug — server-rendered so OG tags work for link previews
router.get('/e/:slug', async (req, res, next) => {
  try {
    const accessEvent = await loadEventAccessEnvelope(req.params.slug);
    if (!accessEvent) return res.status(404).send(render404());

    if (accessEvent.secret_show_enabled) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      res.setHeader('Cache-Control', 'private, no-store');
      if (secretShowLocked(req, accessEvent)) {
        ensureAttemptSession(req, res);
        return res.type('html').send(secretShowTemplate);
      }
    }

    const event = await loadEventBySlug(req.params.slug);
    if (!event) return res.status(404).send(render404());

    if (event.visibility === 'private') {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    }

    let publicGuestRows = [];
    if (event.visibility === 'private' && event.show_guest_list) {
      publicGuestRows = (await pool.query(
        `SELECT first_name, guest_first_name
           FROM rsvps
          WHERE event_id=$1 AND status='confirmed'
          ORDER BY created_at ASC, id ASC`,
        [event.id]
      )).rows;
    }

    const isFull = event.capacity != null && event.total_attendance >= event.capacity;
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
      : '<div class="ticket-note"><span>Free</span><em>RSVP</em></div>';
    const vibeHtml = renderVibe(event.event_vibe_url);

    // Violet and ember are legacy-only: hidden from the MVP picker, but still
    // rendered for already-published events that selected them.
    const THEMES = ['midnight', 'aurora', 'sunset', 'ocean', 'violet', 'ember'];
    const EFFECTS = ['static', 'paper', 'disco', 'fog', 'saloon'];
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
      ? `<div class="fx-veil${theme === 'paper' ? ' fx-veil-soft' : ''}${theme === 'saloon' ? ' fx-veil-warm' : ''}" aria-hidden="true"></div>`
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
      totalAttendance: event.total_attendance,
      allowGuests: event.visibility === 'private' && event.allow_guests,
      commentsEnabled: event.visibility === 'private' && event.comments_enabled,
      organizerLabel,
      coverImageUrl: event.cover_image_url || null,
      bgEffect: isEffect ? theme : null
    };

    const html = publicTemplate
      .replace(/{{TITLE}}/g, esc(event.title))
      .replace(/{{ROBOTS_DIRECTIVE}}/g, esc(robotsDirective(event.visibility)))
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
      .replace(/{{GUEST_FIELDS_HTML}}/g, renderGuestFields(event))
      .replace(/{{GUEST_LIST_HTML}}/g, renderGuestList(event, publicGuestRows))
      .replace(/{{COMMENTS_HTML}}/g, renderComments(event))
      .replace(/{{CATEGORY}}/g, esc(event.category || ''))
      .replace(/{{RSVP_CTA}}/g, 'RSVP')
      .replace(/{{EVENT_JSON}}/g, JSON.stringify(eventJson).replace(/</g, '\\u003c'));

    res.send(html);
  } catch (err) { next(err); }
});

function render404() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Event not found</title><link rel="stylesheet" href="/css/brand.css"><script src="/js/legal-footer.js" defer></script></head>
<body><main style="max-width:400px;margin:0 auto;padding:20vh 24px;text-align:center">
<p class="sg-label" style="margin-bottom:20px">Silver Glider Events</p>
<h1 style="font-size:30px;margin-bottom:10px">Event not found</h1>
<p style="color:var(--sg-text-dim);font-size:15px">This event may have been removed, or the link is wrong.</p>
</main></body></html>`;
}

// GET /api/public/events/:slug/comments — safe public wall data only.
router.get('/api/public/events/:slug/comments', async (req, res, next) => {
  try {
    const event = await loadEventBySlug(req.params.slug);
    if (!event || event.visibility !== 'private' || !event.comments_enabled) {
      return res.status(404).json({ error: 'Event wall not found' });
    }
    if (secretShowLocked(req, event)) return rejectLockedSecret(res);
    const attendee = await confirmedAttendee(req, event);
    const canModerate = organizerViewer(req, event);
    const { rows } = await pool.query(
      `SELECT c.id, c.message, c.created_at, c.rsvp_id, r.first_name
         FROM event_comments c
         JOIN rsvps r ON r.id=c.rsvp_id
        WHERE c.event_id=$1
        ORDER BY c.created_at ASC, c.id ASC`,
      [event.id]
    );
    res.json({
      canComment: event.status === 'published' && Boolean(attendee),
      canModerate,
      comments: rows.map(row => ({
        id: row.id,
        first_name: row.first_name,
        message: row.message,
        created_at: row.created_at,
        can_delete: canModerate || attendee?.id === row.rsvp_id
      }))
    });
  } catch (err) { next(err); }
});

// POST /api/public/events/:slug/comments — confirmed attendee token required.
router.post('/api/public/events/:slug/comments', async (req, res, next) => {
  try {
    const event = await loadEventBySlug(req.params.slug);
    if (!event || event.visibility !== 'private' || !event.comments_enabled || event.status !== 'published') {
      return res.status(404).json({ error: 'Event wall not found' });
    }
    if (secretShowLocked(req, event)) return rejectLockedSecret(res);
    const attendee = await confirmedAttendee(req, event);
    if (!attendee) return res.status(403).json({ error: 'Open your RSVP confirmation link before commenting' });
    const cleaned = cleanComment(req.body.message);
    if (cleaned.error) return res.status(400).json({ error: cleaned.error });

    const { rows } = await pool.query(
      `INSERT INTO event_comments (event_id, rsvp_id, message)
       VALUES ($1,$2,$3)
       RETURNING id, message, created_at`,
      [event.id, attendee.id, cleaned.message]
    );
    res.status(201).json({
      comment: {
        id: rows[0].id,
        first_name: attendee.first_name,
        message: rows[0].message,
        created_at: rows[0].created_at,
        can_delete: true
      }
    });
  } catch (err) { next(err); }
});

// DELETE /api/public/events/:slug/comments/:id — comment owner or event organizer.
router.delete('/api/public/events/:slug/comments/:id', async (req, res, next) => {
  try {
    const commentId = Number(req.params.id);
    if (!Number.isInteger(commentId) || commentId < 1) return res.status(404).json({ error: 'Comment not found' });
    const event = await loadEventBySlug(req.params.slug);
    if (!event) return res.status(404).json({ error: 'Comment not found' });
    if (secretShowLocked(req, event)) return rejectLockedSecret(res);
    const { rows } = await pool.query(
      'SELECT id, rsvp_id FROM event_comments WHERE id=$1 AND event_id=$2',
      [commentId, event.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Comment not found' });

    const attendee = await confirmedAttendee(req, event);
    const allowed = organizerViewer(req, event) || attendee?.id === rows[0].rsvp_id;
    if (!allowed) return res.status(403).json({ error: 'You cannot delete this comment' });
    await pool.query('DELETE FROM event_comments WHERE id=$1 AND event_id=$2', [commentId, event.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/public/events/:slug/rsvp — rate-limited and capacity-safe
router.post('/api/public/events/:slug/rsvp', protectRsvp, async (req, res, next) => {
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
    if (secretShowLocked(req, event)) {
      await client.query('ROLLBACK');
      return rejectLockedSecret(res);
    }

    const { rows: existing } = await client.query(
      `SELECT * FROM rsvps WHERE event_id=$1 AND LOWER(email)=LOWER($2)`, [event.id, email]
    );
    if (existing.length && existing[0].status === 'confirmed') {
      await client.query('COMMIT');
      void resendConfirmation(event, existing[0]);
      return res.json({ ok: true, alreadyRsvpd: true });
    }

    const guest = parseNamedGuest({
      allow_guests: event.visibility === 'private' && event.allow_guests
    }, req.body);
    if (guest.error) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: guest.error });
    }

    const { rows: cnt } = await client.query(
      `SELECT (COUNT(*) + COUNT(guest_first_name))::int AS n
         FROM rsvps WHERE event_id=$1 AND status='confirmed'`,
      [event.id]
    );
    if (event.capacity != null && cnt[0].n + guest.partySize > event.capacity) {
      await client.query('ROLLBACK');
      return guest.partySize > 1
        ? res.status(409).json({ error: 'party_full', message: 'There is only room for one more person.' })
        : res.status(409).json({ error: 'full' });
    }

    let rsvp;
    const isNewRsvp = existing.length === 0;
    if (existing.length) {
      // previously cancelled — re-confirm
      rsvp = (await client.query(
        `UPDATE rsvps SET status='confirmed', first_name=$2, last_name=$3, phone=$4,
                wants_reminders=$5, organizer_optin=$6,
                guest_first_name=$7, guest_last_name=$8, guest_email=$9
          WHERE id=$1 RETURNING *`,
        [existing[0].id, firstName, lastName, phone, wantsReminders, organizerOptin,
         guest.guestFirstName, guest.guestLastName, guest.guestEmail]
      )).rows[0];
    } else {
      rsvp = (await client.query(
        `INSERT INTO rsvps (event_id, first_name, last_name, email, phone, wants_reminders, organizer_optin,
                            guest_first_name, guest_last_name, guest_email, manage_token)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [event.id, firstName, lastName, email, phone, wantsReminders, organizerOptin,
         guest.guestFirstName, guest.guestLastName, guest.guestEmail,
         crypto.randomBytes(16).toString('hex')]
      )).rows[0];
    }
    await client.query('COMMIT');

    // A fresh RSVP establishes attendee access on this browser immediately.
    // Existing-email attempts still require the confirmation link so knowing
    // another attendee's email can never grant comment or deletion access.
    if (isNewRsvp && event.visibility === 'private' && event.comments_enabled) {
      setAttendeeCookie(res, event.id, rsvp.manage_token);
    }
    void resendConfirmation(event, rsvp);
    res.status(201).json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// Confirmation email — an atomic database claim prevents duplicate sends across
// rapid retries, app restarts, or multiple app instances. One resend is allowed
// after 15 minutes so an attendee can recover a lost confirmation safely.
async function resendConfirmation(event, rsvp) {
  let logId = null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO message_log (rsvp_id, event_id, recipient, message_type, channel, status)
       VALUES ($1,$2,$3,'rsvp_confirmation','email','pending')
       ON CONFLICT (rsvp_id, message_type, channel) WHERE rsvp_id IS NOT NULL
       DO UPDATE SET event_id=EXCLUDED.event_id, recipient=EXCLUDED.recipient,
                     status='pending', provider_id=NULL, error=NULL,
                     created_at=NOW(), sent_at=NULL
       WHERE COALESCE(message_log.sent_at, message_log.created_at) < NOW() - INTERVAL '15 minutes'
       RETURNING id`,
      [rsvp.id, event.id, rsvp.email]
    );
    if (!rows.length) return false;
    logId = rows[0].id;

    const ics = buildIcs(event);
    const result = await sendRsvpConfirmation({ to: rsvp.email, event, rsvp, icsContent: ics });
    await pool.query(
      `UPDATE message_log
          SET status='sent', provider_id=$2, error=NULL, sent_at=NOW()
        WHERE id=$1`,
      [logId, result?.id || null]
    );
    return true;
  } catch (err) {
    console.error('[rsvp-confirmation]', err.message);
    if (logId) {
      await pool.query(
        `UPDATE message_log SET status='failed', error=$2 WHERE id=$1`,
        [logId, String(err.message || 'Email delivery failed').slice(0, 2000)]
      ).catch(() => {});
    }
    return false;
  }
}

// GET /e/:slug/calendar.ics
router.get('/e/:slug/calendar.ics', async (req, res, next) => {
  try {
    const event = await loadEventBySlug(req.params.slug);
    if (!event) return res.status(404).send('Not found');
    if (secretShowLocked(req, event)) return res.status(404).send('Not found');
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
    if (secretShowLocked(req, event)) return res.status(404).send('Not found');
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
router.get('/r/:token/event', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.id AS event_id, e.slug
         FROM rsvps r JOIN events e ON e.id=r.event_id
        WHERE r.manage_token=$1`,
      [req.params.token]
    );
    if (!rows.length) return res.status(404).send(render404());
    setAttendeeCookie(res, rows[0].event_id, req.params.token);
    res.redirect(303, `/e/${encodeURIComponent(rows[0].slug)}`);
  } catch (err) { next(err); }
});

router.get('/r/:token', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id AS rsvp_id, r.first_name, r.status AS rsvp_status,
              e.id AS event_id, e.*
         FROM rsvps r JOIN events e ON e.id = r.event_id
        WHERE r.manage_token=$1`,
      [req.params.token]
    );
    if (!rows.length) return res.status(404).send(render404());
    const row = rows[0];
    setAttendeeCookie(res, row.event_id, req.params.token);

    const html = rsvpManageTemplate
      .replace(/{{TITLE}}/g, esc(row.title))
      .replace(/{{FIRST_NAME}}/g, esc(row.first_name))
      .replace(/{{DATE_STR}}/g, esc(fmtDate(row.event_date)))
      .replace(/{{TIME_STR}}/g, esc(formatTime(row.start_time)))
      .replace(/{{VENUE_NAME}}/g, esc(row.venue_name))
      .replace(/{{EVENT_URL}}/g, esc(`/e/${row.slug}`))
      .replace(/{{EVENT_LINK_LABEL}}/g, row.comments_enabled ? 'View event & comments' : 'View event')
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
    res.send(unsubscribePage("You're unsubscribed. You won't get future-event emails from this host.", true));
  } catch (err) { next(err); }
});

function unsubscribePage(message, ok) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribe — Silver Glider Events</title><link rel="stylesheet" href="/css/brand.css"><script src="/js/legal-footer.js" defer></script></head>
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
