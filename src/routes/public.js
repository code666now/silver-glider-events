const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const pool = require('../config/db');
const { buildIcs } = require('../lib/calendar');
const { sendRsvpConfirmation } = require('../lib/mailer');
const { formatTime } = require('../lib/mailer');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const publicTemplate = fs.readFileSync(path.join(__dirname, '..', 'views', 'event-public.html'), 'utf8');
const rsvpManageTemplate = fs.readFileSync(path.join(__dirname, '..', 'views', 'rsvp-manage.html'), 'utf8');

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

async function loadEventBySlug(slug) {
  const { rows } = await pool.query(
    `SELECT e.*,
            COALESCE((SELECT COUNT(*) FROM rsvps WHERE event_id=e.id AND status='confirmed'), 0)::int AS rsvp_count,
            o.org_name, o.name AS organizer_name
       FROM events e JOIN organizers o ON o.id = e.organizer_id
      WHERE e.slug=$1 AND e.status <> 'draft'`,
    [slug]
  );
  return rows[0] || null;
}

// GET /e/:slug — server-rendered so OG tags work for link previews
router.get('/e/:slug', async (req, res, next) => {
  try {
    const event = await loadEventBySlug(req.params.slug);
    if (!event) return res.status(404).send(render404());

    const isFull = event.capacity != null && event.rsvp_count >= event.capacity;
    const organizerLabel = event.org_name || event.organizer_name || 'Silver Glider Events';

    const THEMES = ['midnight', 'aurora', 'sunset', 'ocean', 'violet', 'ember'];
    const theme = THEMES.includes(event.background_theme) ? event.background_theme : 'midnight';
    const heroHtml = event.cover_image_url
      ? `<div class="hero" id="hero"><img src="${esc(event.cover_image_url)}" alt="" onerror="this.parentElement.classList.add('no-image','bg-theme','bg-${theme}');this.remove()"></div>`
      : `<div class="hero no-image bg-theme bg-${theme}" id="hero"></div>`;

    const eventJson = {
      slug: event.slug,
      title: event.title,
      status: event.status,
      isFull,
      capacity: event.capacity,
      organizerLabel
    };

    const html = publicTemplate
      .replace(/{{TITLE}}/g, esc(event.title))
      .replace(/{{OG_DESCRIPTION}}/g, esc(`${fmtDate(event.event_date)} · ${event.venue_name}`))
      .replace(/{{OG_IMAGE}}/g, esc(event.cover_image_url || `${process.env.APP_URL}/logo.png`))
      .replace(/{{OG_URL}}/g, esc(`${process.env.APP_URL}/e/${event.slug}`))
      .replace(/{{BODY_CLASS}}/g, `bg-${theme}`)
      .replace(/{{HERO}}/g, heroHtml)
      .replace(/{{DATE_STR}}/g, esc(fmtDate(event.event_date)))
      .replace(/{{TIME_STR}}/g, esc(formatTime(event.start_time) + (event.end_time ? ` – ${formatTime(event.end_time)}` : '')))
      .replace(/{{VENUE_NAME}}/g, esc(event.venue_name))
      .replace(/{{VENUE_ADDRESS}}/g, esc(event.venue_address || ''))
      .replace(/{{MAPS_URL}}/g, esc(`https://maps.google.com/?q=${encodeURIComponent([event.venue_name, event.venue_address].filter(Boolean).join(', '))}`))
      .replace(/{{DESCRIPTION_HTML}}/g, esc(event.description || '').replace(/\n/g, '<br>'))
      .replace(/{{ORGANIZER}}/g, esc(organizerLabel))
      .replace(/{{CATEGORY}}/g, esc(event.category || ''))
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
    const firstName = String(req.body.first_name || '').trim().slice(0, 80);
    const lastName = String(req.body.last_name || '').trim().slice(0, 80);
    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = String(req.body.phone || '').trim().slice(0, 30) || null;
    const wantsReminders = req.body.wants_reminders !== false;
    const organizerOptin = req.body.organizer_optin === true;

    if (!firstName || !lastName) return res.status(400).json({ error: 'Enter your first and last name' });
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
      color: { dark: '#0E0E0E', light: '#FFFFFF' }
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
