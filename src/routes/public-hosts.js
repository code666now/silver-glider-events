const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const { cleanInstagramHandle, cleanProfileUrl } = require('../lib/host-profile');
const { formatTime } = require('../lib/mailer');
const { esc, fmtDate, render404 } = require('../lib/public-html');
const { parseSession, readSessionCookie } = require('../lib/session');
const { isFollowingHost } = require('../lib/host-follows');

const router = express.Router();
const hostTemplate = fs.readFileSync(path.join(__dirname, '..', 'views', 'host-public.html'), 'utf8');

function eventCardVisual(event) {
  if (event.presentation_mode === 'flyer' && event.flyer_image_url) {
    return `<img class="flyer-art" src="${esc(event.flyer_image_url)}" alt="" loading="lazy">`;
  }
  if (event.cover_image_url) {
    return `<img src="${esc(event.cover_image_url)}" alt="" loading="lazy">`;
  }
  const posters = {
    paper: 'https://res.cloudinary.com/dhvavjgnw/image/upload/f_auto,q_auto,w_900/sg-events/textures/kraft-paper.jpg',
    halloween: 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_900/sg-events/effects/halloween.jpg',
    'liquid-stardust': 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_900/sg-events/effects/liquid-stardust.jpg',
    'color-static': 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_900/sg-events/effects/color-static.jpg',
    'last-guest': 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_900/sg-events/effects/the-last-guest.jpg',
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

function renderHostEventCard(event, { past = false } = {}) {
  const time = formatTime(event.start_time);
  const location = [event.venue_name, event.venue_city].filter(Boolean).map(esc).join(' · ');
  return `<a class="host-event-card${past ? ' past' : ''}" href="/e/${encodeURIComponent(event.slug)}" aria-label="View ${esc(event.title)}">
    <div class="host-event-art">${eventCardVisual(event)}</div>
    <div class="host-event-copy">
      <p class="host-event-date">${esc(fmtDate(event.event_date))} · ${esc(time)}</p>
      <h3>${esc(event.title)}</h3>
      ${location ? `<p class="host-event-location">${location}</p>` : ''}
      <span class="host-event-cta">View Event <b aria-hidden="true">→</b></span>
    </div>
  </a>`;
}

function hostInitials(name) {
  return String(name || '').trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || 'SG';
}

function hostSocialLinks(host) {
  const instagramHandle = cleanInstagramHandle(host.instagram_handle || host.instagram_url).value;
  const instagram = instagramHandle ? `https://instagram.com/${encodeURIComponent(instagramHandle)}` : null;
  const website = cleanProfileUrl(host.website_url, 'website').value;
  const links = [];
  if (instagram) {
    links.push(`<a class="host-link" href="${esc(instagram)}" target="_blank" rel="noopener noreferrer" aria-label="Instagram"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"></rect><circle cx="12" cy="12" r="4"></circle><circle cx="17.4" cy="6.6" r="1" fill="currentColor" stroke="none"></circle></svg></a>`);
  }
  if (website) {
    links.push(`<a class="host-link" href="${esc(website)}" target="_blank" rel="noopener noreferrer" aria-label="Website"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M3 12h18M12 3c2.2 2.5 3.4 5.5 3.4 9S14.2 18.5 12 21M12 3C9.8 5.5 8.6 8.5 8.6 12s1.2 6.5 3.4 9"></path></svg></a>`);
  }
  return links.length ? `<nav class="host-links" aria-label="Host links">${links.join('')}</nav>` : '';
}

router.get('/h/:slug', async (req, res, next) => {
  try {
    const { rows: hosts } = await pool.query(
      `SELECT id, org_name, public_slug, logo_url, header_image_url,
              bio, website_url, instagram_handle, instagram_url
         FROM organizers
        WHERE LOWER(public_slug)=LOWER($1) AND org_name IS NOT NULL`,
      [req.params.slug]
    );
    const host = hosts[0];
    if (!host) return res.status(404).send(render404());

    const eventSelect = `SELECT slug, title, cover_image_url, presentation_mode, flyer_image_url, event_date, start_time,
                                venue_name, venue_city, background_theme
                           FROM events
                          WHERE organizer_id=$1
                            AND status='published'
                            AND visibility='public'`;
    const [upcomingResult, pastResult] = await Promise.all([
      pool.query(`${eventSelect} AND event_date >= CURRENT_DATE ORDER BY event_date ASC, start_time ASC, id ASC`, [host.id]),
      pool.query(`${eventSelect} AND event_date < CURRENT_DATE ORDER BY event_date DESC, start_time DESC, id DESC`, [host.id])
    ]);
    const upcomingHtml = upcomingResult.rows.length
      ? upcomingResult.rows.map(event => renderHostEventCard(event)).join('')
      : '<p class="host-empty">No upcoming events yet.</p>';
    const pastHtml = pastResult.rows.length
      ? pastResult.rows.map(event => renderHostEventCard(event, { past: true })).join('')
      : '<p class="host-empty">No past events yet.</p>';

    const logoUrl = cleanProfileUrl(host.logo_url, 'logo').value;
    const headerUrl = cleanProfileUrl(host.header_image_url, 'header image').value;
    const avatarHtml = logoUrl
      ? `<div class="host-avatar"><img src="${esc(logoUrl)}" alt="${esc(host.org_name)} logo"></div>`
      : `<div class="host-avatar" aria-label="${esc(host.org_name)} initials"><span class="host-initials" aria-hidden="true">${esc(hostInitials(host.org_name))}</span></div>`;
    const headerHtml = headerUrl ? `<img class="host-hero-image" src="${esc(headerUrl)}" alt="">` : '';
    const bioHtml = host.bio ? `<p class="host-bio">${esc(host.bio)}</p>` : '';
    const description = String(host.bio || `Public events presented by ${host.org_name}.`).replace(/\s+/g, ' ').trim().slice(0, 160);
    const appUrl = String(process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const session = parseSession(readSessionCookie(req));
    const isOwnHost = Number(session?.id) === Number(host.id);
    const ownerNavHtml = isOwnHost
      ? '<a class="host-owner-dashboard" href="/dashboard" aria-label="Return to Dashboard">← Dashboard</a>'
      : '';
    const following = !isOwnHost && session
      ? await isFollowingHost(pool, session.id, host.id)
      : false;
    const followHtml = isOwnHost ? '' : `<div class="host-follow" data-host-follow data-host-slug="${esc(host.public_slug)}" data-host-name="${esc(host.org_name)}" data-following="${following ? 'true' : 'false'}">
      <button class="host-follow-button${following ? ' following' : ''}" type="button" data-follow-button aria-pressed="${following ? 'true' : 'false'}">${following ? 'Following <span aria-hidden="true">✓</span>' : 'Follow'}</button>
      <p>Don't miss the next show. Save this host to Following.</p>
    </div>`;

    res.send(hostTemplate
      .replace(/{{HOST_NAME}}/g, esc(host.org_name))
      .replace(/{{META_DESCRIPTION}}/g, esc(description))
      .replace(/{{HOST_HEADER}}/g, headerHtml)
      .replace(/{{HOST_AVATAR}}/g, avatarHtml)
      .replace(/{{HOST_BIO}}/g, bioHtml)
      .replace(/{{HOST_LINKS}}/g, hostSocialLinks(host))
      .replace(/{{HOST_FOLLOW}}/g, followHtml)
      .replace(/{{OWNER_NAV}}/g, ownerNavHtml)
      .replace(/{{UPCOMING_EVENT_CARDS}}/g, upcomingHtml)
      .replace(/{{PAST_EVENT_CARDS}}/g, pastHtml)
      .replace(/{{OG_URL}}/g, esc(`${appUrl}/h/${host.public_slug}`))
      .replace(/{{OG_IMAGE}}/g, esc(headerUrl || logoUrl || `${appUrl}/logo.png`)));
  } catch (err) { next(err); }
});

module.exports = router;
