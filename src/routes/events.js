const express = require('express');
const crypto = require('crypto');
const pool = require('../config/db');
const requireOrganizer = require('../middleware/requireOrganizer');
const { makePublicSlug, makePrivateSlug } = require('../lib/slug');
const { cleanHostName, cleanInstagramHandle, ensureHostProfile, normalizeHostProfile } = require('../lib/host-profile');
const { rsvpsToCsv } = require('../lib/csv');
const { sendEventAnnouncement } = require('../lib/mailer');
const { signOptout } = require('../lib/followers');
const { attendeeAvatar, canAppearInPublicListings, normalizeGuestExperienceSettings, safeAvatarUrl } = require('../lib/private-events');
const { hashCode, normalizeCode, validateCode } = require('../lib/secret-show');
const { isManagedFlyerUrl } = require('../lib/cloudinary');
const { ADMISSION_TYPES, normalizeAdmissionType } = require('../lib/admission');
const { normalizeHex } = require('../../public/js/artwork-color');
const LocationUtils = require('../../public/js/location-utils');
const { queueEventNotificationBatch } = require('../jobs/event-notifications');
const { queuePreviousGuestInvitationBatch } = require('../jobs/previous-guest-invitations');
const { SMS_CONSENT_VERSION } = require('../lib/sms-consent');

const router = express.Router();
// Scope auth to organizer API paths only — this router is mounted at app root,
// so a bare router.use() would gate the public event pages too.
router.use('/api/events', requireOrganizer);
router.use('/api/settings', requireOrganizer);
router.use('/api/places', requireOrganizer);

const CATEGORIES = ['Music', 'Art', 'Market', 'Party', 'Community', 'Food & Drink', 'Film', 'Other'];
const THEMES = ['midnight', 'aurora', 'sunset', 'ocean', 'adaptive', 'static', 'paper', 'halloween', 'liquid-stardust', 'color-static', 'last-guest', 'disco', 'fog', 'saloon'];
const PRESENTATION_MODES = ['standard', 'flyer'];
const COVER_FIT_MODES = ['auto', 'contain', 'cover'];

function isTrue(value) {
  return value === true || value === 'true';
}

function canonicalDate(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  return String(value).slice(0, 10);
}

function canonicalTime(value) {
  return String(value || '').slice(0, 5);
}

function displayDate(value) {
  const date = new Date(`${canonicalDate(value)}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? canonicalDate(value)
    : date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function displayTime(value) {
  const [hours, minutes] = canonicalTime(value).split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return canonicalTime(value);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

function displayLocation(venueName, venueAddress) {
  const parts = LocationUtils.displayParts(venueName, venueAddress);
  return [parts.name, parts.address].filter(Boolean).join(' — ') || 'Location not specified';
}

function importantEventChanges(current, updates) {
  const next = { ...current, ...updates };
  const changes = [];
  if (updates.event_date !== undefined && canonicalDate(current.event_date) !== canonicalDate(next.event_date)) {
    changes.push({ field: 'date', label: 'Date', before: displayDate(current.event_date), after: displayDate(next.event_date) });
  }
  if (updates.start_time !== undefined && canonicalTime(current.start_time) !== canonicalTime(next.start_time)) {
    changes.push({ field: 'time', label: 'Start time', before: displayTime(current.start_time), after: displayTime(next.start_time) });
  }
  const locationTouched = updates.venue_name !== undefined || updates.venue_address !== undefined;
  const beforeLocation = displayLocation(current.venue_name, current.venue_address);
  const afterLocation = displayLocation(next.venue_name, next.venue_address);
  if (locationTouched && beforeLocation !== afterLocation) {
    changes.push({ field: 'location', label: 'Location', before: beforeLocation, after: afterLocation });
  }
  return changes;
}

async function createEventNotificationBatch(client, { eventId, kind, changes = [] }) {
  const { rows: recipients } = await client.query(
    `SELECT id, email FROM rsvps WHERE event_id=$1 AND status='confirmed' ORDER BY id`,
    [eventId]
  );
  if (!recipients.length) return null;
  const { rows: batches } = await client.query(
    `INSERT INTO event_notification_batches (event_id, kind, changes, recipient_count)
     VALUES ($1,$2,$3::jsonb,$4) RETURNING id`,
    [eventId, kind, JSON.stringify(changes), recipients.length]
  );
  const batchId = batches[0].id;
  for (const recipient of recipients) {
    await client.query(
      `INSERT INTO message_log
         (rsvp_id, event_id, notification_batch_id, recipient, message_type, channel, status)
       VALUES ($1,$2,$3,$4,$5,'email','pending')
       ON CONFLICT (notification_batch_id, rsvp_id, channel)
         WHERE notification_batch_id IS NOT NULL AND rsvp_id IS NOT NULL DO NOTHING`,
      [recipient.id, eventId, batchId, recipient.email, kind]
    );
  }
  return { batchId, queued: recipients.length, status: 'pending' };
}

function validateSecretCodePair(body) {
  const validated = validateCode(body.secret_code);
  if (validated.error) return validated;
  if (normalizeCode(body.secret_code_confirm) !== validated.code) {
    return { error: 'Access codes do not match' };
  }
  return validated;
}

function cleanTicketUrl(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString().slice(0, 500) : null;
  } catch (_) {
    return null;
  }
}

function cleanCommerceEventId(v) {
  const value = String(v ?? '').trim();
  if (!value) return null;
  if (value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function cleanVibeUrl(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const isHost = domain => host === domain || host.endsWith(`.${domain}`);
    const supported =
      host === 'youtu.be' ||
      isHost('youtube.com') ||
      isHost('youtube-nocookie.com') ||
      isHost('soundcloud.com') ||
      isHost('spotify.com') ||
      isHost('bandcamp.com');
    return supported ? url.toString().slice(0, 700) : null;
  } catch (_) {
    return null;
  }
}

function cleanVibeLabel(v) {
  const value = String(v ?? '').trim().replace(/\s+/g, ' ');
  return value ? value.slice(0, 80) : null;
}

function cleanFlyerUrl(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return null;
  return isManagedFlyerUrl(raw) ? raw.slice(0, 1000) : null;
}

function cleanFlyerDesignerName(v) {
  const value = String(v ?? '').trim().replace(/\s+/g, ' ');
  return value ? value.slice(0, 120) : null;
}

function cleanFloat(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function placesApiKey() {
  return (process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_BROWSER_KEY || '').trim();
}

function validateEventBody(body, { partial = false } = {}) {
  const errors = [];
  const out = {};
  const fields = {
    title:           v => String(v).trim().slice(0, 140),
    description:     v => String(v ?? '').trim(),
    event_vibe_url:  cleanVibeUrl,
    event_vibe_label: cleanVibeLabel,
    event_vibe_url_2: cleanVibeUrl,
    event_vibe_label_2: cleanVibeLabel,
    cover_image_url: v => String(v ?? '').trim() || null,
    cover_fit_mode: v => (COVER_FIT_MODES.includes(v) ? v : 'auto'),
    presentation_mode: v => (PRESENTATION_MODES.includes(v) ? v : 'standard'),
    flyer_image_url: cleanFlyerUrl,
    flyer_designer_name: cleanFlyerDesignerName,
    artwork_accent_color: normalizeHex,
    cover_credit_name: v => (v ? String(v).trim().slice(0, 120) : null),
    cover_credit_link: v => (v ? String(v).trim().slice(0, 300) : null),
    event_date:      v => String(v).trim(),
    start_time:      v => String(v).trim(),
    end_time:        v => (v ? String(v).trim() : null),
    venue_name:      v => String(v).trim().slice(0, 140),
    venue_address:   v => String(v ?? '').trim() || null,
    venue_city:      v => String(v ?? '').trim().slice(0, 120) || null,
    venue_state:     v => String(v ?? '').trim().slice(0, 80) || null,
    venue_latitude:  cleanFloat,
    venue_longitude: cleanFloat,
    google_place_id: v => String(v ?? '').trim().slice(0, 180) || null,
    category:        v => (CATEGORIES.includes(v) ? v : null),
    capacity:        v => (v === '' || v == null ? null : Math.max(1, parseInt(v, 10) || 0) || null),
    visibility:      v => (v === 'private' ? 'private' : 'public'),
    background_theme: v => (THEMES.includes(v) ? v : 'midnight'),
    admission_type:  normalizeAdmissionType,
    ticket_price:    v => (v === '' || v == null ? null : Math.round((Number(v) || 0) * 100) / 100),
    ticket_url:      cleanTicketUrl,
    commerce_event_id: cleanCommerceEventId,
    sms_reminder_enabled: isTrue,
    status:          v => (['draft', 'published', 'cancelled'].includes(v) ? v : undefined)
  };
  for (const [key, clean] of Object.entries(fields)) {
    if (body[key] === undefined) continue;
    out[key] = clean(body[key]);
  }
  if (body.flyer_designer_instagram_handle !== undefined) {
    const instagram = cleanInstagramHandle(body.flyer_designer_instagram_handle);
    if (instagram.error) errors.push(instagram.error);
    else out.flyer_designer_instagram_handle = instagram.value;
  }
  if (body.event_vibe_url && !out.event_vibe_url) errors.push('Enter a supported Event Vibe link');
  if (body.event_vibe_url_2 && !out.event_vibe_url_2) errors.push('Enter a supported second Event Vibe link');
  const requestedSecondVibe = Boolean(String(body.event_vibe_url_2 ?? '').trim() || String(body.event_vibe_label_2 ?? '').trim());
  if (requestedSecondVibe && !out.event_vibe_url) errors.push('Add the first artist link');
  if (body.event_vibe_url !== undefined && !out.event_vibe_url) {
    out.event_vibe_label = null;
    out.event_vibe_url_2 = null;
    out.event_vibe_label_2 = null;
  } else if (body.event_vibe_url_2 !== undefined || body.event_vibe_label_2 !== undefined) {
    if (out.event_vibe_url_2 && !out.event_vibe_label) errors.push('Add the first artist name');
    if (out.event_vibe_url_2 && !out.event_vibe_label_2) errors.push('Add the second artist name');
    if (out.event_vibe_label_2 && !out.event_vibe_url_2) errors.push('Add the second artist link');
  }
  if (!partial) {
    out.presentation_mode = out.presentation_mode || 'standard';
    out.cover_fit_mode = out.cover_fit_mode || 'auto';
    if (!out.title) errors.push('Title is required');
    if (!out.event_date || !/^\d{4}-\d{2}-\d{2}$/.test(out.event_date)) errors.push('Date is required');
    if (!out.start_time || !/^\d{2}:\d{2}/.test(out.start_time)) errors.push('Start time is required');
    if (!out.venue_name) errors.push('Venue name is required');
  } else {
    if (out.event_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(out.event_date || '')) errors.push('Invalid date');
    if (out.start_time !== undefined && !/^\d{2}:\d{2}/.test(out.start_time || '')) errors.push('Invalid start time');
  }
  if (body.flyer_image_url && !out.flyer_image_url) errors.push('Upload the flyer through Silver Glider Events');
  if (!partial && out.presentation_mode === 'flyer' && !out.flyer_image_url) errors.push('A flyer image is required for Flyer presentation');
  if (body.admission_type !== undefined && !out.admission_type) errors.push('Choose a valid admission type');
  if (body.commerce_event_id && !out.commerce_event_id) errors.push('Enter a valid Commerce event reference');
  const externalTickets = out.admission_type === ADMISSION_TYPES.EXTERNAL_TICKETS ||
    (partial && body.admission_type === undefined && (out.ticket_price != null || out.ticket_url));
  const silverGliderTickets = out.admission_type === ADMISSION_TYPES.SILVER_GLIDER_TICKETS ||
    (partial && body.admission_type === undefined && out.commerce_event_id);
  if (out.admission_type === ADMISSION_TYPES.FREE_RSVP) {
    out.ticket_price = null;
    out.ticket_url = null;
    out.commerce_event_id = null;
  }
  if (externalTickets) {
    out.commerce_event_id = null;
    if (out.ticket_price == null || out.ticket_price <= 0) errors.push('Enter a ticket price');
    if (body.ticket_url && !out.ticket_url) errors.push('Enter a valid ticket link');
  }
  if (silverGliderTickets) {
    out.ticket_price = null;
    out.ticket_url = null;
    if (!out.commerce_event_id && !partial) errors.push('Connect this event to Silver Glider Commerce before publishing');
  }
  if (out.status !== undefined && out.status === undefined) delete out.status;
  return { out, errors };
}

// GET /api/places/config — browser key for Google Places Autocomplete.
// This must be a Google browser key restricted by HTTP referrer in Google Cloud.
router.get('/api/places/config', (req, res) => {
  const apiKey = placesApiKey();
  res.json(apiKey ? { enabled: true, apiKey } : { enabled: false });
});

// GET /api/events — mine, with confirmed RSVP counts.
// Excludes archived by default; ?archived=1 returns only archived.
router.get('/api/events', async (req, res, next) => {
  try {
    const archivedOnly = req.query.archived === '1';
    const { rows } = await pool.query(
      `SELECT e.*,
              COALESCE(r.cnt, 0)::int AS rsvp_count,
              COALESCE(r.guest_count, 0)::int AS guest_count,
              (COALESCE(r.cnt, 0) + COALESCE(r.guest_count, 0))::int AS total_attendance,
              COALESCE(c.comment_count, 0)::int AS comment_count
         FROM events e
         LEFT JOIN (
           SELECT event_id, COUNT(*) AS cnt, COUNT(guest_first_name) AS guest_count
             FROM rsvps WHERE status='confirmed' GROUP BY event_id
         ) r ON r.event_id = e.id
         LEFT JOIN (
           SELECT event_id, COUNT(*) AS comment_count FROM event_comments GROUP BY event_id
         ) c ON c.event_id = e.id
        WHERE e.organizer_id=$1
          AND e.archived_at IS ${archivedOnly ? 'NOT NULL' : 'NULL'}
        ORDER BY e.event_date DESC, e.id DESC`,
      [req.organizer.id]
    );
    res.json({ events: rows });
  } catch (err) { next(err); }
});

// POST /api/events/:id/archive — hide from the list; keeps all guest data
router.post('/api/events/:id/archive', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      'UPDATE events SET archived_at=NOW() WHERE id=$1 AND organizer_id=$2 AND archived_at IS NULL',
      [req.params.id, req.organizer.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Event not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/events/:id/unarchive — restore to the list
router.post('/api/events/:id/unarchive', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      'UPDATE events SET archived_at=NULL WHERE id=$1 AND organizer_id=$2 AND archived_at IS NOT NULL',
      [req.params.id, req.organizer.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Event not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/events — create
router.post('/api/events', async (req, res, next) => {
  try {
    const { out, errors } = validateEventBody(req.body);
    if (errors.length) return res.status(400).json({ error: errors[0] });
    Object.assign(out, normalizeGuestExperienceSettings(req.body));
    const secretShowEnabled = isTrue(req.body.secret_show_enabled);
    if (secretShowEnabled && out.visibility !== 'private') {
      return res.status(400).json({ error: 'Secret Show requires Private — Link Only' });
    }
    if (secretShowEnabled && out.sms_reminder_enabled) {
      return res.status(400).json({ error: 'Day-before text reminders are not available for Secret Shows yet' });
    }
    let secretCodeHash = null;
    if (secretShowEnabled) {
      const validated = validateSecretCodePair(req.body);
      if (validated.error) return res.status(400).json({ error: validated.error });
      secretCodeHash = await hashCode(validated.code);
    }

    const presenterName = cleanHostName(req.body.presenter_name);
    if (!req.organizer.public_slug && presenterName) {
      await ensureHostProfile(req.organizer.id, presenterName);
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const slug = out.visibility === 'private' ? makePrivateSlug() : makePublicSlug(out.title);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `INSERT INTO events (organizer_id, slug, title, description, cover_image_url, cover_fit_mode, presentation_mode, flyer_image_url,
                               flyer_designer_name, flyer_designer_instagram_handle, event_date,
                               start_time, end_time, venue_name, venue_address, category, capacity, visibility, background_theme,
                               cover_credit_name, cover_credit_link, admission_type, ticket_price, ticket_url,
                               venue_city, venue_state, venue_latitude, venue_longitude, google_place_id, event_vibe_url,
                               event_vibe_label, event_vibe_url_2, event_vibe_label_2,
                               show_guest_list, allow_guests, comments_enabled, secret_show_enabled, secret_show_version,
                               artwork_accent_color, commerce_event_id, sms_reminder_enabled)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41)
           RETURNING *`,
          [req.organizer.id, slug, out.title, out.description || null, out.cover_image_url,
           out.cover_fit_mode, out.presentation_mode, out.flyer_image_url,
           out.flyer_designer_name || null, out.flyer_designer_instagram_handle || null,
           out.event_date, out.start_time, out.end_time, out.venue_name, out.venue_address,
           out.category, out.capacity, out.visibility || 'public', out.background_theme || 'midnight',
           out.cover_credit_name || null, out.cover_credit_link || null,
           out.admission_type || 'free_rsvp', out.ticket_price ?? null, out.ticket_url || null,
           out.venue_city || null, out.venue_state || null, out.venue_latitude, out.venue_longitude,
           out.google_place_id || null, out.event_vibe_url || null,
           out.event_vibe_label || null, out.event_vibe_url_2 || null, out.event_vibe_label_2 || null,
           out.show_guest_list, out.allow_guests, out.comments_enabled,
           secretShowEnabled, secretShowEnabled ? 1 : 0, out.artwork_accent_color || null,
           out.commerce_event_id || null, out.sms_reminder_enabled === true]
        );
        if (secretShowEnabled) {
          await client.query(
            `INSERT INTO event_secret_codes (event_id, code_hash) VALUES ($1,$2)`,
            [rows[0].id, secretCodeHash]
          );
        }
        await client.query('COMMIT');
        return res.status(201).json({ event: rows[0] });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err.code === '23505' && attempt < 2) continue; // slug collision — retry
        throw err;
      } finally {
        client.release();
      }
    }
  } catch (err) { next(err); }
});

// GET /api/events/:id
router.get('/api/events/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.*,
              e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE e.timezone)::date AS is_past,
              COALESCE((SELECT COUNT(*) FROM rsvps WHERE event_id=e.id AND status='confirmed'), 0)::int AS rsvp_count,
              COALESCE((SELECT COUNT(guest_first_name) FROM rsvps WHERE event_id=e.id AND status='confirmed'), 0)::int AS guest_count,
              COALESCE((SELECT COUNT(*) + COUNT(guest_first_name) FROM rsvps WHERE event_id=e.id AND status='confirmed'), 0)::int AS total_attendance,
              COALESCE((SELECT COUNT(*) FROM rsvps
                         WHERE event_id=e.id AND status='confirmed' AND sms_optin=TRUE
                           AND sms_consent_at IS NOT NULL AND sms_opted_out_at IS NULL
                           AND sms_consent_version='${SMS_CONSENT_VERSION}'
                           AND phone ~ '^\\+[1-9][0-9]{7,14}$'), 0)::int AS sms_eligible_count,
              COALESCE((SELECT COUNT(*) FROM event_comments WHERE event_id=e.id), 0)::int AS comment_count
              ,(SELECT json_build_object(
                  'id', b.id, 'kind', b.kind, 'status', b.status,
                  'recipientCount', b.recipient_count, 'sentCount', b.sent_count,
                  'failedCount', b.failed_count, 'createdAt', b.created_at
                )
                  FROM event_notification_batches b
                 WHERE b.event_id=e.id
                 ORDER BY b.id DESC LIMIT 1) AS latest_notification
         FROM events e WHERE e.id=$1 AND e.organizer_id=$2`,
      [req.params.id, req.organizer.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Event not found' });
    res.json({ event: rows[0] });
  } catch (err) { next(err); }
});

// PUT /api/events/:id — update (slug immutable)
router.put('/api/events/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { out, errors } = validateEventBody(req.body, { partial: true });
    if (errors.length) return res.status(400).json({ error: errors[0] });
    delete out.status; // status changes go through /cancel

    await client.query('BEGIN');
    const { rows: currentRows } = await client.query(
      `SELECT visibility, show_guest_list, allow_guests, comments_enabled,
              secret_show_enabled, secret_show_version, presentation_mode, flyer_image_url,
              admission_type, ticket_price, ticket_url, commerce_event_id, status,
              event_date, start_time, venue_name, venue_address, sms_reminder_enabled
         FROM events WHERE id=$1 AND organizer_id=$2 FOR UPDATE`,
      [req.params.id, req.organizer.id]
    );
    if (!currentRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found' });
    }
    const current = currentRows[0];
    const importantChanges = importantEventChanges(current, out);
    const notifyAttendees = isTrue(req.body.notify_attendees) && current.status === 'published' && importantChanges.length > 0;
    const effectiveAdmission = out.admission_type || normalizeAdmissionType(current.admission_type) || ADMISSION_TYPES.FREE_RSVP;
    const effectiveCommerceEventId = out.commerce_event_id !== undefined
      ? out.commerce_event_id
      : current.commerce_event_id;
    if (effectiveAdmission === ADMISSION_TYPES.SILVER_GLIDER_TICKETS && !effectiveCommerceEventId && current.status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Connect this event to Silver Glider Commerce before publishing' });
    }
    if (effectiveAdmission !== ADMISSION_TYPES.SILVER_GLIDER_TICKETS && out.commerce_event_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Choose Sell with Silver Glider before adding a Commerce event reference' });
    }
    const effectivePresentationMode = out.presentation_mode ?? current.presentation_mode ?? 'standard';
    const effectiveFlyerImage = out.flyer_image_url !== undefined ? out.flyer_image_url : current.flyer_image_url;
    if (effectivePresentationMode === 'flyer' && !effectiveFlyerImage) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A flyer image is required for Flyer presentation' });
    }
    const effectiveVisibility = out.visibility || current.visibility;
    Object.assign(out, normalizeGuestExperienceSettings({
      show_guest_list: req.body.show_guest_list ?? current.show_guest_list,
      allow_guests: req.body.allow_guests ?? current.allow_guests,
      comments_enabled: req.body.comments_enabled ?? current.comments_enabled
    }));

    const secretShowEnabled = req.body.secret_show_enabled === undefined
      ? current.secret_show_enabled
      : isTrue(req.body.secret_show_enabled);
    if (secretShowEnabled && effectiveVisibility !== 'private') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Disable Secret Show before making this event public' });
    }
    const effectiveSmsReminderEnabled = out.sms_reminder_enabled === undefined
      ? current.sms_reminder_enabled
      : out.sms_reminder_enabled;
    if (secretShowEnabled && effectiveSmsReminderEnabled) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Disable day-before text reminders before enabling Secret Show' });
    }

    const codeWasEntered = Boolean(String(req.body.secret_code || '').trim() || String(req.body.secret_code_confirm || '').trim());
    let replacementHash = null;
    if (secretShowEnabled && (codeWasEntered || !current.secret_show_enabled)) {
      const validated = validateSecretCodePair(req.body);
      if (validated.error) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: validated.error });
      }
      replacementHash = await hashCode(validated.code);
    }

    const secretStateChanged = secretShowEnabled !== current.secret_show_enabled;
    const secretVersion = Number(current.secret_show_version) + ((secretStateChanged || replacementHash) ? 1 : 0);
    out.secret_show_enabled = secretShowEnabled;
    out.secret_show_version = secretVersion;

    const keys = Object.keys(out);
    if (!keys.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const sets = keys.map((k, i) => `${k}=$${i + 3}`).join(', ');
    const calendarSequenceUpdate = importantChanges.length ? ', calendar_sequence=calendar_sequence+1' : '';
    const { rows } = await client.query(
      `UPDATE events SET ${sets}${calendarSequenceUpdate}, updated_at=NOW() WHERE id=$1 AND organizer_id=$2 RETURNING *`,
      [req.params.id, req.organizer.id, ...keys.map(k => out[k])]
    );
    if (secretShowEnabled && replacementHash) {
      await client.query(
        `INSERT INTO event_secret_codes (event_id, code_hash)
         VALUES ($1,$2)
         ON CONFLICT (event_id) DO UPDATE SET code_hash=EXCLUDED.code_hash, updated_at=NOW()`,
        [req.params.id, replacementHash]
      );
    } else if (!secretShowEnabled) {
      await client.query('DELETE FROM event_secret_codes WHERE event_id=$1', [req.params.id]);
    }
    const notification = notifyAttendees
      ? await createEventNotificationBatch(client, {
        eventId: rows[0].id,
        kind: 'event_updated',
        changes: importantChanges
      })
      : null;
    await client.query('COMMIT');
    if (notification) queueEventNotificationBatch(notification.batchId);
    res.json({ event: rows[0], importantChanges, notification });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/events/:id/duplicate
// PRO GATE: when billing exists, require req.organizer.plan === 'pro' here.
router.post('/api/events/:id/duplicate', async (req, res, next) => {
  try {
    const { rows: src } = await pool.query(
      'SELECT * FROM events WHERE id=$1 AND organizer_id=$2', [req.params.id, req.organizer.id]
    );
    if (!src.length) return res.status(404).json({ error: 'Event not found' });
    const e = src[0];

    for (let attempt = 0; attempt < 3; attempt++) {
      const slug = e.visibility === 'private' ? makePrivateSlug() : makePublicSlug(e.title);
      try {
        const { rows } = await pool.query(
          `INSERT INTO events (organizer_id, slug, title, description, cover_image_url, cover_fit_mode, presentation_mode, flyer_image_url,
                               flyer_designer_name, flyer_designer_instagram_handle, event_date,
                               start_time, end_time, timezone, venue_name, venue_address, category,
                               capacity, visibility, admission_type, ticket_price, ticket_url, status, duplicated_from_id,
                               background_theme, cover_credit_name, cover_credit_link,
                               venue_city, venue_state, venue_latitude, venue_longitude, google_place_id, event_vibe_url,
                               event_vibe_label, event_vibe_url_2, event_vibe_label_2,
                               show_guest_list, allow_guests, comments_enabled, artwork_accent_color, commerce_event_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'draft',$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,NULL)
           RETURNING *`,
          [req.organizer.id, slug, e.title, e.description, e.cover_image_url,
           e.cover_fit_mode || 'auto', e.presentation_mode || 'standard', e.flyer_image_url || null,
           e.flyer_designer_name || null, e.flyer_designer_instagram_handle || null, e.event_date,
           e.start_time, e.end_time, e.timezone, e.venue_name, e.venue_address, e.category,
           e.capacity, e.visibility, e.admission_type, e.ticket_price, e.ticket_url, e.id,
           e.background_theme || 'midnight', e.cover_credit_name || null, e.cover_credit_link || null,
           e.venue_city || null, e.venue_state || null, e.venue_latitude, e.venue_longitude,
           e.google_place_id || null, e.event_vibe_url || null,
           e.event_vibe_label || null, e.event_vibe_url_2 || null, e.event_vibe_label_2 || null,
           e.show_guest_list === true, e.allow_guests === true, e.comments_enabled === true,
           e.artwork_accent_color || null]
        );
        return res.status(201).json({ event: rows[0] });
      } catch (err) {
        if (err.code === '23505' && attempt < 2) continue;
        throw err;
      }
    }
  } catch (err) { next(err); }
});

// POST /api/events/:id/cancel
router.post('/api/events/:id/cancel', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: currentRows } = await client.query(
      `SELECT * FROM events WHERE id=$1 AND organizer_id=$2 FOR UPDATE`,
      [req.params.id, req.organizer.id]
    );
    if (!currentRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found' });
    }
    if (currentRows[0].status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Event is already cancelled' });
    }
    const { rows } = await client.query(
      `UPDATE events SET status='cancelled', calendar_sequence=calendar_sequence+1, updated_at=NOW()
        WHERE id=$1 AND organizer_id=$2 RETURNING *`,
      [req.params.id, req.organizer.id]
    );
    const notification = isTrue(req.body.notify_attendees) && currentRows[0].status === 'published'
      ? await createEventNotificationBatch(client, {
        eventId: rows[0].id,
        kind: 'event_cancelled'
      })
      : null;
    await client.query('COMMIT');
    if (notification) queueEventNotificationBatch(notification.batchId);
    res.json({ event: rows[0], notification });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /api/events/:id — permanently remove an event (cascades to its RSVPs + logs)
router.delete('/api/events/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM events WHERE id=$1 AND organizer_id=$2', [req.params.id, req.organizer.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Event not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/events/:id/rsvps?search=
router.get('/api/events/:id/rsvps', async (req, res, next) => {
  try {
    const owned = await pool.query('SELECT 1 FROM events WHERE id=$1 AND organizer_id=$2', [req.params.id, req.organizer.id]);
    if (!owned.rows.length) return res.status(404).json({ error: 'Event not found' });

    const search = String(req.query.search || '').trim();
    const params = [req.params.id];
    let where = `event_id=$1`;
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (first_name ILIKE $2 OR last_name ILIKE $2 OR email ILIKE $2
                    OR guest_first_name ILIKE $2 OR guest_last_name ILIKE $2 OR guest_email ILIKE $2)`;
    }
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, email, phone, guest_first_name, guest_last_name, guest_email,
              wants_reminders, organizer_optin, status, created_at
         FROM rsvps WHERE ${where} ORDER BY created_at DESC`,
      params
    );
    res.json({ rsvps: rows });
  } catch (err) { next(err); }
});

function familiarFaceKey(type, id) {
  return `${type}:${Number(id)}`;
}

function parseFamiliarFaceIds(values) {
  const parsed = { rsvpIds: [], invitationIds: [] };
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const match = String(value || '').match(/^(rsvp|invite):(\d+)$/);
    if (!match || seen.has(match[0])) continue;
    seen.add(match[0]);
    const id = Number.parseInt(match[2], 10);
    if (!Number.isInteger(id) || id < 1) continue;
    if (match[1] === 'rsvp') parsed.rsvpIds.push(id);
    else parsed.invitationIds.push(id);
  }
  return parsed;
}

async function selectedFamiliarFaceRecipients(queryable, { organizerId, sourceEventId, faceIds }) {
  const { rsvpIds, invitationIds } = parseFamiliarFaceIds(faceIds);
  const recipients = [];
  if (rsvpIds.length) {
    const { rows } = await queryable.query(
      `SELECT r.id, r.first_name, r.last_name, LOWER(r.email) AS email
        FROM rsvps r
        JOIN events source ON source.id=r.event_id
        WHERE source.id=$1 AND source.organizer_id=$2
          AND r.id=ANY($3::int[]) AND r.status='confirmed'
          AND NULLIF(TRIM(r.email),'') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM follower_optouts fo
             WHERE fo.organizer_id=$2 AND LOWER(fo.email)=LOWER(r.email)
          )`,
      [sourceEventId, organizerId, rsvpIds]
    );
    for (const row of rows) recipients.push({
      email: row.email,
      name: `${row.first_name || ''} ${row.last_name || ''}`.trim() || null
    });
  }
  if (invitationIds.length) {
    const { rows } = await queryable.query(
      `SELECT ml.id, LOWER(ml.recipient) AS email, ml.recipient_name
         FROM message_log ml
         JOIN events source ON source.id=ml.event_id
        WHERE source.id=$1 AND source.organizer_id=$2
          AND ml.id=ANY($3::int[]) AND ml.message_type='previous_guest_invite'
          AND ml.status IN ('pending','sent') AND NULLIF(TRIM(ml.recipient),'') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM follower_optouts fo
             WHERE fo.organizer_id=$2 AND LOWER(fo.email)=LOWER(ml.recipient)
          )`,
      [sourceEventId, organizerId, invitationIds]
    );
    for (const row of rows) recipients.push({ email: row.email, name: row.recipient_name || null });
  }
  const deduped = new Map();
  for (const recipient of recipients) {
    const email = String(recipient.email || '').trim().toLowerCase();
    if (email && !deduped.has(email)) deduped.set(email, { ...recipient, email });
  }
  return [...deduped.values()];
}

async function targetRecipientState(queryable, { targetEventId, emails }) {
  if (!emails.length) return { rsvpd: new Set(), invited: new Set() };
  const { rows: rsvpRows } = await queryable.query(
    `SELECT DISTINCT LOWER(email) AS email FROM rsvps
      WHERE event_id=$1 AND status='confirmed' AND LOWER(email)=ANY($2::text[])`,
    [targetEventId, emails]
  );
  const { rows: invitedRows } = await queryable.query(
    `SELECT DISTINCT LOWER(recipient) AS email FROM message_log
      WHERE event_id=$1 AND LOWER(recipient)=ANY($2::text[])
        AND message_type IN ('announcement','previous_guest_invite')
        AND status IN ('pending','sent')`,
    [targetEventId, emails]
  );
  return {
    rsvpd: new Set(rsvpRows.map(row => row.email)),
    invited: new Set(invitedRows.map(row => row.email))
  };
}

function eligibleTargetRecipients(recipients, state) {
  return recipients.filter(recipient => !state.rsvpd.has(recipient.email) && !state.invited.has(recipient.email));
}

// GET /api/events/:id/familiar-faces — visual, event-specific people view.
router.get('/api/events/:id/familiar-faces', async (req, res, next) => {
  try {
    const { rows: eventRows } = await pool.query(
      `SELECT id, status,
              event_date < (CURRENT_TIMESTAMP AT TIME ZONE timezone)::date AS is_past
         FROM events WHERE id=$1 AND organizer_id=$2`,
      [req.params.id, req.organizer.id]
    );
    if (!eventRows.length) return res.status(404).json({ error: 'Event not found' });

    const { rows: rsvps } = await pool.query(
      `SELECT r.id, r.first_name, r.last_name, r.email, r.guest_first_name, r.guest_last_name,
              r.created_at, o.avatar_url,
              NOT EXISTS (
                SELECT 1 FROM follower_optouts fo
                 WHERE fo.organizer_id=$2 AND LOWER(fo.email)=LOWER(r.email)
              ) AS host_email_allowed
        FROM rsvps r
         LEFT JOIN organizers o ON o.id=r.account_id
        WHERE r.event_id=$1 AND r.status='confirmed'
        ORDER BY r.created_at DESC, r.id DESC`,
      [req.params.id, req.organizer.id]
    );
    const { rows: invitations } = await pool.query(
      `SELECT DISTINCT ON (LOWER(ml.recipient)) ml.id, ml.recipient, ml.recipient_name,
              ml.created_at, identity.avatar_url,
              NOT EXISTS (
                SELECT 1 FROM follower_optouts fo
                 WHERE fo.organizer_id=$2 AND LOWER(fo.email)=LOWER(ml.recipient)
              ) AS host_email_allowed
         FROM message_log ml
         LEFT JOIN LATERAL (
           SELECT o.avatar_url
             FROM rsvps linked
             JOIN events linked_event ON linked_event.id=linked.event_id AND linked_event.organizer_id=$2
             JOIN organizers o ON o.id=linked.account_id
            WHERE LOWER(linked.email)=LOWER(ml.recipient)
            ORDER BY linked.id DESC LIMIT 1
         ) identity ON TRUE
        WHERE ml.event_id=$1 AND ml.message_type='previous_guest_invite'
          AND ml.status IN ('pending','sent')
          AND NOT EXISTS (
            SELECT 1 FROM rsvps current_rsvp
             WHERE current_rsvp.event_id=$1 AND current_rsvp.status='confirmed'
               AND LOWER(current_rsvp.email)=LOWER(ml.recipient)
          )
        ORDER BY LOWER(ml.recipient), ml.id DESC`,
      [req.params.id, req.organizer.id]
    );

    const faces = [];
    for (const rsvp of rsvps) {
      const name = `${rsvp.first_name || ''} ${rsvp.last_name || ''}`.trim() || 'Guest';
      faces.push({
        id: familiarFaceKey('rsvp', rsvp.id),
        name,
        status: 'RSVP’d',
        avatarUrl: safeAvatarUrl(rsvp.avatar_url),
        avatarEmoji: attendeeAvatar(`email:${String(rsvp.email || '').trim().toLowerCase() || `rsvp:${rsvp.id}`}`),
        canInvite: Boolean(rsvp.host_email_allowed && String(rsvp.email || '').trim()),
        searchText: `${name} ${rsvp.email || ''}`.toLowerCase(),
        sortTime: rsvp.created_at
      });
      const guestName = `${rsvp.guest_first_name || ''} ${rsvp.guest_last_name || ''}`.trim();
      if (guestName) faces.push({
        id: familiarFaceKey('guest', rsvp.id),
        name: guestName,
        status: 'RSVP’d',
        avatarUrl: null,
        avatarEmoji: attendeeAvatar(`guest:${rsvp.id}:${guestName.toLowerCase()}`),
        canInvite: false,
        searchText: guestName.toLowerCase(),
        sortTime: rsvp.created_at
      });
    }
    for (const invitation of invitations) {
      const name = String(invitation.recipient_name || '').trim() || 'Invited guest';
      faces.push({
        id: familiarFaceKey('invite', invitation.id),
        name,
        status: 'Invited',
        avatarUrl: safeAvatarUrl(invitation.avatar_url),
        avatarEmoji: attendeeAvatar(`email:${String(invitation.recipient || '').trim().toLowerCase() || `invite:${invitation.id}`}`),
        canInvite: Boolean(invitation.host_email_allowed && String(invitation.recipient || '').trim()),
        searchText: `${name} ${invitation.recipient || ''}`.toLowerCase(),
        sortTime: invitation.created_at
      });
    }
    const search = String(req.query.search || '').trim().toLowerCase();
    const filtered = search ? faces.filter(face => face.searchText.includes(search)) : faces;
    filtered.sort((a, b) => new Date(b.sortTime) - new Date(a.sortTime));
    res.json({
      faces: filtered.map(({ searchText, sortTime, ...face }) => face),
      totalCount: faces.length,
      rsvpCount: rsvps.length,
      selectableCount: faces.filter(face => face.canInvite).length,
      canStartInvitation: Boolean(eventRows[0].is_past && eventRows[0].status === 'published')
    });
  } catch (err) { next(err); }
});

// POST /api/events/:id/familiar-faces/preview — recheck selected people and
// show only eligible upcoming events owned by this host.
router.post('/api/events/:id/familiar-faces/preview', async (req, res, next) => {
  try {
    const faceIds = Array.isArray(req.body.faceIds) ? req.body.faceIds : [];
    if (!faceIds.length) return res.status(400).json({ error: 'Choose at least one person' });
    if (faceIds.length > 500) return res.status(400).json({ error: 'Choose no more than 500 people at a time' });
    const { rows: sourceRows } = await pool.query(
      `SELECT id, title, status,
              event_date < (CURRENT_TIMESTAMP AT TIME ZONE timezone)::date AS is_past
         FROM events WHERE id=$1 AND organizer_id=$2`,
      [req.params.id, req.organizer.id]
    );
    if (!sourceRows.length) return res.status(404).json({ error: 'Event not found' });
    if (sourceRows[0].status !== 'published' || !sourceRows[0].is_past) {
      return res.status(400).json({ error: 'Choose people from one of your past published events' });
    }
    const recipients = await selectedFamiliarFaceRecipients(pool, {
      organizerId: req.organizer.id,
      sourceEventId: sourceRows[0].id,
      faceIds
    });
    if (!recipients.length) return res.status(400).json({ error: 'None of the selected people can receive an invitation' });

    const { rows: targets } = await pool.query(
      `SELECT id, title, event_date, start_time, timezone, presentation_mode,
              flyer_image_url, cover_image_url
         FROM events
        WHERE organizer_id=$1 AND id<>$2 AND status='published' AND archived_at IS NULL
          AND secret_show_enabled=FALSE
          AND event_date >= (CURRENT_TIMESTAMP AT TIME ZONE timezone)::date
        ORDER BY event_date, start_time, id`,
      [req.organizer.id, sourceRows[0].id]
    );
    const emails = recipients.map(recipient => recipient.email);
    const events = [];
    for (const target of targets) {
      const state = await targetRecipientState(pool, { targetEventId: target.id, emails });
      events.push({
        id: target.id,
        title: target.title,
        eventDate: target.event_date,
        startTime: target.start_time,
        timezone: target.timezone,
        thumbnailUrl: target.presentation_mode === 'flyer' ? target.flyer_image_url : target.cover_image_url,
        selectedCount: recipients.length,
        eligibleCount: eligibleTargetRecipients(recipients, state).length,
        alreadyRsvpdCount: state.rsvpd.size,
        alreadyInvitedCount: state.invited.size
      });
    }
    res.json({ selectedCount: recipients.length, events });
  } catch (err) { next(err); }
});

// POST /api/events/:id/familiar-faces/invite — send a reviewed selection from
// this old event to one upcoming event, with server-side eligibility and dedupe.
router.post('/api/events/:id/familiar-faces/invite', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const targetEventId = Number.parseInt(req.body.targetEventId, 10);
    const faceIds = Array.isArray(req.body.faceIds) ? req.body.faceIds : [];
    if (!Number.isInteger(targetEventId) || targetEventId < 1) return res.status(400).json({ error: 'Choose an upcoming event' });
    if (!faceIds.length) return res.status(400).json({ error: 'Choose at least one person' });
    if (faceIds.length > 500) return res.status(400).json({ error: 'Choose no more than 500 people at a time' });

    await client.query('BEGIN');
    const { rows: sourceRows } = await client.query(
      `SELECT id, title, status,
              event_date < (CURRENT_TIMESTAMP AT TIME ZONE timezone)::date AS is_past
         FROM events WHERE id=$1 AND organizer_id=$2 FOR UPDATE`,
      [req.params.id, req.organizer.id]
    );
    if (!sourceRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found' });
    }
    const source = sourceRows[0];
    if (source.status !== 'published' || !source.is_past) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Choose people from one of your past published events' });
    }
    const { rows: targetRows } = await client.query(
      `SELECT *, event_date < (CURRENT_TIMESTAMP AT TIME ZONE timezone)::date AS is_past
         FROM events WHERE id=$1 AND organizer_id=$2 FOR UPDATE`,
      [targetEventId, req.organizer.id]
    );
    if (!targetRows.length || targetRows[0].id === source.id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Choose one of your upcoming events' });
    }
    const target = targetRows[0];
    if (target.status !== 'published' || target.is_past || target.archived_at || target.secret_show_enabled) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invitations can only be sent to an upcoming published event' });
    }
    const selected = await selectedFamiliarFaceRecipients(client, {
      organizerId: req.organizer.id,
      sourceEventId: source.id,
      faceIds
    });
    const state = await targetRecipientState(client, {
      targetEventId: target.id,
      emails: selected.map(recipient => recipient.email)
    });
    const recipients = eligibleTargetRecipients(selected, state);
    if (!recipients.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'These people already RSVP’d, were invited, or are no longer eligible' });
    }

    const { rows: batches } = await client.query(
      `INSERT INTO previous_guest_invitation_batches
         (target_event_id, source_event_id, source_event_title, recipient_count)
       VALUES ($1,$2,$3,0) RETURNING *`,
      [target.id, source.id, source.title]
    );
    const batch = batches[0];
    let queued = 0;
    for (const recipient of recipients) {
      const result = await client.query(
        `INSERT INTO message_log
           (event_id, previous_guest_invitation_batch_id, recipient, recipient_name,
            message_type, channel, status)
         VALUES ($1,$2,$3,$4,'previous_guest_invite','email','pending')
         ON CONFLICT (event_id, LOWER(recipient)) WHERE message_type='previous_guest_invite'
         DO NOTHING RETURNING id`,
        [target.id, batch.id, recipient.email, recipient.name]
      );
      queued += result.rowCount;
    }
    if (!queued) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'These people were already invited to that event' });
    }
    const { rows: updatedBatches } = await client.query(
      `UPDATE previous_guest_invitation_batches SET recipient_count=$2 WHERE id=$1 RETURNING *`,
      [batch.id, queued]
    );
    await client.query('COMMIT');
    queuePreviousGuestInvitationBatch(batch.id);
    res.status(202).json({
      queued,
      skipped: selected.length - queued,
      batch: previousGuestBatchPayload(updatedBatches[0])
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/events/:id/rsvps.csv
router.get('/api/events/:id/rsvps.csv', async (req, res, next) => {
  try {
    const { rows: ev } = await pool.query('SELECT slug FROM events WHERE id=$1 AND organizer_id=$2', [req.params.id, req.organizer.id]);
    if (!ev.length) return res.status(404).json({ error: 'Event not found' });

    const { rows } = await pool.query(
      `SELECT first_name, last_name, email, phone, guest_first_name, guest_last_name, guest_email,
              wants_reminders, organizer_optin, status, created_at
         FROM rsvps WHERE event_id=$1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${ev[0].slug}-guests.csv"`);
    res.send(rsvpsToCsv(rows));
  } catch (err) { next(err); }
});

function previousGuestBatchPayload(batch) {
  if (!batch) return null;
  return {
    id: batch.id,
    sourceEventId: batch.source_event_id,
    sourceEventTitle: batch.source_event_title,
    status: batch.status,
    recipientCount: batch.recipient_count,
    sentCount: batch.sent_count,
    failedCount: batch.failed_count,
    createdAt: batch.created_at
  };
}

async function eligiblePreviousGuests(queryable, { organizerId, targetEventId, sourceEventId, rsvpIds }) {
  const params = [organizerId, targetEventId, sourceEventId];
  const selected = Array.isArray(rsvpIds);
  if (selected) params.push(rsvpIds);
  const { rows } = await queryable.query(
    `SELECT DISTINCT ON (LOWER(r.email)) r.id, r.first_name, r.last_name, LOWER(r.email) AS email
       FROM rsvps r
       JOIN events source ON source.id=r.event_id
      WHERE source.organizer_id=$1 AND source.id=$3 AND source.id<>$2
        AND source.status='published'
        AND source.event_date < (CURRENT_TIMESTAMP AT TIME ZONE source.timezone)::date
        AND r.status='confirmed'
        AND NULLIF(TRIM(r.email),'') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM follower_optouts fo
           WHERE fo.organizer_id=$1 AND LOWER(fo.email)=LOWER(r.email)
        )
        AND NOT EXISTS (
          SELECT 1 FROM rsvps target_rsvp
           WHERE target_rsvp.event_id=$2 AND target_rsvp.status='confirmed'
             AND LOWER(target_rsvp.email)=LOWER(r.email)
        )
        AND NOT EXISTS (
          SELECT 1 FROM message_log ml
           WHERE ml.event_id=$2 AND LOWER(ml.recipient)=LOWER(r.email)
             AND ml.message_type IN ('announcement','previous_guest_invite')
             AND ml.status IN ('pending','sent')
        )
        ${selected ? 'AND r.id=ANY($4::int[])' : ''}
      ORDER BY LOWER(r.email), r.id DESC`,
    params
  );
  return rows;
}

// GET /api/events/:id/previous-guests — past-event sources and eligible recipients.
router.get('/api/events/:id/previous-guests', async (req, res, next) => {
  try {
    const { rows: targets } = await pool.query(
      `SELECT e.id, e.status, e.visibility, e.secret_show_enabled,
              e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE e.timezone)::date AS is_past
         FROM events e WHERE e.id=$1 AND e.organizer_id=$2`,
      [req.params.id, req.organizer.id]
    );
    if (!targets.length) return res.status(404).json({ error: 'Event not found' });
    const target = targets[0];
    const canInvite = target.status === 'published' && !target.is_past && !target.secret_show_enabled;

    const { rows: batchRows } = await pool.query(
      `SELECT * FROM previous_guest_invitation_batches WHERE target_event_id=$1 LIMIT 1`,
      [target.id]
    );
    const { rows: sources } = canInvite ? await pool.query(
      `SELECT source.id, source.title, source.event_date,
              (COUNT(r.id) FILTER (WHERE r.status='confirmed'))::int AS rsvp_count,
              ((COUNT(r.id) FILTER (WHERE r.status='confirmed')) +
               (COUNT(r.guest_first_name) FILTER (WHERE r.status='confirmed')))::int AS people_count,
              (COUNT(DISTINCT LOWER(r.email)) FILTER (
                WHERE r.status='confirmed'
                  AND NULLIF(TRIM(r.email),'') IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM follower_optouts fo
                     WHERE fo.organizer_id=$1 AND LOWER(fo.email)=LOWER(r.email)
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM rsvps target_rsvp
                     WHERE target_rsvp.event_id=$2 AND target_rsvp.status='confirmed'
                       AND LOWER(target_rsvp.email)=LOWER(r.email)
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM message_log ml
                     WHERE ml.event_id=$2 AND LOWER(ml.recipient)=LOWER(r.email)
                       AND ml.message_type IN ('announcement','previous_guest_invite')
                       AND ml.status IN ('pending','sent')
                  )
              ))::int AS eligible_count
         FROM events source
         LEFT JOIN rsvps r ON r.event_id=source.id
        WHERE source.organizer_id=$1 AND source.id<>$2 AND source.status='published'
          AND source.event_date < (CURRENT_TIMESTAMP AT TIME ZONE source.timezone)::date
        GROUP BY source.id
        HAVING COUNT(r.id) FILTER (WHERE r.status='confirmed') > 0
        ORDER BY source.event_date DESC, source.id DESC`,
      [req.organizer.id, target.id]
    ) : { rows: [] };

    let recipients = [];
    const sourceEventId = Number.parseInt(req.query.sourceEventId, 10);
    if (canInvite && !batchRows.length && Number.isInteger(sourceEventId) && sourceEventId > 0) {
      recipients = await eligiblePreviousGuests(pool, {
        organizerId: req.organizer.id,
        targetEventId: target.id,
        sourceEventId
      });
    }

    res.json({
      canInvite,
      reason: target.secret_show_enabled ? 'Secret Shows are not included yet' : null,
      organizerLabel: req.organizer.org_name || req.organizer.name || 'Silver Glider Events',
      batch: previousGuestBatchPayload(batchRows[0]),
      sources: sources.map(source => ({
        id: source.id,
        title: source.title,
        eventDate: source.event_date,
        rsvpCount: source.rsvp_count,
        peopleCount: source.people_count,
        eligibleCount: source.eligible_count
      })),
      recipients: recipients.map(recipient => ({
        id: recipient.id,
        firstName: recipient.first_name,
        lastName: recipient.last_name,
        email: recipient.email
      }))
    });
  } catch (err) { next(err); }
});

// POST /api/events/:id/previous-guests/invite — queue one reviewed invitation batch.
router.post('/api/events/:id/previous-guests/invite', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const sourceEventId = Number.parseInt(req.body.sourceEventId, 10);
    const rsvpIds = [...new Set((Array.isArray(req.body.rsvpIds) ? req.body.rsvpIds : [])
      .map(value => Number.parseInt(value, 10))
      .filter(value => Number.isInteger(value) && value > 0))];
    if (!Number.isInteger(sourceEventId) || sourceEventId < 1) {
      return res.status(400).json({ error: 'Choose a past event' });
    }
    if (!rsvpIds.length) return res.status(400).json({ error: 'Choose at least one guest' });
    if (rsvpIds.length > 500) return res.status(400).json({ error: 'Choose no more than 500 guests at a time' });

    await client.query('BEGIN');
    const { rows: targetRows } = await client.query(
      `SELECT e.*, e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE e.timezone)::date AS is_past
         FROM events e WHERE e.id=$1 AND e.organizer_id=$2 FOR UPDATE`,
      [req.params.id, req.organizer.id]
    );
    if (!targetRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found' });
    }
    const target = targetRows[0];
    if (target.status !== 'published') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Publish the event before inviting previous guests' });
    }
    if (target.is_past) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Previous guests can only be invited to an upcoming event' });
    }
    if (target.secret_show_enabled) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Previous guest invitations are not available for Secret Shows yet' });
    }
    const { rows: existingBatches } = await client.query(
      `SELECT * FROM previous_guest_invitation_batches WHERE target_event_id=$1`,
      [target.id]
    );
    if (existingBatches.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Previous guests were already invited to this event' });
    }
    const { rows: sourceRows } = await client.query(
      `SELECT id, title FROM events
        WHERE id=$1 AND organizer_id=$2 AND status='published'
          AND event_date < (CURRENT_TIMESTAMP AT TIME ZONE timezone)::date`,
      [sourceEventId, req.organizer.id]
    );
    if (!sourceRows.length || sourceRows[0].id === target.id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Choose one of your past events' });
    }

    const recipients = await eligiblePreviousGuests(client, {
      organizerId: req.organizer.id,
      targetEventId: target.id,
      sourceEventId,
      rsvpIds
    });
    if (!recipients.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'None of the selected guests are eligible for this invitation' });
    }
    const { rows: batches } = await client.query(
      `INSERT INTO previous_guest_invitation_batches
         (target_event_id, source_event_id, source_event_title, recipient_count)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [target.id, sourceEventId, sourceRows[0].title, recipients.length]
    );
    const batch = batches[0];
    for (const recipient of recipients) {
      const recipientName = `${recipient.first_name || ''} ${recipient.last_name || ''}`.trim() || null;
      await client.query(
        `INSERT INTO message_log
           (event_id, previous_guest_invitation_batch_id, recipient, recipient_name,
            message_type, channel, status)
         VALUES ($1,$2,$3,$4,'previous_guest_invite','email','pending')`,
        [target.id, batch.id, recipient.email, recipientName]
      );
    }
    await client.query('COMMIT');
    queuePreviousGuestInvitationBatch(batch.id);
    res.status(202).json({
      queued: recipients.length,
      batch: previousGuestBatchPayload(batch)
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'Previous guests were already invited to this event' });
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/events/:id/submit-to-line
router.post('/api/events/:id/submit-to-line', async (req, res, next) => {
  try {
    const { rows: ev } = await pool.query(
      'SELECT id, visibility, status FROM events WHERE id=$1 AND organizer_id=$2',
      [req.params.id, req.organizer.id]
    );
    if (!ev.length) return res.status(404).json({ error: 'Event not found' });
    if (!canAppearInPublicListings(ev[0])) {
      return res.status(400).json({ error: 'Only published public events can be submitted to The Line' });
    }

    await pool.query(
      `INSERT INTO line_submissions (event_id, organizer_id) VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING`,
      [req.params.id, req.organizer.id]
    );
    const { rows } = await pool.query('SELECT status, created_at, reviewed_at FROM line_submissions WHERE event_id=$1', [req.params.id]);
    res.json({ submission: rows[0] });
  } catch (err) { next(err); }
});

// GET /api/events/:id/line-status
router.get('/api/events/:id/line-status', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ls.status, ls.created_at, ls.reviewed_at
         FROM line_submissions ls JOIN events e ON e.id=ls.event_id
        WHERE ls.event_id=$1 AND e.organizer_id=$2
          AND e.visibility='public' AND e.status='published'`,
      [req.params.id, req.organizer.id]
    );
    res.json({ submission: rows[0] || null });
  } catch (err) { next(err); }
});

// GET /api/events/:id/followers — how many opted-in followers would get an announcement
router.get('/api/events/:id/followers', async (req, res, next) => {
  try {
    const { rows: ev } = await pool.query(
      'SELECT announced_at, announced_count, visibility, status FROM events WHERE id=$1 AND organizer_id=$2',
      [req.params.id, req.organizer.id]
    );
    if (!ev.length) return res.status(404).json({ error: 'Event not found' });

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM (
         SELECT LOWER(r.email) AS email
           FROM rsvps r JOIN events e ON e.id = r.event_id
          WHERE e.organizer_id = $1 AND r.organizer_optin = TRUE AND r.status = 'confirmed'
            AND LOWER(r.email) NOT IN (SELECT LOWER(email) FROM follower_optouts WHERE organizer_id = $1)
            AND NOT EXISTS (
              SELECT 1 FROM rsvps target_rsvp
               WHERE target_rsvp.event_id=$2 AND target_rsvp.status='confirmed'
                 AND LOWER(target_rsvp.email)=LOWER(r.email)
            )
            AND NOT EXISTS (
              SELECT 1 FROM message_log ml
               WHERE ml.event_id=$2 AND LOWER(ml.recipient)=LOWER(r.email)
                 AND ml.message_type IN ('announcement','previous_guest_invite')
                 AND ml.status IN ('pending','sent')
            )
          GROUP BY LOWER(r.email)
       ) f`,
      [req.organizer.id, req.params.id]
    );
    const didSendAnnouncement = ev[0].announced_at && ev[0].announced_count > 0;
    res.json({
      count: rows[0].count,
      announcedAt: ev[0].announced_at,
      announcedCount: ev[0].announced_count,
      canAnnounce: ev[0].status === 'published' && ev[0].visibility === 'public' && !didSendAnnouncement
    });
  } catch (err) { next(err); }
});

// POST /api/events/:id/announce — email the organizer's opted-in followers (one-shot)
router.post('/api/events/:id/announce', async (req, res, next) => {
  try {
    const { rows: ev } = await pool.query(
      'SELECT * FROM events WHERE id=$1 AND organizer_id=$2', [req.params.id, req.organizer.id]
    );
    if (!ev.length) return res.status(404).json({ error: 'Event not found' });
    const event = ev[0];

    if (event.status !== 'published') return res.status(400).json({ error: 'Publish the event before announcing it' });
    if (event.visibility !== 'public') return res.status(400).json({ error: 'Only public events can be announced to followers' });
    if (event.announced_at && event.announced_count > 0) return res.status(409).json({ error: 'This event was already announced' });

    const { rows: recipients } = await pool.query(
      `SELECT LOWER(r.email) AS email, MIN(r.first_name) AS first_name
        FROM rsvps r JOIN events e ON e.id = r.event_id
       WHERE e.organizer_id = $1 AND r.organizer_optin = TRUE AND r.status = 'confirmed'
          AND LOWER(r.email) NOT IN (SELECT LOWER(email) FROM follower_optouts WHERE organizer_id = $1)
          AND NOT EXISTS (
            SELECT 1 FROM rsvps target_rsvp
             WHERE target_rsvp.event_id=$2 AND target_rsvp.status='confirmed'
               AND LOWER(target_rsvp.email)=LOWER(r.email)
          )
          AND NOT EXISTS (
            SELECT 1 FROM message_log ml
             WHERE ml.event_id=$2 AND LOWER(ml.recipient)=LOWER(r.email)
               AND ml.message_type IN ('announcement','previous_guest_invite')
               AND ml.status IN ('pending','sent')
          )
        GROUP BY LOWER(r.email)`,
      [req.organizer.id, event.id]
    );

    const organizerLabel = req.organizer.org_name || req.organizer.name || 'Silver Glider Events';
    let sent = 0;
    for (const r of recipients) {
      const unsubscribeUrl = `${process.env.APP_URL}/unsubscribe?token=${signOptout(req.organizer.id, r.email)}`;
      try {
        await sendEventAnnouncement({ to: r.email, event, organizerLabel, replyTo: req.organizer.email, unsubscribeUrl });
        sent++;
        await pool.query(
          `INSERT INTO message_log (event_id, recipient, message_type, channel, status, sent_at)
           VALUES ($1,$2,'announcement','email','sent',NOW())`,
          [event.id, r.email]
        );
      } catch (err) {
        await pool.query(
          `INSERT INTO message_log (event_id, recipient, message_type, channel, status, error)
           VALUES ($1,$2,'announcement','email','failed',$3)`,
          [event.id, r.email, err.message]
        ).catch(() => {});
      }
    }

    await pool.query('UPDATE events SET announced_at=NOW(), announced_count=$2 WHERE id=$1', [event.id, sent]);
    res.json({ sent, total: recipients.length });
  } catch (err) { next(err); }
});

// PUT /api/settings
router.put('/api/settings', async (req, res, next) => {
  try {
    const name = String(req.body.name ?? '').trim().slice(0, 100) || null;
    const normalized = normalizeHostProfile(req.body || {}, req.organizer);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    const profile = normalized.value;

    let publicSlug = profile.publicSlug;
    if (profile.orgName && !publicSlug) {
      const ensured = await ensureHostProfile(req.organizer.id, profile.orgName);
      publicSlug = ensured.public_slug;
    }
    const { rows } = await pool.query(
      `UPDATE organizers
          SET name=$2, org_name=$3, public_slug=$4, bio=$5,
              website_url=$6, instagram_handle=$7, contact_email=$8,
              updated_at=NOW()
        WHERE id=$1
        RETURNING id, email, name, avatar_url, org_name, public_slug, logo_url, header_image_url,
                  bio, website_url, instagram_handle, instagram_url, contact_email,
                  plan, is_admin, created_at, updated_at`,
      [
        req.organizer.id, name, profile.orgName, publicSlug, profile.bio,
        profile.websiteUrl, profile.instagramHandle, profile.contactEmail
      ]
    );
    res.json({ organizer: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That host page slug is already taken' });
    next(err);
  }
});

module.exports = router;
