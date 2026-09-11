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
const { clearSessionCookie } = require('../lib/session');
const { linkVerifiedRsvps } = require('../lib/account-rsvps');
const { ensureGuestIdentity } = require('../lib/guest-identity');
const {
  clearGuestSessionCookie,
  createGuestSession,
  guestVerifiedFor,
  readGuestSession,
  revokeGuestSession,
  setGuestSessionCookie,
  tokenHash
} = require('../lib/guest-session');
const { clearPhotoAccessCookie } = require('../lib/photo-access');
const { createSignInChallenge, maskEmail } = require('../lib/sign-in-challenges');
const { createRateLimiter, clientIp } = require('../lib/rate-limit');
const { flyerPrimaryAction, formatTicketPrice } = require('../lib/flyer-action');
const { isExternalTickets, isSilverGliderTickets } = require('../lib/admission');
const { commerceAdmissionEnabled } = require('../lib/commerce-client');
const { esc, fmtDate, render404 } = require('../lib/public-html');
const { renderOwnerEditor } = require('../lib/event-owner-editor');
const { cleanInstagramHandle } = require('../lib/host-profile');
const {
  SMS_CONSENT_DISCLOSURE,
  prepareRsvpSmsConsent,
  smsConsentHeading
} = require('../lib/sms-consent');
const LocationUtils = require('../../public/js/location-utils');
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
  robotsDirective,
  safeAvatarUrl
} = require('../lib/private-events');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailConsentHeading(hostName) {
  const host = String(hostName || '').trim().replace(/\s+/g, ' ').slice(0, 120) || 'this host';
  return `Keep me posted about future events and updates from ${host}.`;
}

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

// Confirmation emails are sent after the RSVP response so guests never wait on
// the mail provider. Tracking the work lets tests wait for it to finish before
// wiping the database; untracked, it raced the next test's TRUNCATE and
// deadlocked (seen intermittently since September 4).
const backgroundWork = new Set();
function runInBackground(task) {
  const work = Promise.resolve()
    .then(task)
    .catch(error => console.error('[background]', error.message))
    .finally(() => backgroundWork.delete(work));
  backgroundWork.add(work);
  return work;
}

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
const flyerPublicTemplate = fs.readFileSync(path.join(__dirname, '..', 'views', 'event-public-flyer.html'), 'utf8');
const rsvpManageTemplate = fs.readFileSync(path.join(__dirname, '..', 'views', 'rsvp-manage.html'), 'utf8');
const secretShowTemplate = fs.readFileSync(path.join(__dirname, '..', 'views', 'secret-show.html'), 'utf8');

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

function renderVibe(event) {
  const firstEmbed = vibeEmbed(event.event_vibe_url);
  if (!firstEmbed) return '';
  const secondEmbed = vibeEmbed(event.event_vibe_url_2);
  const firstLabel = String(event.event_vibe_label || '').trim();
  const secondLabel = String(event.event_vibe_label_2 || '').trim();
  if (!secondEmbed || !firstLabel || !secondLabel) {
    return `<section class="vibe-section"><h2>Event Vibe</h2>${firstEmbed}</section>`;
  }
  return `<section class="vibe-section" data-vibe-switcher>
    <h2>Event Vibe</h2>
    <div class="vibe-choice-tabs" role="tablist" aria-label="Choose an artist">
      <button class="vibe-choice-tab is-active" type="button" role="tab" id="vibe-choice-0" aria-controls="vibe-player" aria-selected="true" tabindex="0" data-vibe-choice="0">${esc(firstLabel)}</button>
      <button class="vibe-choice-tab" type="button" role="tab" id="vibe-choice-1" aria-controls="vibe-player" aria-selected="false" tabindex="-1" data-vibe-choice="1">${esc(secondLabel)}</button>
    </div>
    <div class="vibe-player" id="vibe-player" role="tabpanel" aria-labelledby="vibe-choice-0" data-vibe-player>${firstEmbed}</div>
    <template data-vibe-template="0">${firstEmbed}</template>
    <template data-vibe-template="1">${secondEmbed}</template>
  </section>`;
}

async function loadEventBySlug(slug) {
  const { rows } = await pool.query(
    `SELECT e.*,
            e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE e.timezone)::date AS is_past,
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

function renderGuestList(event, rows, { ownerPreview = false } = {}) {
  if (!event.show_guest_list && !ownerPreview) return '';
  const names = publicGuestNames(rows);
  const showPreviewNames = names.length > 0 && names.length <= 5;
  const visibleLimit = 8;
  const avatar = entry => `<span class="guest-avatar" aria-hidden="true"><span>${esc(entry.avatarEmoji)}</span>${entry.avatarUrl
    ? `<img src="${esc(entry.avatarUrl)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">`
    : ''}</span>`;
  const previewItems = names.slice(0, visibleLimit).map(entry => {
    return showPreviewNames
      ? `<li>${avatar(entry)}<span class="guest-avatar-label">${esc(entry.firstName)}</span></li>`
      : `<li aria-label="${esc(entry.firstName)}">${avatar(entry)}</li>`;
  }).join('');
  const remaining = Math.max(0, names.length - visibleLimit);
  const more = remaining
    ? `<li class="guest-avatar-more" aria-label="${remaining} more ${remaining === 1 ? 'person' : 'people'}">+${remaining}</li>`
    : '';
  const modalItems = names.map(entry => {
    return `<li>${avatar(entry)}<span>${esc(entry.firstName)}</span></li>`;
  }).join('');
  const count = Number(event.total_attendance) || 0;
  const attendanceLabel = event.is_past
    ? `${count} ${count === 1 ? 'person' : 'people'} went`
    : `${count} ${count === 1 ? 'person is' : 'people are'} going`;
  const peopleIcon = `<svg class="guest-list-people-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
  const previewAttrs = ownerPreview
    ? ` id="owner-preview-guest-list" data-owner-preview-section="guest-list"${event.show_guest_list ? '' : ' hidden'}`
    : '';
  return `<section class="public-guest-list"${previewAttrs} aria-labelledby="guest-list-title">
    <div class="section-heading">
      <h2 id="guest-list-title">${peopleIcon}<span>${attendanceLabel}</span></h2>
      ${names.length ? '<button class="guest-list-toggle" id="guest-list-toggle" type="button" aria-expanded="false" aria-controls="guest-list-inline guest-list-modal">See everyone <span aria-hidden="true">→</span></button>' : ''}
    </div>
    ${previewItems ? `<ul class="guest-avatar-stack" data-preview-style="${showPreviewNames ? 'named' : 'compact'}" id="guest-avatar-preview" aria-label="Attendee preview">${previewItems}${more}</ul>
    <div class="guest-list-inline" id="guest-list-inline" hidden><ul class="guest-name-list">${modalItems}</ul></div>` : '<p class="section-empty">Be the first to RSVP.</p>'}
  </section>
  ${names.length ? `<div class="guest-list-modal" id="guest-list-modal" hidden>
    <div class="guest-list-modal-card" role="dialog" aria-modal="true" aria-labelledby="guest-list-modal-title" aria-describedby="guest-list-modal-description" tabindex="-1">
      <div class="guest-list-modal-head">
        <div>
          <h2 id="guest-list-modal-title">${peopleIcon}<span>${attendanceLabel}</span></h2>
          <p id="guest-list-modal-description">Everyone who RSVP’d or joined as a guest.</p>
        </div>
        <button class="guest-list-modal-close" id="guest-list-modal-close" type="button" aria-label="Close attendee list">×</button>
      </div>
      <ul class="guest-name-list">${modalItems}</ul>
    </div>
  </div>` : ''}`;
}

function renderGuestFields(event, { ownerPreview = false } = {}) {
  if (!event.allow_guests && !ownerPreview) return '';
  const previewAttrs = ownerPreview
    ? ` id="owner-preview-guest-fields" data-owner-preview-section="guest-fields"${event.allow_guests ? '' : ' hidden'}`
    : '';
  return `<div${previewAttrs}><fieldset class="party-size-field">
    <legend>Who is attending?</legend>
    <label><input type="radio" name="party_size" value="solo" checked> Just me</label>
    <label><input type="radio" name="party_size" value="guest"> I’m bringing someone</label>
  </fieldset>
  <div id="guest-fields" hidden>
    <div class="sg-field"><label for="guest_name">Guest name</label><input class="sg-input" id="guest_name" maxlength="160" autocomplete="name"></div>
    <div class="sg-field"><label for="guest_email">Guest email <span style="opacity:.5;text-transform:none;letter-spacing:0">(optional)</span></label><input class="sg-input" type="email" id="guest_email" maxlength="254" autocomplete="email"></div>
  </div></div>`;
}

function renderComments(event, { ownerPreview = false } = {}) {
  if (!event.comments_enabled && !ownerPreview) return '';
  return `<section class="event-wall" id="event-wall"${ownerPreview ? ` data-owner-preview-section="comments"${event.comments_enabled ? '' : ' hidden'}` : ''} aria-labelledby="event-wall-title">
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

function recapImageUrl(source) {
  const url = String(source || '');
  return url.includes('/image/upload/')
    ? url.replace('/image/upload/', '/image/upload/f_auto,q_auto:good,w_1200,c_limit/')
    : url;
}

function renderFeaturedPhotos(event, photos) {
  if (!photos.length) return '';
  const items = photos.map((photo, index) => `<a href="${esc(photo.image_url)}" target="_blank" rel="noopener" aria-label="Open ${esc(event.title)} photo ${index + 1}">
      <img src="${esc(recapImageUrl(photo.image_url))}" alt="${esc(event.title)} photo ${index + 1}" loading="lazy" decoding="async">
    </a>`).join('');
  return `<section class="event-recap" id="event-recap" aria-labelledby="event-recap-title">
    <div class="section-heading"><h2 id="event-recap-title">Event photos</h2><span>${photos.length}</span></div>
    <div class="event-recap-grid">${items}</div>
  </section>`;
}

function setAttendeeCookie(res, eventId, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${attendeeCookieName(eventId)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${180 * 24 * 3600}${secure}`);
}

function renderSmsReminderOptin(event) {
  if (!event.sms_reminder_enabled || event.secret_show_enabled) return '';
  return `<section class="sms-reminder-optin" aria-labelledby="sms-reminder-optin-title">
    <div class="sms-reminder-optin-head"><strong id="sms-reminder-optin-title">Text reminder</strong><span>Optional</span></div>
    <label class="check"><input type="checkbox" id="sms_optin"><span class="channel-consent-copy"><strong>${esc(smsConsentHeading(event.org_name))}</strong><small>${esc(SMS_CONSENT_DISCLOSURE)}</small></span></label>
    <div class="sg-field sms-reminder-phone" id="sms-reminder-phone" hidden><label for="phone">Mobile number</label><input class="sg-input" type="tel" id="phone" autocomplete="tel" inputmode="tel" placeholder="(555) 555-1234"></div>
  </section>`;
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

// req.sessionAccount is resolved once per request by sessionMiddleware and
// already reflects server-side revocation ("Sign out of all devices").
function organizerViewer(req, event) {
  return Number(req.sessionAccount?.id) === Number(event.organizer_id);
}

function verifiedSessionAccountId(req, email) {
  const account = req.sessionAccount;
  if (!account) return null;
  return String(account.email || '').toLowerCase() === String(email || '').toLowerCase() ? account.id : null;
}

function firstNameFrom(value) {
  return String(value || '').trim().split(/\s+/)[0].slice(0, 80) || 'there';
}

async function returningGuestContext(db, req, eventId) {
  // A personal link from this guest's own email (confirmation "View event",
  // the manage link, a text reminder) leaves this event's attendee cookie. It
  // proves this exact RSVP, so the page shows their answer — for this event
  // only, since the cookie is per event.
  const attendeeToken = readCookie(req, attendeeCookieName(eventId));
  if (attendeeToken && attendeeToken.length <= 100) {
    const rsvp = (await db.query(
      `SELECT * FROM rsvps
        WHERE event_id=$1 AND manage_token=$2 AND status IN ('confirmed','cancelled')`,
      [eventId, attendeeToken]
    )).rows[0];
    if (rsvp) {
      return {
        identityId: rsvp.account_id || null,
        email: rsvp.email,
        displayFirstName: firstNameFrom(rsvp.first_name),
        displayName: `${rsvp.first_name || ''} ${rsvp.last_name || ''}`.trim() || rsvp.first_name,
        verified: true,
        source: 'attendee',
        sessionId: null,
        rsvp
      };
    }
  }

  const identity = req.sessionAccount;
  if (identity) {
    const rsvp = (await db.query(
      `SELECT *
         FROM rsvps WHERE event_id=$1 AND account_id=$2 LIMIT 1`,
      [eventId, identity.id]
    )).rows[0] || null;
    return {
      identityId: identity.id,
      email: identity.email,
      displayFirstName: rsvp?.first_name || firstNameFrom(identity.name),
      displayName: rsvp ? rsvp.first_name : (identity.name || firstNameFrom(identity.email)),
      verified: true,
      source: 'account',
      sessionId: null,
      rsvp
    };
  }

  const guest = await readGuestSession(db, req, { touch: true });
  if (!guest) return null;
  // Verified power (acting on the identity's RSVPs from any device) applies
  // only where the email was proven: everywhere after a typed code, or on the
  // one event a personal invitation link was for. Forwarded invitations stay
  // scoped to that event.
  const verifiedHere = guestVerifiedFor(guest, eventId);
  const ownershipClause = verifiedHere
    ? '(guest_session_id=$2 OR account_id=$3)'
    : 'guest_session_id=$2';
  const values = verifiedHere
    ? [eventId, guest.id, guest.identity_id]
    : [eventId, guest.id];
  let rsvp = (await db.query(
    `SELECT *
       FROM rsvps WHERE event_id=$1 AND ${ownershipClause} LIMIT 1`,
    values
  )).rows[0] || null;
  if (!rsvp && verifiedHere) {
    // Proven email, RSVP made on another device and never linked.
    rsvp = (await db.query(
      'SELECT * FROM rsvps WHERE event_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1',
      [eventId, guest.email]
    )).rows[0] || null;
  }
  return {
    identityId: guest.identity_id,
    email: guest.email,
    displayFirstName: rsvp?.first_name || guest.display_first_name,
    displayName: guest.display_name,
    verified: verifiedHere,
    source: 'guest',
    sessionId: guest.id,
    rsvp
  };
}

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

// A Familiar Faces invitation is a mailbox-verification link, not an account
// sign-in. GET only recognizes the guest; it never records an RSVP because
// email security scanners frequently open links automatically. Invitations
// also get forwarded ("want to come?"), so the verification it grants is
// scoped to this one event and the page offers "Not <name>?".
router.get('/g/:token', async (req, res, next) => {
  const invitationToken = String(req.params.token || '').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(invitationToken)) return res.status(404).send(render404());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT invitation.id,invitation.identity_id,invitation.target_event_id,
              ml.recipient,ml.recipient_name,e.slug
         FROM guest_invitation_tokens invitation
         JOIN message_log ml ON ml.id=invitation.message_log_id
         JOIN events e ON e.id=invitation.target_event_id
        WHERE invitation.token_hash=$1 AND invitation.revoked_at IS NULL
          AND invitation.expires_at>NOW() AND e.status='published'
        FOR UPDATE OF invitation`,
      [tokenHash(invitationToken)]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).send(render404());
    }
    const invitation = rows[0];
    const displayName = String(invitation.recipient_name || '').trim() || firstNameFrom(invitation.recipient);
    const guestSession = await createGuestSession(client, {
      identityId: invitation.identity_id,
      displayFirstName: firstNameFrom(displayName),
      displayName,
      verified: true,
      verifiedEventId: invitation.target_event_id
    });
    await linkVerifiedRsvps(client, invitation.identity_id, invitation.recipient);
    await client.query(
      'UPDATE guest_invitation_tokens SET opened_at=COALESCE(opened_at,NOW()) WHERE id=$1',
      [invitation.id]
    );
    await client.query('COMMIT');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    setGuestSessionCookie(res, guestSession.token);
    return res.redirect(303, `/e/${encodeURIComponent(invitation.slug)}?invited=1`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

router.get('/api/public/guest-session', async (req, res, next) => {
  try {
    const guest = await readGuestSession(pool, req, { touch: true });
    if (!guest) return res.status(404).json({ recognized: false });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({
      recognized: true,
      firstName: guest.display_first_name,
      maskedEmail: maskEmail(guest.email),
      verified: Boolean(guest.verified_at && guest.verified_event_id == null)
    });
  } catch (error) { next(error); }
});

router.post('/api/public/guest-session/forget', async (req, res, next) => {
  try {
    await revokeGuestSession(pool, req);
    clearSessionCookie(res);
    clearGuestSessionCookie(res);
    clearPhotoAccessCookie(res);
    // "Not Lucas?" on an event page also forgets that event's attendee access,
    // which otherwise keeps recognizing the person who opened a personal link.
    const slug = String(req.body?.eventSlug || '').trim().slice(0, 220);
    if (slug) {
      const { rows } = await pool.query('SELECT id FROM events WHERE slug=$1', [slug]);
      if (rows[0]) res.append('Set-Cookie', `${attendeeCookieName(rows[0].id)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true });
  } catch (error) { next(error); }
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
    const rsvpEnabled = !isSilverGliderTickets(event);
    const ownerPreview = organizerViewer(req, event);
    const returningGuest = rsvpEnabled && !event.is_past && event.status === 'published' && !ownerPreview
      ? await returningGuestContext(pool, req, event.id)
      : null;

    if (event.visibility === 'private') {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    }

    let publicGuestRows = [];
    if (rsvpEnabled && (event.show_guest_list || ownerPreview)) {
      publicGuestRows = (await pool.query(
        `SELECT r.id, r.first_name, r.guest_first_name, o.avatar_url
           FROM rsvps r LEFT JOIN organizers o ON o.id=r.account_id
          WHERE r.event_id=$1 AND r.status='confirmed'
          ORDER BY r.created_at ASC, r.id ASC`,
        [event.id]
      )).rows;
    }

    let featuredPhotos = [];
    if (event.collect_photos_enabled && event.status === 'published') {
      featuredPhotos = (await pool.query(
        `SELECT ep.image_url
           FROM event_photos ep JOIN events e ON e.id=ep.event_id
          WHERE ep.event_id=$1 AND ep.is_featured=TRUE AND ep.public_feature_consent=TRUE
            AND e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE e.timezone)::date
          ORDER BY ep.featured_at ASC, ep.id ASC
          LIMIT 8`,
        [event.id]
      )).rows;
    }

    const isFull = rsvpEnabled && event.capacity != null && event.total_attendance >= event.capacity;
    const presenterHtml = event.org_name
      ? `<div class="host-attribution">
          ${event.organizer_logo_url ? `<img src="${esc(event.organizer_logo_url)}" alt="">` : ''}
          <p><span>Presented by</span>${event.organizer_public_slug
            ? `<a href="/h/${encodeURIComponent(event.organizer_public_slug)}">${esc(event.org_name)} <b aria-hidden="true">→</b></a>`
            : `<strong>${esc(event.org_name)}</strong>`}</p>
        </div>`
      : '';
    const isPaid = isExternalTickets(event);
    const isCommerceTicketed = isSilverGliderTickets(event);
    const ticketHtml = event.is_past
      ? ''
      : isCommerceTicketed
      ? '<div class="ticket-note"><span>Tickets</span><em>Sold by Silver Glider</em></div>'
      : isPaid
      ? `<div class="ticket-note"><span>${esc(formatTicketPrice(event.ticket_price))}</span>${event.ticket_url ? `<a href="${esc(event.ticket_url)}" target="_blank" rel="noopener">Ticket link →</a>` : '<em>At the door</em>'}</div>`
      : '<div class="ticket-note"><span>Free</span><em>RSVP</em></div>';
    const vibeHtml = renderVibe(event);
    const flyerAction = flyerPrimaryAction(event);
    const recapHref = featuredPhotos.length ? '#event-recap' : '';
    const endedActionHtml = recapHref
      ? `<a class="sg-btn sg-btn-primary sg-btn-block flyer-primary-cta" data-primary-action="recap" href="${recapHref}">View event photos</a>`
      : '<p class="event-ended-note">This event has ended.</p>';
    const endedMobileActionHtml = recapHref
      ? `<a class="sg-btn sg-btn-primary sg-btn-block" id="mobile-rsvp-cta" href="${recapHref}">View event photos</a>`
      : '';
    const standardPrimaryActionHtml = event.is_past
      ? endedActionHtml
      : isCommerceTicketed
      ? `<a class="sg-btn sg-btn-primary sg-btn-block" id="ticket-cta" data-primary-action="ticket" href="/e/${encodeURIComponent(event.slug)}/tickets" style="font-size:17px;padding:17px">Get Tickets</a>`
      : '<button class="sg-btn sg-btn-primary sg-btn-block" id="rsvp-cta" data-primary-action="rsvp" data-open-rsvp style="font-size:17px;padding:17px">RSVP</button>';
    const standardMobileActionHtml = event.is_past
      ? endedMobileActionHtml
      : isCommerceTicketed
      ? `<a class="sg-btn sg-btn-primary sg-btn-block" id="mobile-rsvp-cta" href="/e/${encodeURIComponent(event.slug)}/tickets">Get Tickets</a>`
      : '<button class="sg-btn sg-btn-primary sg-btn-block" id="mobile-rsvp-cta" data-open-rsvp type="button" aria-controls="rsvp-form-box">RSVP</button>';
    const flyerPrimaryActionHtml = event.is_past
      ? endedActionHtml
      : flyerAction.type === 'ticket'
      ? `<a class="sg-btn sg-btn-primary sg-btn-block flyer-primary-cta" id="ticket-cta" data-primary-action="ticket" href="${esc(flyerAction.url)}" target="_blank" rel="noopener">${esc(flyerAction.label)}</a>`
      : flyerAction.type === 'commerce_ticket'
      ? `<a class="sg-btn sg-btn-primary sg-btn-block flyer-primary-cta" id="ticket-cta" data-primary-action="ticket" href="${esc(flyerAction.url)}">${esc(flyerAction.label)}</a>`
      : `<button class="sg-btn sg-btn-primary sg-btn-block flyer-primary-cta" id="rsvp-cta" data-primary-action="rsvp" data-open-rsvp type="button">${esc(flyerAction.label)}</button>`;
    const flyerSecondaryActionHtml = !event.is_past && flyerAction.secondaryRsvp
      ? '<button class="flyer-secondary-rsvp" id="rsvp-cta" data-open-rsvp type="button">RSVP instead</button>'
      : '';
    const flyerActionSupportHtml = !event.is_past && flyerAction.supportingText
      ? `<p class="primary-action-support">${esc(flyerAction.supportingText)}</p>`
      : '';
    const flyerMobileActionHtml = event.is_past
      ? endedMobileActionHtml
      : flyerAction.type === 'ticket'
      ? `<a class="sg-btn sg-btn-primary sg-btn-block" id="mobile-rsvp-cta" href="${esc(flyerAction.url)}" target="_blank" rel="noopener">${esc(flyerAction.label)}</a>`
      : flyerAction.type === 'commerce_ticket'
      ? `<a class="sg-btn sg-btn-primary sg-btn-block" id="mobile-rsvp-cta" href="${esc(flyerAction.url)}">${esc(flyerAction.label)}</a>`
      : `<button class="sg-btn sg-btn-primary sg-btn-block" id="mobile-rsvp-cta" data-open-rsvp type="button" aria-controls="rsvp-form-box">${esc(flyerAction.label)}</button>`;

    const venueSummary = [event.venue_city, event.venue_state].filter(Boolean).join(', ');
    const locationDisplay = LocationUtils.displayParts(event.venue_name, event.venue_address);
    const locationQuery = LocationUtils.locationQuery(event.venue_name, event.venue_address);
    const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent(locationQuery)}`;
    const flyerVenueText = locationDisplay.address || (!event.venue_address ? venueSummary : '');
    const flyerVenueHtml = `<div class="flyer-venue"><strong>${esc(locationDisplay.name)}</strong>${flyerVenueText ? `<span>${esc(flyerVenueText)}</span>` : ''}<a href="${esc(mapsUrl)}" target="_blank" rel="noopener">Open in Maps →</a></div>`;
    const detailParts = [];
    if (event.category) detailParts.push(`<p class="detail-category"><span>Category</span><strong>${esc(event.category)}</strong></p>`);
    if (event.description) detailParts.push(`<div class="desc">${esc(event.description).replace(/\n/g, '<br>')}</div>`);
    if (vibeHtml) detailParts.push(vibeHtml);
    const flyerAdditionalDetailsHtml = detailParts.length
      ? `<section class="additional-details" aria-labelledby="additional-details-title"><h2 id="additional-details-title">Event details</h2>${detailParts.join('')}</section>`
      : '';

    // Violet and ember are legacy-only: hidden from the MVP picker, but still
    // rendered for already-published events that selected them.
    const THEMES = ['midnight', 'aurora', 'sunset', 'ocean', 'adaptive', 'violet', 'ember'];
    const EFFECTS = ['static', 'paper', 'halloween', 'liquid-stardust', 'color-static', 'last-guest', 'disco', 'fog', 'saloon'];
    const VIDEO_EFFECTS = {
      halloween: 'sg-events/effects/halloween',
      'liquid-stardust': 'sg-events/effects/liquid-stardust',
      'color-static': 'sg-events/effects/color-static',
      'last-guest': 'sg-events/effects/the-last-guest',
      disco: 'sg-events/effects/disco',
      fog: 'sg-events/effects/fog'
    };
    const chosen = event.background_theme;
    const isEffect = EFFECTS.includes(chosen);
    const theme = (THEMES.includes(chosen) || isEffect) ? chosen : 'midnight';
    const bgClass = isEffect ? `fx-${theme}` : `bg-${theme}`;
    const videoPublicId = VIDEO_EFFECTS[theme];
    const fxMedia = videoPublicId
      ? `<video class="fx-video-media" data-effect-theme="${theme}" autoplay muted loop playsinline webkit-playsinline preload="auto" poster="https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_1600/${videoPublicId}.jpg" aria-hidden="true" tabindex="-1"><source src="https://res.cloudinary.com/dhvavjgnw/video/upload/f_mp4,vc_h264,q_auto:eco,w_1280,c_limit,fl_progressive/${videoPublicId}.mp4" type="video/mp4"></video>`
      : '';
    // Effects sit behind everything and need a darkening veil for legibility
    const fxVeil = `<div id="event-fx-veil" class="fx-veil${theme === 'paper' ? ' fx-veil-soft' : ''}${theme === 'saloon' ? ' fx-veil-warm' : ''}" aria-hidden="true"${isEffect ? '' : ' hidden'}></div>`;
    const isFlyerPresentation = event.presentation_mode === 'flyer' && Boolean(event.flyer_image_url);
    const coverFitMode = ['contain', 'cover'].includes(event.cover_fit_mode) ? event.cover_fit_mode : 'auto';
    const flyerImageUrl = isFlyerPresentation ? event.flyer_image_url : null;
    const primaryImageUrl = flyerImageUrl || event.cover_image_url;
    const heroHtml = flyerImageUrl
      ? `<div class="hero flyer-hero" id="hero"><img src="${esc(flyerImageUrl)}" alt="${esc(event.title)} flyer" onerror="this.parentElement.classList.add('no-image'${isEffect ? '' : `,'bg-theme','bg-${theme}'`});this.remove()"></div>`
      : event.cover_image_url
      ? `<div class="hero standard-hero cover-fit-${coverFitMode}" id="hero"><img src="${esc(event.cover_image_url)}" alt="" onerror="this.parentElement.classList.add('no-image'${isEffect ? '' : `,'bg-theme','bg-${theme}'`});this.remove()"></div>`
      : (isEffect
          ? `<div class="hero no-image" id="hero"></div>`
          : `<div class="hero no-image bg-theme bg-${theme}" id="hero"></div>`);

    // Unsplash attribution (only when a credited photo is the cover)
    const creditHtml = (!isFlyerPresentation && event.cover_image_url && event.cover_credit_name)
      ? `<p class="photo-credit">Photo by <a href="${esc(event.cover_credit_link || '#')}" target="_blank" rel="noopener">${esc(event.cover_credit_name)}</a> on <a href="https://unsplash.com/?utm_source=silver_glider_events&utm_medium=referral" target="_blank" rel="noopener">Unsplash</a></p>`
      : '';
    const flyerInstagramHandle = cleanInstagramHandle(event.flyer_designer_instagram_handle).value;
    const flyerDesignerName = String(event.flyer_designer_name || '').trim();
    const flyerDesignCreditHtml = isFlyerPresentation && flyerInstagramHandle
      ? `<p class="flyer-design-credit">Design by <a href="https://www.instagram.com/${encodeURIComponent(flyerInstagramHandle)}/" target="_blank" rel="noopener noreferrer">@${esc(flyerInstagramHandle)}</a></p>`
      : isFlyerPresentation && flyerDesignerName
        ? `<p class="flyer-design-credit">Design by ${esc(flyerDesignerName)}</p>`
        : '';

    const returningGuestJson = returningGuest ? {
      firstName: returningGuest.displayFirstName,
      response: returningGuest.rsvp?.status === 'confirmed'
        ? 'going'
        : returningGuest.rsvp?.status === 'cancelled' ? 'not_going' : null
    } : null;
    const eventJson = {
      slug: event.slug,
      title: event.title,
      status: event.status,
      isFull,
      commentsEnabled: event.comments_enabled,
      rsvpEnabled,
      isPast: event.is_past,
      coverImageUrl: primaryImageUrl || null,
      coverFitMode,
      adaptiveBackground: theme === 'adaptive',
      ownerPreview,
      returningGuest: returningGuestJson,
      bgEffect: isEffect ? theme : null
    };
    const ownerEditorHtml = ownerPreview ? renderOwnerEditor(event) : '';

    const activePublicTemplate = isFlyerPresentation ? flyerPublicTemplate : publicTemplate;
    const html = activePublicTemplate
      .replace(/{{TITLE}}/g, esc(event.title))
      .replace(/{{ROBOTS_DIRECTIVE}}/g, esc(robotsDirective(event.visibility)))
      .replace(/{{OG_DESCRIPTION}}/g, esc(`${fmtDate(event.event_date)} · ${locationDisplay.name}`))
      .replace(/{{OG_IMAGE}}/g, esc(primaryImageUrl || `${process.env.APP_URL}/logo.png`))
      .replace(/{{OG_URL}}/g, esc(`${process.env.APP_URL}/e/${event.slug}`))
      .replace(/{{BODY_CLASS}}/g, bgClass)
      .replace(/{{FX_MEDIA}}/g, fxMedia)
      .replace(/{{FX_VEIL}}/g, fxVeil)
      .replace(/{{HERO}}/g, heroHtml)
      .replace(/{{PHOTO_CREDIT}}/g, creditHtml)
      .replace(/{{FLYER_DESIGN_CREDIT}}/g, flyerDesignCreditHtml)
      .replace(/{{DATE_STR}}/g, esc(fmtDate(event.event_date)))
      .replace(/{{TIME_STR}}/g, esc(formatTime(event.start_time) + (event.end_time ? ` – ${formatTime(event.end_time)}` : '')))
      .replace(/{{VENUE_NAME}}/g, esc(locationDisplay.name))
      .replace(/{{VENUE_ADDRESS}}/g, esc(locationDisplay.address))
      .replace(/{{MAPS_URL}}/g, esc(mapsUrl))
      .replace(/{{TICKET_HTML}}/g, ticketHtml)
      .replace(/{{DESCRIPTION_HTML}}/g, esc(event.description || '').replace(/\n/g, '<br>'))
      .replace(/{{VIBE_HTML}}/g, vibeHtml)
      .replace(/{{PRESENTER_HTML}}/g, presenterHtml)
      .replace(/{{GUEST_FIELDS_HTML}}/g, rsvpEnabled ? renderGuestFields(event, { ownerPreview }) : '')
      .replace(/{{SMS_REMINDER_OPTIN_HTML}}/g, rsvpEnabled ? renderSmsReminderOptin(event) : '')
      .replace(/{{EMAIL_CONSENT_HEADING}}/g, esc(emailConsentHeading(event.org_name)))
      .replace(/{{GUEST_LIST_HTML}}/g, rsvpEnabled ? renderGuestList(event, publicGuestRows, { ownerPreview }) : '')
      .replace(/{{COMMENTS_HTML}}/g, rsvpEnabled ? renderComments(event, { ownerPreview }) : '')
      .replace(/{{RECAP_GALLERY_HTML}}/g, renderFeaturedPhotos(event, featuredPhotos))
      .replace(/{{CATEGORY}}/g, esc(event.category || ''))
      .replace(/{{STANDARD_PRIMARY_ACTION_HTML}}/g, standardPrimaryActionHtml)
      .replace(/{{STANDARD_MOBILE_ACTION_HTML}}/g, standardMobileActionHtml)
      .replace(/{{FLYER_VENUE_HTML}}/g, flyerVenueHtml)
      .replace(/{{PRIMARY_ACTION_HTML}}/g, flyerPrimaryActionHtml)
      .replace(/{{PRIMARY_ACTION_SUPPORT_HTML}}/g, flyerActionSupportHtml)
      .replace(/{{SECONDARY_ACTION_HTML}}/g, flyerSecondaryActionHtml)
      .replace(/{{ADDITIONAL_DETAILS_HTML}}/g, flyerAdditionalDetailsHtml)
      .replace(/{{MOBILE_PRIMARY_ACTION_HTML}}/g, flyerMobileActionHtml)
      .replace(/{{OWNER_EDITOR_HTML}}/g, ownerEditorHtml)
      .replace(/{{EVENT_JSON}}/g, JSON.stringify(eventJson).replace(/</g, '\\u003c'));

    res.send(html);
  } catch (err) { next(err); }
});

// Stable Events-owned handoff URL. It enforces event visibility before any
// future Commerce request. The actual checkout endpoint will be added only
// after the Commerce contract is supplied and verified.
router.get('/e/:slug/tickets', async (req, res, next) => {
  try {
    const event = await loadEventBySlug(req.params.slug);
    if (!event || !isSilverGliderTickets(event) || !event.commerce_event_id) {
      return res.status(404).send(render404());
    }
    if (secretShowLocked(req, event)) return res.status(404).send(render404());
    if (event.is_past || event.status !== 'published') {
      return res.status(410).type('html').send(ticketHandoffPage(event, 'Ticket sales for this event are closed.'));
    }
    const message = commerceAdmissionEnabled()
      ? 'Ticket checkout is not connected yet. Please try again shortly.'
      : 'Ticket checkout is temporarily unavailable. Please try again shortly.';
    res.setHeader('Retry-After', '60');
    return res.status(503).type('html').send(ticketHandoffPage(event, message));
  } catch (err) { next(err); }
});

function ticketHandoffPage(event, message) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tickets — ${esc(event.title)}</title><link rel="stylesheet" href="/css/brand.css"></head>
<body><main style="max-width:460px;margin:0 auto;padding:18vh 24px;text-align:center">
<p class="sg-label" style="margin-bottom:20px">Silver Glider Tickets</p><h1 style="font-size:30px;margin-bottom:12px">${esc(event.title)}</h1>
<p style="color:var(--sg-text-dim);font-size:16px;line-height:1.65;margin-bottom:26px">${esc(message)}</p>
<a class="sg-btn sg-btn-ghost" href="/e/${encodeURIComponent(event.slug)}">Return to event</a></main></body></html>`;
}

// GET /api/public/events/:slug/comments — safe public wall data only.
router.get('/api/public/events/:slug/comments', async (req, res, next) => {
  try {
    const event = await loadEventBySlug(req.params.slug);
    if (!event) {
      return res.status(404).json({ error: 'Event wall not found' });
    }
    if (secretShowLocked(req, event)) return rejectLockedSecret(res);
    const canModerate = organizerViewer(req, event);
    if (!event.comments_enabled && !canModerate) {
      return res.status(404).json({ error: 'Event wall not found' });
    }
    const attendee = await confirmedAttendee(req, event);
    const { rows } = await pool.query(
      `SELECT c.id, c.message, c.created_at, c.rsvp_id, r.first_name
         FROM event_comments c
         JOIN rsvps r ON r.id=c.rsvp_id
        WHERE c.event_id=$1
        ORDER BY c.created_at ASC, c.id ASC`,
      [event.id]
    );
    res.json({
      canComment: event.comments_enabled && event.status === 'published' && Boolean(attendee),
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
    if (!event || !event.comments_enabled || event.status !== 'published') {
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
    const requestedSmsOptin = req.body.sms_optin === true;

    if (!firstName) return res.status(400).json({ error: 'Enter your name' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email' });

    await client.query('BEGIN');
    const { rows: evRows } = await client.query(
      `SELECT e.*,
              e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE e.timezone)::date AS is_past,
              o.org_name, o.public_slug AS organizer_public_slug
         FROM events e JOIN organizers o ON o.id=e.organizer_id
        WHERE e.slug=$1 AND e.status='published'
        FOR UPDATE OF e`, [req.params.slug]
    );
    if (!evRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found' });
    }
    const event = evRows[0];
    if (event.is_past) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'event_ended', message: 'This event has ended.' });
    }
    if (secretShowLocked(req, event)) {
      await client.query('ROLLBACK');
      return rejectLockedSecret(res);
    }
    if (isSilverGliderTickets(event)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'tickets_required',
        message: 'Get tickets through Silver Glider for this event.'
      });
    }

    let smsConsent;
    try {
      smsConsent = prepareRsvpSmsConsent({
        optedIn: event.sms_reminder_enabled && requestedSmsOptin,
        phone,
        hostName: event.org_name
      });
    } catch (error) {
      await client.query('ROLLBACK');
      return res.status(error.status === 400 ? 400 : 500).json({ error: error.message });
    }

    const { rows: existing } = await client.query(
      `SELECT * FROM rsvps WHERE event_id=$1 AND LOWER(email)=LOWER($2)`, [event.id, email]
    );
    const accountId = verifiedSessionAccountId(req, email);
    const rememberedGuest = accountId ? null : await readGuestSession(client, req, { touch: true });
    // An identity is "proven" by a signed-in account with this email, or by a
    // remembered guest that verified this email (a code, or this event's own
    // invitation link).
    const provenIdentityId = accountId || (
      rememberedGuest && guestVerifiedFor(rememberedGuest, event.id) &&
      String(rememberedGuest.email).toLowerCase() === email
        ? rememberedGuest.identity_id
        : null
    );
    const attendeeToken = readCookie(req, attendeeCookieName(event.id));
    const ownsExisting = Boolean(existing[0] && (
      provenIdentityId ||
      (rememberedGuest && Number(existing[0].guest_session_id) === Number(rememberedGuest.id)) ||
      (attendeeToken && attendeeToken === existing[0].manage_token)
    ));
    if (existing.length && existing[0].status === 'confirmed') {
      if (provenIdentityId && !existing[0].account_id) {
        existing[0] = (await client.query(
          'UPDATE rsvps SET account_id=$2 WHERE id=$1 RETURNING *',
          [existing[0].id, provenIdentityId]
        )).rows[0];
      }
      await client.query('COMMIT');
      const confirmationResent = await claimConfirmation(event, existing[0]).catch(error => {
        console.error('[rsvp-confirmation]', error.message);
        return null;
      });
      if (confirmationResent) runInBackground(() => deliverClaimedConfirmation(event, existing[0], confirmationResent));
      return res.json({ ok: true, alreadyRsvpd: true, confirmationResent: Boolean(confirmationResent) });
    }

    // Re-confirming a cancelled RSVP would overwrite its name, phone and text
    // consent. Knowing someone's email is not enough for that: the guest proves
    // it first with a code (the client shows it inline, then retries).
    if (existing.length && !ownsExisting) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'verification_required',
        message: 'Confirm it’s you to rejoin this event.',
        maskedEmail: maskEmail(email)
      });
    }

    const guest = parseNamedGuest({ allow_guests: event.allow_guests }, req.body);
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
    let guestSessionId = rememberedGuest && ownsExisting ? rememberedGuest.id : null;
    let guestSessionToRemember = null;
    if (isNewRsvp && !accountId) {
      if (rememberedGuest && String(rememberedGuest.email).toLowerCase() === email) {
        guestSessionId = rememberedGuest.id;
      } else {
        const displayName = `${firstName} ${lastName}`.trim();
        const identity = await ensureGuestIdentity(client, { email, displayName });
        guestSessionToRemember = await createGuestSession(client, {
          identityId: identity.id,
          displayFirstName: firstName,
          displayName,
          verified: false
        });
        guestSessionId = guestSessionToRemember.id;
      }
    }
    if (existing.length) {
      // previously cancelled — re-confirm
      rsvp = (await client.query(
        `UPDATE rsvps SET status='confirmed', first_name=$2, last_name=$3, phone=$4,
                wants_reminders=$5, organizer_optin=$6, sms_optin=$7,
                sms_consent_at=CASE WHEN $7 THEN $8 ELSE sms_consent_at END,
                sms_consent_source=CASE WHEN $7 THEN $9 ELSE sms_consent_source END,
                sms_consent_version=CASE WHEN $7 THEN $10 ELSE sms_consent_version END,
                sms_consent_text=CASE WHEN $7 THEN $11 ELSE sms_consent_text END,
                sms_opted_out_at=CASE WHEN $7 THEN NULL WHEN sms_optin THEN NOW() ELSE sms_opted_out_at END,
                guest_first_name=$12, guest_last_name=$13, guest_email=$14,
                account_id=COALESCE(account_id,$15),
                guest_session_id=COALESCE(guest_session_id,$16)
          WHERE id=$1 RETURNING *`,
        [existing[0].id, firstName, lastName, smsConsent.phone, wantsReminders, organizerOptin,
         smsConsent.optedIn, smsConsent.consentedAt, smsConsent.source, smsConsent.version, smsConsent.text,
         guest.guestFirstName, guest.guestLastName, guest.guestEmail, provenIdentityId, guestSessionId]
      )).rows[0];
    } else {
      rsvp = (await client.query(
        `INSERT INTO rsvps (event_id, first_name, last_name, email, phone, wants_reminders, organizer_optin,
                            sms_optin, sms_consent_at, sms_consent_source, sms_consent_version, sms_consent_text,
                            guest_first_name, guest_last_name, guest_email, manage_token, account_id,
                            guest_session_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [event.id, firstName, lastName, email, smsConsent.phone, wantsReminders, organizerOptin,
         smsConsent.optedIn, smsConsent.consentedAt, smsConsent.source, smsConsent.version, smsConsent.text,
         guest.guestFirstName, guest.guestLastName, guest.guestEmail,
         crypto.randomBytes(16).toString('hex'), provenIdentityId, guestSessionId]
      )).rows[0];
    }
    await client.query('COMMIT');

    // A fresh RSVP, or a rejoin by its proven owner, establishes attendee
    // access on this browser immediately. Knowing another attendee's email can
    // never grant comment or deletion access.
    if (event.comments_enabled && (isNewRsvp || ownsExisting)) {
      setAttendeeCookie(res, event.id, rsvp.manage_token);
    }
    if (guestSessionToRemember) setGuestSessionCookie(res, guestSessionToRemember.token);
    runInBackground(() => resendConfirmation(event, rsvp));
    res.status(201).json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// A recognized guest can answer with one tap. Unverified browser sessions are
// deliberately scoped to RSVPs created by that exact session. Account sessions
// and code-verified guests may use the identity across events; an invitation
// link's verification covers only its own event.
router.post('/api/public/events/:slug/returning-rsvp', protectRsvp, async (req, res, next) => {
  const answer = String(req.body?.response || '').trim();
  if (!['going', 'not_going'].includes(answer)) {
    return res.status(400).json({ error: 'Choose whether you are going' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: eventRows } = await client.query(
      `SELECT e.*,
              e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE e.timezone)::date AS is_past,
              o.org_name,o.public_slug AS organizer_public_slug
         FROM events e JOIN organizers o ON o.id=e.organizer_id
        WHERE e.slug=$1 AND e.status='published'
        FOR UPDATE OF e`,
      [req.params.slug]
    );
    if (!eventRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found' });
    }
    const event = eventRows[0];
    if (event.is_past) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'event_ended', message: 'This event has ended.' });
    }
    if (secretShowLocked(req, event)) {
      await client.query('ROLLBACK');
      return rejectLockedSecret(res);
    }
    if (isSilverGliderTickets(event)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'tickets_required', message: 'Get tickets through Silver Glider for this event.' });
    }

    const guest = await returningGuestContext(client, req, event.id);
    if (!guest) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'This browser is no longer recognized. Enter your name and email again.' });
    }

    let rsvp = guest.rsvp;
    if (!rsvp) {
      const { rows: sameEmail } = await client.query(
        'SELECT id,status FROM rsvps WHERE event_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1',
        [event.id, guest.email]
      );
      if (sameEmail.length) {
        // An RSVP under this email exists but this browser can't prove it owns
        // it. The client offers an inline email code, then retries.
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'verification_required',
          message: 'Confirm it’s you to update this RSVP.',
          maskedEmail: maskEmail(guest.email)
        });
      }
    }

    if (answer === 'going' && rsvp?.status !== 'confirmed') {
      const partySize = rsvp?.guest_first_name ? 2 : 1;
      const { rows: countRows } = await client.query(
        `SELECT (COUNT(*) + COUNT(guest_first_name))::int AS n
           FROM rsvps WHERE event_id=$1 AND status='confirmed'`,
        [event.id]
      );
      if (event.capacity != null && countRows[0].n + partySize > event.capacity) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'full', message: 'This event has reached capacity.' });
      }
    }

    if (rsvp) {
      const { rows } = await client.query(
        `UPDATE rsvps
            SET status=$2,
                account_id=CASE WHEN $3 THEN COALESCE(account_id,$4) ELSE account_id END,
                guest_session_id=COALESCE(guest_session_id,$5)
          WHERE id=$1 RETURNING *`,
        [rsvp.id, answer === 'going' ? 'confirmed' : 'cancelled', guest.verified,
         guest.identityId, guest.sessionId]
      );
      rsvp = rows[0];
    } else {
      const nameParts = String(guest.displayName || guest.displayFirstName).trim().split(/\s+/);
      const firstName = (nameParts.shift() || guest.displayFirstName).slice(0, 80);
      const lastName = nameParts.join(' ').slice(0, 80);
      const { rows } = await client.query(
        `INSERT INTO rsvps
           (event_id,first_name,last_name,email,wants_reminders,organizer_optin,status,
            manage_token,account_id,guest_session_id)
         VALUES ($1,$2,$3,$4,TRUE,FALSE,$5,$6,$7,$8)
         RETURNING *`,
        [event.id, firstName, lastName, guest.email,
         answer === 'going' ? 'confirmed' : 'cancelled',
         crypto.randomBytes(16).toString('hex'), guest.verified ? guest.identityId : null,
         guest.sessionId]
      );
      rsvp = rows[0];
    }

    if (guest.verified) {
      await client.query(
        `UPDATE guest_invitation_tokens
            SET response=$3,responded_at=NOW(),rsvp_id=$4
          WHERE target_event_id=$1 AND identity_id=$2
            AND revoked_at IS NULL AND expires_at>NOW()`,
        [event.id, guest.identityId, answer, rsvp.id]
      );
    }
    await client.query('COMMIT');

    if (answer === 'going') {
      setAttendeeCookie(res, event.id, rsvp.manage_token);
      if (guest.rsvp?.status !== 'confirmed') runInBackground(() => resendConfirmation(event, rsvp));
    }
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ ok: true, response: answer });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

// Confirmation email — an atomic database claim prevents duplicate sends across
// rapid retries, app restarts, or multiple app instances. One resend is allowed
// after 15 minutes so an attendee can recover a lost confirmation safely.
// The "Add your photo" link is photo-only (intent add_photo): it opens the
// avatar page and upload, never the dashboard, because confirmations get
// forwarded. It has no code; the guest may open it days later on any device.
async function createAddPhotoMagicLink(event, rsvp) {
  const identity = rsvp.account_id
    ? await pool.query('SELECT avatar_url FROM organizers WHERE id=$1', [rsvp.account_id])
    : await pool.query('SELECT avatar_url FROM organizers WHERE LOWER(email)=LOWER($1) LIMIT 1', [rsvp.email]);
  if (safeAvatarUrl(identity.rows[0]?.avatar_url)) return null;
  const { token } = await createSignInChallenge(pool, {
    email: rsvp.email,
    intent: 'add_photo',
    returnPath: `/add-photo?event=${encodeURIComponent(event.slug)}`,
    ttlMinutes: 7 * 24 * 60,
    withCode: false
  });
  const baseUrl = String(process.env.APP_URL || 'https://silvergliderevents.com').replace(/\/$/, '');
  return `${baseUrl}/auth/verify?token=${token}`;
}

// Atomically claims the right to (re)send a confirmation. Returns the
// message_log id when this caller should send, or null when one was sent in the
// last 15 minutes — so the page can say truthfully whether an email went out.
async function claimConfirmation(event, rsvp) {
  const { rows } = await pool.query(
    `INSERT INTO message_log (rsvp_id, event_id, recipient, message_type, channel, status)
     VALUES ($1,$2,$3,'rsvp_confirmation','email','pending')
     ON CONFLICT (rsvp_id, message_type, channel)
       WHERE rsvp_id IS NOT NULL AND notification_batch_id IS NULL
     DO UPDATE SET event_id=EXCLUDED.event_id, recipient=EXCLUDED.recipient,
                   status='pending', provider_id=NULL, error=NULL,
                   created_at=NOW(), sent_at=NULL
     WHERE COALESCE(message_log.sent_at, message_log.created_at) < NOW() - INTERVAL '15 minutes'
     RETURNING id`,
    [rsvp.id, event.id, rsvp.email]
  );
  return rows[0]?.id || null;
}

async function resendConfirmation(event, rsvp) {
  try {
    const logId = await claimConfirmation(event, rsvp);
    if (!logId) return false;
    return deliverClaimedConfirmation(event, rsvp, logId);
  } catch (err) {
    console.error('[rsvp-confirmation]', err.message);
    return false;
  }
}

async function deliverClaimedConfirmation(event, rsvp, logId) {
  try {
    const ics = buildIcs(event);
    const addPhotoUrl = await createAddPhotoMagicLink(event, rsvp);
    const result = await sendRsvpConfirmation({ to: rsvp.email, event, rsvp, icsContent: ics, addPhotoUrl });
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

// A confirmation/reminder recipient can download the calendar file even when
// the event itself is protected by a Secret Show code. The unguessable RSVP
// management token is the authorization boundary for this attendee-only URL.
router.get('/r/:token/calendar.ics', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.*
         FROM rsvps r JOIN events e ON e.id=r.event_id
        WHERE r.manage_token=$1 AND r.status='confirmed'`,
      [req.params.token]
    );
    if (!rows.length) return res.status(404).send('Not found');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${rows[0].slug}.ics"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buildIcs(rows[0]));
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

// A private link in each reminder restores the same event-scoped attendee
// session as the email confirmation link. It verifies control of the supplied
// phone without creating a Silver Glider account or organizer profile.
router.get('/t/:token', async (req, res, next) => {
  const token = String(req.params.token || '');
  if (!/^[0-9a-f]{32}$/i.test(token)) return res.status(404).send(render404());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT sr.id AS recipient_id,r.id AS rsvp_id,r.manage_token,e.id AS event_id,e.slug
         FROM sms_notification_recipients sr
         JOIN rsvps r ON r.id=sr.rsvp_id
         JOIN events e ON e.id=r.event_id
        WHERE sr.access_token=$1 AND sr.access_token_expires_at > NOW()
          AND r.status='confirmed'
        FOR UPDATE OF sr,r`,
      [token]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).send(render404());
    }
    const row = rows[0];
    await client.query(
      'UPDATE sms_notification_recipients SET accessed_at=COALESCE(accessed_at,NOW()),updated_at=NOW() WHERE id=$1',
      [row.recipient_id]
    );
    await client.query(
      'UPDATE rsvps SET sms_phone_verified_at=COALESCE(sms_phone_verified_at,NOW()) WHERE id=$1',
      [row.rsvp_id]
    );
    await client.query('COMMIT');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    setAttendeeCookie(res, row.event_id, row.manage_token);
    res.redirect(303, `/e/${encodeURIComponent(row.slug)}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
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

// Test-only: the in-memory limiters are process-wide.
router.resetRateLimitsForTests = () => {
  rsvpRateLimiter.reset();
  secretUnlockLimiter.reset();
};

// Waits for in-flight confirmation emails (and anything they start) to finish.
router.settleBackgroundWork = async () => {
  while (backgroundWork.size) await Promise.allSettled([...backgroundWork]);
};

module.exports = router;
