const { makeEventSlug } = require('./slug');
const { cleanInstagramHandle } = require('./host-profile');
const { normalizeGuestExperienceSettings } = require('./private-events');
const { hashCode, normalizeCode, validateCode } = require('./secret-show');
const { isManagedFlyerUrl, isManagedVibePhotoUrl } = require('./cloudinary');
const { ADMISSION_TYPES, normalizeAdmissionType } = require('./admission');
const { normalizeHex } = require('../../public/js/artwork-color');
const LocationUtils = require('../../public/js/location-utils');
const { SMS_CONSENT_VERSION } = require('./sms-consent');

const CATEGORIES = ['Music', 'Art', 'Market', 'Party', 'Community', 'Food & Drink', 'Film', 'Other'];
const THEMES = ['midnight', 'aurora', 'sunset', 'ocean', 'adaptive', 'static', 'paper', 'halloween', 'liquid-stardust', 'color-static', 'last-guest', 'disco', 'fog', 'saloon'];
const PRESENTATION_MODES = ['standard', 'flyer'];
const COVER_FIT_MODES = ['auto', 'contain', 'cover'];

// Keep this list explicit. Event rows also contain collection-link bearer
// credentials (photo_upload_token and photo_short_token), which must never be
// returned by an editor API.
const EDITOR_EVENT_FIELDS = Object.freeze([
  'id',
  'organizer_id',
  'slug',
  'title',
  'description',
  'cover_image_url',
  'cover_fit_mode',
  'presentation_mode',
  'flyer_image_url',
  'flyer_designer_name',
  'flyer_designer_instagram_handle',
  'artwork_accent_color',
  'cover_credit_name',
  'cover_credit_link',
  'event_date',
  'start_time',
  'end_time',
  'timezone',
  'venue_name',
  'venue_address',
  'venue_city',
  'venue_state',
  'venue_latitude',
  'venue_longitude',
  'google_place_id',
  'category',
  'capacity',
  'visibility',
  'background_theme',
  'admission_type',
  'ticket_price',
  'ticket_url',
  'commerce_event_id',
  'event_vibe_url',
  'event_vibe_label',
  'event_vibe_image_url',
  'event_vibe_url_2',
  'event_vibe_label_2',
  'event_vibe_image_url_2',
  'event_vibe_url_3',
  'event_vibe_label_3',
  'event_vibe_image_url_3',
  'show_guest_list',
  'allow_guests',
  'comments_enabled',
  'secret_show_enabled',
  'secret_show_version',
  'sms_reminder_enabled',
  'status',
  'duplicated_from_id',
  'calendar_sequence',
  'collect_photos_enabled',
  'photo_request_sent_at',
  'photo_request_sent_count',
  'announced_at',
  'announced_count',
  'announced_text_count',
  'archived_at',
  'created_at',
  'updated_at',
  'is_past',
  'rsvp_count',
  'guest_count',
  'total_attendance',
  'sms_eligible_count',
  'comment_count',
  'latest_notification'
]);

const NUMERIC_EVENT_FIELDS = new Set([
  'capacity',
  'ticket_price',
  'venue_latitude',
  'venue_longitude'
]);

const BOOLEAN_EVENT_FIELDS = new Set([
  'show_guest_list',
  'allow_guests',
  'comments_enabled',
  'secret_show_enabled',
  'sms_reminder_enabled'
]);

class EventEditorError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'EventEditorError';
    this.code = code;
    this.status = status;
  }
}

function editorError(code, message, status = 400) {
  return new EventEditorError(code, message, status);
}

function toEditorEventDto(row) {
  if (!row) return null;
  const event = {};
  for (const field of EDITOR_EVENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(row, field)) event[field] = row[field];
  }
  return event;
}

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

async function createEventNotificationBatch(db, { eventId, kind, changes = [] }) {
  const { rows: recipients } = await db.query(
    `SELECT id, user_id, email FROM rsvps WHERE event_id=$1 AND status='confirmed' ORDER BY id`,
    [eventId]
  );
  if (!recipients.length) return null;
  const { rows: batches } = await db.query(
    `INSERT INTO event_notification_batches (event_id, kind, changes, recipient_count)
     VALUES ($1,$2,$3::jsonb,$4) RETURNING id`,
    [eventId, kind, JSON.stringify(changes), recipients.length]
  );
  const batchId = batches[0].id;
  for (const recipient of recipients) {
    await db.query(
      `INSERT INTO message_log
         (rsvp_id, event_id, notification_batch_id, recipient, recipient_user_id,
          message_type, channel, status)
       VALUES ($1,$2,$3,$4,$5,$6,'email','pending')
       ON CONFLICT (notification_batch_id, rsvp_id, channel)
         WHERE notification_batch_id IS NOT NULL AND rsvp_id IS NOT NULL DO NOTHING`,
      [recipient.id, eventId, batchId, recipient.email, recipient.user_id, kind]
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

function cleanVibeImageUrl(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return null;
  return isManagedVibePhotoUrl(raw) ? raw.slice(0, 1000) : null;
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

function validateEventBody(body, { partial = false } = {}) {
  const errors = [];
  const out = {};
  const fields = {
    title:           v => String(v).trim().slice(0, 140),
    description:     v => String(v ?? '').trim(),
    event_vibe_url:  cleanVibeUrl,
    event_vibe_label: cleanVibeLabel,
    event_vibe_image_url: cleanVibeImageUrl,
    event_vibe_url_2: cleanVibeUrl,
    event_vibe_label_2: cleanVibeLabel,
    event_vibe_image_url_2: cleanVibeImageUrl,
    event_vibe_url_3: cleanVibeUrl,
    event_vibe_label_3: cleanVibeLabel,
    event_vibe_image_url_3: cleanVibeImageUrl,
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
  if (body.event_vibe_url_3 && !out.event_vibe_url_3) errors.push('Enter a supported third Event Vibe link');
  for (const field of ['event_vibe_image_url', 'event_vibe_image_url_2', 'event_vibe_image_url_3']) {
    if (body[field] && !out[field]) errors.push('Upload Event Vibe photos through Silver Glider Events');
  }
  const vibeEntries = [
    { number: 'first', label: out.event_vibe_label, url: out.event_vibe_url, image: out.event_vibe_image_url },
    { number: 'second', label: out.event_vibe_label_2, url: out.event_vibe_url_2, image: out.event_vibe_image_url_2 },
    { number: 'third', label: out.event_vibe_label_3, url: out.event_vibe_url_3, image: out.event_vibe_image_url_3 }
  ];
  const vibeRequested = [
    Boolean(String(body.event_vibe_label ?? '').trim() || String(body.event_vibe_url ?? '').trim() || String(body.event_vibe_image_url ?? '').trim()),
    Boolean(String(body.event_vibe_label_2 ?? '').trim() || String(body.event_vibe_url_2 ?? '').trim() || String(body.event_vibe_image_url_2 ?? '').trim()),
    Boolean(String(body.event_vibe_label_3 ?? '').trim() || String(body.event_vibe_url_3 ?? '').trim() || String(body.event_vibe_image_url_3 ?? '').trim())
  ];
  const vibeHasContent = vibeEntries.map(entry => Boolean(entry.url || entry.image));
  vibeRequested.forEach((requested, index) => {
    if (requested && !vibeHasContent[index]) errors.push(`Add a photo or link for the ${vibeEntries[index].number} artist`);
  });
  if (vibeRequested[1] && !vibeHasContent[0]) errors.push('Add a photo or link for the first artist');
  if (vibeRequested[2] && !vibeHasContent[1]) errors.push('Add a photo or link for the second artist');
  if (vibeHasContent[1] || vibeHasContent[2]) {
    vibeEntries.forEach((entry, index) => {
      if (vibeHasContent[index] && !entry.label) errors.push(`Add the ${entry.number} artist name`);
    });
  }
  const primaryVibeTouched = ['event_vibe_url', 'event_vibe_label', 'event_vibe_image_url'].some(field => body[field] !== undefined);
  const secondVibeTouched = ['event_vibe_url_2', 'event_vibe_label_2', 'event_vibe_image_url_2'].some(field => body[field] !== undefined);
  if (primaryVibeTouched && !vibeHasContent[0]) {
    for (const field of ['event_vibe_label', 'event_vibe_url_2', 'event_vibe_label_2', 'event_vibe_image_url_2', 'event_vibe_url_3', 'event_vibe_label_3', 'event_vibe_image_url_3']) out[field] = null;
  } else if (secondVibeTouched && !vibeHasContent[1]) {
    for (const field of ['event_vibe_label_2', 'event_vibe_url_3', 'event_vibe_label_3', 'event_vibe_image_url_3']) out[field] = null;
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
  if (body.status !== undefined && out.status === undefined) errors.push('Choose a valid event status');
  return { out, errors };
}

function validatedEventBody(body, options) {
  const result = validateEventBody(body || {}, options);
  if (result.errors.length) throw editorError('event_validation_failed', result.errors[0]);
  return result.out;
}

function validateCreateEventInput(body) {
  const out = validatedEventBody(body);
  const secretShowEnabled = isTrue(body?.secret_show_enabled);
  if (secretShowEnabled && out.visibility !== 'private') {
    throw editorError('secret_show_requires_private', 'Secret Show requires Private — Link Only');
  }
  if (secretShowEnabled && out.sms_reminder_enabled) {
    throw editorError('secret_show_sms_not_available', 'Day-before text reminders are not available for Secret Shows yet');
  }
  let secretCode = null;
  if (secretShowEnabled) {
    const validated = validateSecretCodePair(body);
    if (validated.error) throw editorError('invalid_secret_show_code', validated.error);
    secretCode = validated.code;
  }
  return { out, secretShowEnabled, secretCode };
}

async function createEventInTransaction(db, { organizerId, body }) {
  const { out, secretShowEnabled, secretCode } = validateCreateEventInput(body || {});
  Object.assign(out, normalizeGuestExperienceSettings(body || {}));
  const secretCodeHash = secretCode ? await hashCode(secretCode) : null;
  const slug = makeEventSlug(out);
  const { rows } = await db.query(
    `INSERT INTO events (organizer_id, slug, title, description, cover_image_url, cover_fit_mode, presentation_mode, flyer_image_url,
                         flyer_designer_name, flyer_designer_instagram_handle, event_date,
                         start_time, end_time, venue_name, venue_address, category, capacity, visibility, background_theme,
                         cover_credit_name, cover_credit_link, admission_type, ticket_price, ticket_url,
                         venue_city, venue_state, venue_latitude, venue_longitude, google_place_id,
                         event_vibe_url, event_vibe_label, event_vibe_image_url,
                         event_vibe_url_2, event_vibe_label_2, event_vibe_image_url_2,
                         event_vibe_url_3, event_vibe_label_3, event_vibe_image_url_3,
                         show_guest_list, allow_guests, comments_enabled, secret_show_enabled, secret_show_version,
                         artwork_accent_color, commerce_event_id, sms_reminder_enabled, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47)
     RETURNING *`,
    [organizerId, slug, out.title, out.description || null, out.cover_image_url,
     out.cover_fit_mode, out.presentation_mode, out.flyer_image_url,
     out.flyer_designer_name || null, out.flyer_designer_instagram_handle || null,
     out.event_date, out.start_time, out.end_time, out.venue_name, out.venue_address,
     out.category, out.capacity, out.visibility || 'public', out.background_theme || 'midnight',
     out.cover_credit_name || null, out.cover_credit_link || null,
     out.admission_type || 'free_rsvp', out.ticket_price ?? null, out.ticket_url || null,
     out.venue_city || null, out.venue_state || null, out.venue_latitude, out.venue_longitude,
     out.google_place_id || null,
     out.event_vibe_url || null, out.event_vibe_label || null, out.event_vibe_image_url || null,
     out.event_vibe_url_2 || null, out.event_vibe_label_2 || null, out.event_vibe_image_url_2 || null,
     out.event_vibe_url_3 || null, out.event_vibe_label_3 || null, out.event_vibe_image_url_3 || null,
     out.show_guest_list, out.allow_guests, out.comments_enabled,
     secretShowEnabled, secretShowEnabled ? 1 : 0, out.artwork_accent_color || null,
     out.commerce_event_id || null, out.sms_reminder_enabled === true,
     out.status === 'draft' ? 'draft' : 'published']
  );
  if (secretShowEnabled) {
    await db.query(
      `INSERT INTO event_secret_codes (event_id, code_hash) VALUES ($1,$2)`,
      [rows[0].id, secretCodeHash]
    );
  }
  return { event: toEditorEventDto(rows[0]) };
}

async function getEventForEditor(db, { organizerId, eventId }) {
  const { rows } = await db.query(
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
    [eventId, organizerId]
  );
  if (!rows.length) throw editorError('event_not_found', 'Event not found', 404);
  return { event: toEditorEventDto(rows[0]) };
}

function valuesMatch(field, before, after) {
  if (before == null || after == null) return before == null && after == null;
  if (field === 'event_date') return canonicalDate(before) === canonicalDate(after);
  if (field === 'start_time' || field === 'end_time') return canonicalTime(before) === canonicalTime(after);
  if (NUMERIC_EVENT_FIELDS.has(field)) return Number(before) === Number(after);
  if (BOOLEAN_EVENT_FIELDS.has(field)) return Boolean(before) === Boolean(after);
  if (before instanceof Date || after instanceof Date) {
    return new Date(before).getTime() === new Date(after).getTime();
  }
  return String(before) === String(after);
}

async function updateEventInTransaction(db, { organizerId, eventId, body }) {
  const out = validatedEventBody(body || {}, { partial: true });
  delete out.status; // status changes go through /cancel or /publish

  const { rows: currentRows } = await db.query(
    `SELECT * FROM events WHERE id=$1 AND organizer_id=$2 FOR UPDATE`,
    [eventId, organizerId]
  );
  if (!currentRows.length) throw editorError('event_not_found', 'Event not found', 404);
  const current = currentRows[0];
  const importantChanges = importantEventChanges(current, out);
  const notifyAttendees = isTrue(body?.notify_attendees) && current.status === 'published' && importantChanges.length > 0;
  const effectiveAdmission = out.admission_type || normalizeAdmissionType(current.admission_type) || ADMISSION_TYPES.FREE_RSVP;
  const effectiveCommerceEventId = out.commerce_event_id !== undefined
    ? out.commerce_event_id
    : current.commerce_event_id;
  if (effectiveAdmission === ADMISSION_TYPES.SILVER_GLIDER_TICKETS && !effectiveCommerceEventId && current.status !== 'draft') {
    throw editorError('commerce_event_required', 'Connect this event to Silver Glider Commerce before publishing');
  }
  if (effectiveAdmission !== ADMISSION_TYPES.SILVER_GLIDER_TICKETS && out.commerce_event_id) {
    throw editorError('commerce_admission_required', 'Choose Sell with Silver Glider before adding a Commerce event reference');
  }
  const effectivePresentationMode = out.presentation_mode ?? current.presentation_mode ?? 'standard';
  const effectiveFlyerImage = out.flyer_image_url !== undefined ? out.flyer_image_url : current.flyer_image_url;
  if (effectivePresentationMode === 'flyer' && !effectiveFlyerImage) {
    throw editorError('flyer_image_required', 'A flyer image is required for Flyer presentation');
  }
  const effectiveVisibility = out.visibility || current.visibility;
  Object.assign(out, normalizeGuestExperienceSettings({
    show_guest_list: body?.show_guest_list ?? current.show_guest_list,
    allow_guests: body?.allow_guests ?? current.allow_guests,
    comments_enabled: body?.comments_enabled ?? current.comments_enabled
  }));

  const secretShowEnabled = body?.secret_show_enabled === undefined
    ? current.secret_show_enabled
    : isTrue(body.secret_show_enabled);
  if (secretShowEnabled && effectiveVisibility !== 'private') {
    throw editorError('secret_show_requires_private', 'Disable Secret Show before making this event public');
  }
  const effectiveSmsReminderEnabled = out.sms_reminder_enabled === undefined
    ? current.sms_reminder_enabled
    : out.sms_reminder_enabled;
  if (secretShowEnabled && effectiveSmsReminderEnabled) {
    throw editorError('secret_show_sms_not_available', 'Disable day-before text reminders before enabling Secret Show');
  }

  const codeWasEntered = Boolean(String(body?.secret_code || '').trim() || String(body?.secret_code_confirm || '').trim());
  let replacementHash = null;
  if (secretShowEnabled && (codeWasEntered || !current.secret_show_enabled)) {
    const validated = validateSecretCodePair(body || {});
    if (validated.error) throw editorError('invalid_secret_show_code', validated.error);
    replacementHash = await hashCode(validated.code);
  }

  const secretStateChanged = secretShowEnabled !== current.secret_show_enabled;
  const secretVersion = Number(current.secret_show_version) + ((secretStateChanged || replacementHash) ? 1 : 0);
  out.secret_show_enabled = secretShowEnabled;
  out.secret_show_version = secretVersion;

  const keys = Object.keys(out);
  if (!keys.length) throw editorError('nothing_to_update', 'Nothing to update');

  const sets = keys.map((key, index) => `${key}=$${index + 3}`).join(', ');
  const calendarSequenceUpdate = importantChanges.length ? ', calendar_sequence=calendar_sequence+1' : '';
  const { rows } = await db.query(
    `UPDATE events SET ${sets}${calendarSequenceUpdate}, updated_at=NOW() WHERE id=$1 AND organizer_id=$2 RETURNING *`,
    [eventId, organizerId, ...keys.map(key => out[key])]
  );
  if (secretShowEnabled && replacementHash) {
    await db.query(
      `INSERT INTO event_secret_codes (event_id, code_hash)
       VALUES ($1,$2)
       ON CONFLICT (event_id) DO UPDATE SET code_hash=EXCLUDED.code_hash, updated_at=NOW()`,
      [eventId, replacementHash]
    );
  } else if (!secretShowEnabled) {
    await db.query('DELETE FROM event_secret_codes WHERE event_id=$1', [eventId]);
  }
  const notification = notifyAttendees
    ? await createEventNotificationBatch(db, {
      eventId: rows[0].id,
      kind: 'event_updated',
      changes: importantChanges
    })
    : null;
  const changedFields = keys
    .filter(field => field !== 'secret_show_version' && !valuesMatch(field, current[field], rows[0][field]));
  if (replacementHash) changedFields.push('secret_code');
  return {
    event: toEditorEventDto(rows[0]),
    importantChanges,
    notification,
    changedFields
  };
}

async function publishEventInTransaction(db, { organizerId, eventId }) {
  const { rows } = await db.query(
    `SELECT e.*,
            EXISTS(SELECT 1 FROM event_secret_codes c WHERE c.event_id=e.id) AS has_secret_code
       FROM events e
      WHERE e.id=$1 AND e.organizer_id=$2
      FOR UPDATE`,
    [eventId, organizerId]
  );
  if (!rows.length) throw editorError('event_not_found', 'Event not found', 404);
  const event = rows[0];
  if (event.status === 'published') {
    return { event: toEditorEventDto(event), alreadyPublished: true };
  }
  if (event.status !== 'draft') {
    throw editorError('event_not_draft', 'Only a draft can be published', 409);
  }

  if (!String(event.title || '').trim() || !event.event_date || !event.start_time || !String(event.venue_name || '').trim()) {
    throw editorError('event_incomplete', 'Add the title, date, time, and location before publishing');
  }
  if (event.presentation_mode === 'flyer' && !event.flyer_image_url) {
    throw editorError('flyer_image_required', 'Upload a flyer before publishing the Flyer layout');
  }
  if (normalizeAdmissionType(event.admission_type) === ADMISSION_TYPES.SILVER_GLIDER_TICKETS && !event.commerce_event_id) {
    throw editorError('commerce_event_required', 'Connect this event to Silver Glider Commerce before publishing');
  }
  if (event.secret_show_enabled && (event.visibility !== 'private' || event.sms_reminder_enabled || !event.has_secret_code)) {
    throw editorError('secret_show_incomplete', 'Finish the Secret Show settings before publishing');
  }

  const published = await db.query(
    `UPDATE events SET status='published', updated_at=NOW()
      WHERE id=$1 AND organizer_id=$2
      RETURNING *`,
    [eventId, organizerId]
  );
  return { event: toEditorEventDto(published.rows[0]), alreadyPublished: false };
}

module.exports = {
  EDITOR_EVENT_FIELDS,
  EventEditorError,
  createEventInTransaction,
  getEventForEditor,
  publishEventInTransaction,
  toEditorEventDto,
  updateEventInTransaction,
  validateCreateEventInput,
  validateEventBody
};
