const express = require('express');
const crypto = require('crypto');
const pool = require('../config/db');
const requireOrganizer = require('../middleware/requireOrganizer');
const { makeEventSlug } = require('../lib/slug');
const { cleanHostName, ensureHostProfile, normalizeHostProfile } = require('../lib/host-profile');
const { rsvpsToCsv } = require('../lib/csv');
const { sendEventAnnouncement } = require('../lib/mailer');
const { signOptout } = require('../lib/followers');
const { attendeeAvatar, canAppearInPublicListings, safeAvatarUrl } = require('../lib/private-events');
const {
  EventEditorError,
  createEventInTransaction,
  getEventForEditor,
  publishEventInTransaction,
  updateEventInTransaction,
  validateCreateEventInput
} = require('../lib/event-editor');
const { queueEventNotificationBatch } = require('../jobs/event-notifications');
const { queuePreviousGuestInvitationBatch } = require('../jobs/previous-guest-invitations');
const { SmsCreditError } = require('../lib/sms-credit-ledger');
const {
  createFollowerAnnouncementBatch, makeFollowerAnnouncementPreview
} = require('../lib/follow-announcement');
const { queueSmsBatch } = require('../jobs/sms-notifications');
const { HOST_ACCOUNT_INACTIVE, withActiveHostAccount } = require('../lib/outbound-account-status');

const router = express.Router();
// Scope auth to organizer API paths only — this router is mounted at app root,
// so a bare router.use() would gate the public event pages too.
router.use('/api/events', requireOrganizer);
router.use('/api/settings', requireOrganizer);
router.use('/api/places', requireOrganizer);

function isTrue(value) {
  return value === true || value === 'true';
}

async function createEventNotificationBatch(client, { eventId, kind, changes = [] }) {
  const { rows: recipients } = await client.query(
    `SELECT id, user_id, email FROM rsvps WHERE event_id=$1 AND status='confirmed' ORDER BY id`,
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

function placesApiKey() {
  return (process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_BROWSER_KEY || '').trim();
}

function handleEventEditorError(err, res, next) {
  if (err instanceof EventEditorError) {
    return res.status(err.status).json({ error: err.message });
  }
  return next(err);
}

// GET /api/places/config — browser key for Google Places Autocomplete.
// This must be a Google browser key restricted by HTTP referrer in Google Cloud.
router.get('/api/places/config', (req, res) => {
  const apiKey = placesApiKey();
  res.json(apiKey ? { enabled: true, apiKey } : { enabled: false });
});

// GET /api/events — mine, with confirmed RSVP counts.
// Excludes archived by default; ?archived=1 returns only archived.
router.get('/api/events/going', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (e.id)
              e.id, e.slug, e.title, e.event_date, e.start_time, e.end_time,
              e.venue_name, e.venue_city, e.venue_state, e.status, e.visibility,
              e.presentation_mode, e.flyer_image_url, e.cover_image_url,
              o.org_name AS host_name, o.name AS host_person_name,
              r.created_at AS rsvp_created_at
         FROM rsvps r
         JOIN events e ON e.id=r.event_id
         JOIN organizers o ON o.id=e.organizer_id
        WHERE (r.user_id=$2 OR (r.user_id IS NULL AND r.account_id=$1))
          AND r.status='confirmed'
          AND e.status IN ('published','cancelled')
        ORDER BY e.id, r.created_at DESC`,
      [req.organizer.id, req.organizer.user_id]
    );
    rows.sort((a, b) => String(b.event_date).localeCompare(String(a.event_date)) || Number(b.id) - Number(a.id));
    res.json({ events: rows });
  } catch (err) { next(err); }
});

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
    validateCreateEventInput(req.body);

    const presenterName = cleanHostName(req.body.presenter_name);
    if (!req.organizer.public_slug && presenterName) {
      await ensureHostProfile(req.organizer.id, presenterName);
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await createEventInTransaction(client, {
          organizerId: req.organizer.id,
          body: req.body
        });
        await client.query('COMMIT');
        return res.status(201).json(result);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err.code === '23505' && attempt < 2) continue; // slug collision — retry
        throw err;
      } finally {
        client.release();
      }
    }
  } catch (err) { handleEventEditorError(err, res, next); }
});

// GET /api/events/:id
router.get('/api/events/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const result = await getEventForEditor(client, {
      organizerId: req.organizer.id,
      eventId: req.params.id
    });
    res.json(result);
  } catch (err) {
    handleEventEditorError(err, res, next);
  } finally {
    client.release();
  }
});

// PUT /api/events/:id — update (slug immutable)
router.put('/api/events/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await updateEventInTransaction(client, {
      organizerId: req.organizer.id,
      eventId: req.params.id,
      body: req.body
    });
    await client.query('COMMIT');
    if (result.notification) queueEventNotificationBatch(result.notification.batchId);
    res.json({
      event: result.event,
      importantChanges: result.importantChanges,
      notification: result.notification
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    handleEventEditorError(err, res, next);
  } finally {
    client.release();
  }
});

// POST /api/events/:id/publish — make one owner-only draft public.
// Publishing is intentionally separate from ordinary edits so a save can
// never expose a draft by accident.
router.post('/api/events/:id/publish', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await publishEventInTransaction(client, {
      organizerId: req.organizer.id,
      eventId: req.params.id
    });
    await client.query('COMMIT');
    res.json(result);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    handleEventEditorError(err, res, next);
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
      const slug = makeEventSlug({ title: e.title, status: 'draft', visibility: e.visibility });
      try {
        const { rows } = await pool.query(
          `INSERT INTO events (organizer_id, slug, title, description, cover_image_url, cover_fit_mode, presentation_mode, flyer_image_url,
                               flyer_designer_name, flyer_designer_instagram_handle, event_date,
                               start_time, end_time, timezone, venue_name, venue_address, category,
                               capacity, visibility, admission_type, ticket_price, ticket_url, status, duplicated_from_id,
                               background_theme, cover_credit_name, cover_credit_link,
                               venue_city, venue_state, venue_latitude, venue_longitude, google_place_id,
                               event_vibe_url, event_vibe_label, event_vibe_image_url,
                               event_vibe_url_2, event_vibe_label_2, event_vibe_image_url_2,
                               event_vibe_url_3, event_vibe_label_3, event_vibe_image_url_3,
                               show_guest_list, allow_guests, comments_enabled, artwork_accent_color, commerce_event_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'draft',$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,NULL)
           RETURNING *`,
          [req.organizer.id, slug, e.title, e.description, e.cover_image_url,
           e.cover_fit_mode || 'auto', e.presentation_mode || 'standard', e.flyer_image_url || null,
           e.flyer_designer_name || null, e.flyer_designer_instagram_handle || null, e.event_date,
           e.start_time, e.end_time, e.timezone, e.venue_name, e.venue_address, e.category,
           e.capacity, e.visibility, e.admission_type, e.ticket_price, e.ticket_url, e.id,
           e.background_theme || 'midnight', e.cover_credit_name || null, e.cover_credit_link || null,
           e.venue_city || null, e.venue_state || null, e.venue_latitude, e.venue_longitude,
           e.google_place_id || null,
           e.event_vibe_url || null, e.event_vibe_label || null, e.event_vibe_image_url || null,
           e.event_vibe_url_2 || null, e.event_vibe_label_2 || null, e.event_vibe_image_url_2 || null,
           e.event_vibe_url_3 || null, e.event_vibe_label_3 || null, e.event_vibe_image_url_3 || null,
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

function familiarPersonKey({ userId, email }) {
  const canonicalId = Number(userId);
  if (Number.isInteger(canonicalId) && canonicalId > 0) return `user:${canonicalId}`;
  return `email:${String(email || '').trim().toLowerCase()}`;
}

// A named +1 came with a friend; say whose, so the card makes sense.
function plusOneLabel(primaryFirstName) {
  const first = String(primaryFirstName || '').trim().split(/\s+/)[0];
  return first ? `${first}’s +1` : 'Guest +1';
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
      `SELECT r.id, r.user_id, r.first_name, r.last_name, LOWER(r.email) AS email
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
      userId: row.user_id,
      email: row.email,
      name: `${row.first_name || ''} ${row.last_name || ''}`.trim() || null
    });
  }
  if (invitationIds.length) {
    const { rows } = await queryable.query(
      `SELECT ml.id, ml.recipient_user_id AS user_id,
              LOWER(ml.recipient) AS email, ml.recipient_name
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
    for (const row of rows) recipients.push({
      userId: row.user_id,
      email: row.email,
      name: row.recipient_name || null
    });
  }
  const deduped = new Map();
  for (const recipient of recipients) {
    const email = String(recipient.email || '').trim().toLowerCase();
    const key = familiarPersonKey({ userId: recipient.userId, email });
    if (email && !deduped.has(key)) deduped.set(key, { ...recipient, email, personKey: key });
  }
  return [...deduped.values()];
}

async function targetRecipientState(queryable, { targetEventId, recipients }) {
  if (!recipients.length) return { rsvpd: new Set(), invited: new Set() };
  const emails = [...new Set(recipients.map(recipient => recipient.email).filter(Boolean))];
  const userIds = [...new Set(recipients.map(recipient => Number(recipient.userId))
    .filter(userId => Number.isInteger(userId) && userId > 0))];
  const { rows: rsvpRows } = await queryable.query(
    `SELECT DISTINCT user_id, LOWER(email) AS email FROM rsvps
      WHERE event_id=$1 AND status='confirmed'
        AND (LOWER(email)=ANY($2::text[]) OR user_id=ANY($3::int[]))`,
    [targetEventId, emails, userIds]
  );
  const { rows: invitedRows } = await queryable.query(
    `SELECT DISTINCT recipient_user_id AS user_id, LOWER(recipient) AS email FROM message_log
      WHERE event_id=$1
        AND (LOWER(recipient)=ANY($2::text[]) OR recipient_user_id=ANY($3::int[]))
        AND message_type IN ('announcement','previous_guest_invite')
        AND status IN ('pending','sent')`,
    [targetEventId, emails, userIds]
  );
  const matchesRecipient = rows => recipient => rows.some(row => {
    const recipientUserId = Number(recipient.userId) || null;
    const rowUserId = Number(row.user_id) || null;
    if (recipientUserId && rowUserId) return recipientUserId === rowUserId;
    return row.email === recipient.email;
  });
  return {
    rsvpd: new Set(recipients.filter(matchesRecipient(rsvpRows)).map(recipient => recipient.personKey)),
    invited: new Set(recipients.filter(matchesRecipient(invitedRows)).map(recipient => recipient.personKey))
  };
}

function eligibleTargetRecipients(recipients, state) {
  return recipients.filter(recipient =>
    !state.rsvpd.has(recipient.personKey) && !state.invited.has(recipient.personKey)
  );
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
      `SELECT DISTINCT ON (COALESCE('user:' || r.user_id::text, 'email:' || LOWER(TRIM(r.email))))
              r.id, r.user_id, r.first_name, r.last_name, r.email, r.guest_first_name, r.guest_last_name,
              r.created_at, o.avatar_url,
              NOT EXISTS (
                SELECT 1 FROM follower_optouts fo
                 WHERE fo.organizer_id=$2 AND LOWER(fo.email)=LOWER(r.email)
              ) AS host_email_allowed
        FROM rsvps r
         LEFT JOIN organizers o ON o.id=r.account_id
        WHERE r.event_id=$1 AND r.status='confirmed'
        ORDER BY COALESCE('user:' || r.user_id::text, 'email:' || LOWER(TRIM(r.email))),
                 r.created_at DESC, r.id DESC`,
      [req.params.id, req.organizer.id]
    );
    const { rows: invitations } = await pool.query(
      `SELECT DISTINCT ON (
                COALESCE('user:' || ml.recipient_user_id::text, 'email:' || LOWER(TRIM(ml.recipient)))
              ) ml.id, ml.recipient_user_id AS user_id,
              ml.recipient, ml.recipient_name,
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
            WHERE ((ml.recipient_user_id IS NOT NULL AND linked.user_id=ml.recipient_user_id)
                   OR ((ml.recipient_user_id IS NULL OR linked.user_id IS NULL)
                       AND LOWER(linked.email)=LOWER(ml.recipient)))
            ORDER BY linked.id DESC LIMIT 1
         ) identity ON TRUE
        WHERE ml.event_id=$1 AND ml.message_type='previous_guest_invite'
          AND ml.status IN ('pending','sent')
          AND NOT EXISTS (
            SELECT 1 FROM rsvps current_rsvp
             WHERE current_rsvp.event_id=$1 AND current_rsvp.status IN ('confirmed','cancelled')
               AND ((ml.recipient_user_id IS NOT NULL
                     AND current_rsvp.user_id=ml.recipient_user_id)
                    OR ((ml.recipient_user_id IS NULL OR current_rsvp.user_id IS NULL)
                        AND LOWER(current_rsvp.email)=LOWER(ml.recipient)))
          )
        ORDER BY COALESCE('user:' || ml.recipient_user_id::text,
                          'email:' || LOWER(TRIM(ml.recipient))),
                 ml.id DESC`,
      [req.params.id, req.organizer.id]
    );
    // "I'm not going" (and a cancelled RSVP) is an answer the host should see,
    // not a silent disappearance. These people are not invitation targets.
    const { rows: declined } = await pool.query(
      `SELECT DISTINCT ON (COALESCE('user:' || r.user_id::text, 'email:' || LOWER(TRIM(r.email))))
              r.id, r.user_id, r.first_name, r.last_name, r.email, r.created_at, o.avatar_url
         FROM rsvps r
         LEFT JOIN organizers o ON o.id=r.account_id
        WHERE r.event_id=$1 AND r.status='cancelled'
        ORDER BY COALESCE('user:' || r.user_id::text, 'email:' || LOWER(TRIM(r.email))),
                 r.created_at DESC, r.id DESC`,
      [req.params.id]
    );

    const faces = [];
    for (const rsvp of rsvps) {
      const name = `${rsvp.first_name || ''} ${rsvp.last_name || ''}`.trim() || 'Guest';
      const hasEmail = Boolean(String(rsvp.email || '').trim());
      faces.push({
        id: familiarFaceKey('rsvp', rsvp.id),
        name,
        status: 'RSVP’d',
        // Why a face can't be selected for an invitation, so the picker never
        // looks broken.
        note: !hasEmail ? 'No email' : (!rsvp.host_email_allowed ? 'Unsubscribed' : null),
        avatarUrl: safeAvatarUrl(rsvp.avatar_url),
        avatarEmoji: attendeeAvatar(`email:${String(rsvp.email || '').trim().toLowerCase() || `rsvp:${rsvp.id}`}`),
        canInvite: Boolean(rsvp.host_email_allowed && hasEmail),
        searchText: `${name} ${rsvp.email || ''}`.toLowerCase(),
        sortTime: rsvp.created_at
      });
      const guestName = `${rsvp.guest_first_name || ''} ${rsvp.guest_last_name || ''}`.trim();
      if (guestName) faces.push({
        id: familiarFaceKey('guest', rsvp.id),
        name: guestName,
        status: plusOneLabel(rsvp.first_name),
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
    for (const rsvp of declined) {
      const name = `${rsvp.first_name || ''} ${rsvp.last_name || ''}`.trim() || 'Guest';
      faces.push({
        id: familiarFaceKey('declined', rsvp.id),
        name,
        status: 'Can’t make it',
        declined: true,
        avatarUrl: safeAvatarUrl(rsvp.avatar_url),
        avatarEmoji: attendeeAvatar(`email:${String(rsvp.email || '').trim().toLowerCase() || `rsvp:${rsvp.id}`}`),
        canInvite: false,
        searchText: `${name} ${rsvp.email || ''}`.toLowerCase(),
        sortTime: rsvp.created_at
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
    const events = [];
    for (const target of targets) {
      const state = await targetRecipientState(pool, { targetEventId: target.id, recipients });
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
      recipients: selected
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
           (event_id, previous_guest_invitation_batch_id, recipient, recipient_name, recipient_user_id,
            message_type, channel, status)
         VALUES ($1,$2,$3,$4,$5,'previous_guest_invite','email','pending')
         ON CONFLICT (event_id, LOWER(recipient)) WHERE message_type='previous_guest_invite'
         DO NOTHING RETURNING id`,
        [target.id, batch.id, recipient.email, recipient.name, recipient.userId]
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

// ---- "Invite your people" ---------------------------------------------
// On an upcoming event, Familiar Faces offers everyone who RSVP'd to one of
// the host's past published events: one face per email, newest context first,
// searchable, and invitable without leaving the event. Consent rules match the
// other invitation paths: confirmed primary RSVPs with an email, never
// unsubscribed people, never named +1s, never anyone already RSVP'd, declined,
// or invited here.

const PEOPLE_PAGE_SIZE = 48;

async function loadInviteTarget(queryable, { eventId, organizerId, lock = false }) {
  const { rows } = await queryable.query(
    `SELECT e.*, e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE e.timezone)::date AS is_past
       FROM events e WHERE e.id=$1 AND e.organizer_id=$2${lock ? ' FOR UPDATE' : ''}`,
    [eventId, organizerId]
  );
  const target = rows[0] || null;
  const canInvite = Boolean(target && target.status === 'published' && !target.is_past &&
    !target.archived_at && !target.secret_show_enabled);
  return { target, canInvite };
}

// SQL condition: the canonical person (with normalized-email fallback for
// legacy rows) is already connected to target event $2.
function connectedToTarget(emailExpression, userIdExpression = 'NULL') {
  return `(EXISTS (
    SELECT 1 FROM rsvps target_rsvp
     WHERE target_rsvp.event_id=$2 AND target_rsvp.status IN ('confirmed','cancelled')
       AND ((${userIdExpression} IS NOT NULL AND target_rsvp.user_id=${userIdExpression})
            OR ((${userIdExpression} IS NULL OR target_rsvp.user_id IS NULL)
                AND LOWER(TRIM(target_rsvp.email))=${emailExpression}))
  ) OR EXISTS (
    SELECT 1 FROM message_log ml
     WHERE ml.event_id=$2
       AND ((${userIdExpression} IS NOT NULL AND ml.recipient_user_id=${userIdExpression})
            OR ((${userIdExpression} IS NULL OR ml.recipient_user_id IS NULL)
                AND LOWER(TRIM(ml.recipient))=${emailExpression}))
       AND ml.message_type IN ('announcement','previous_guest_invite')
       AND ml.status IN ('pending','sent')
  ))`;
}

const PAST_RSVPS = `
  SELECT r.id, r.user_id, LOWER(TRIM(r.email)) AS email, r.first_name, r.last_name, r.account_id,
         COALESCE('user:' || r.user_id::text, 'email:' || LOWER(TRIM(r.email))) AS person_key,
         e.id AS event_id, e.title AS event_title, e.event_date
    FROM rsvps r JOIN events e ON e.id=r.event_id
   WHERE e.organizer_id=$1 AND e.id<>$2 AND e.status='published'
     AND e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE e.timezone)::date
     AND r.status='confirmed' AND NULLIF(TRIM(r.email),'') IS NOT NULL`;

function candidateDetail(row, sourceEventId) {
  if (sourceEventId || Number(row.event_count) <= 1) return row.context_title;
  return `${row.event_count} of your events`;
}

// GET /api/events/:id/familiar-faces/people?search=&sourceEventId=&offset=
router.get('/api/events/:id/familiar-faces/people', async (req, res, next) => {
  try {
    const { target, canInvite } = await loadInviteTarget(pool, { eventId: req.params.id, organizerId: req.organizer.id });
    if (!target) return res.status(404).json({ error: 'Event not found' });
    const empty = { canInvite: false, sources: [], people: [], plusOnes: [], total: 0, hasMore: false, unsubscribedCount: 0 };
    if (!canInvite) return res.json(empty);

    const search = String(req.query.search || '').trim().slice(0, 120);
    const pattern = search ? `%${search.replace(/[\\%_]/g, ch => `\\${ch}`)}%` : '';
    const sourceEventId = Number.parseInt(req.query.sourceEventId, 10) || null;
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const params = [req.organizer.id, target.id, sourceEventId, pattern, PEOPLE_PAGE_SIZE, offset];

    const { rows: people } = await pool.query(
      `WITH past AS (${PAST_RSVPS}),
       grouped AS (
         SELECT person_key,
                (ARRAY_AGG(email ORDER BY event_date DESC, id DESC))[1] AS email,
                (ARRAY_AGG(user_id ORDER BY event_date DESC, id DESC)
                  FILTER (WHERE user_id IS NOT NULL))[1] AS user_id,
                COALESCE(
                  (ARRAY_AGG(id ORDER BY event_date DESC, id DESC) FILTER (WHERE event_id=$3))[1],
                  (ARRAY_AGG(id ORDER BY event_date DESC, id DESC))[1]) AS rsvp_id,
                (ARRAY_AGG(first_name ORDER BY event_date DESC, id DESC))[1] AS first_name,
                (ARRAY_AGG(last_name ORDER BY event_date DESC, id DESC))[1] AS last_name,
                COALESCE(
                  (ARRAY_AGG(event_title ORDER BY event_date DESC, id DESC) FILTER (WHERE event_id=$3))[1],
                  (ARRAY_AGG(event_title ORDER BY event_date DESC, id DESC))[1]) AS context_title,
                (ARRAY_AGG(account_id ORDER BY event_date DESC, id DESC) FILTER (WHERE account_id IS NOT NULL))[1] AS account_id,
                MAX(event_date) AS last_event_date,
                COUNT(DISTINCT event_id)::int AS event_count,
                BOOL_OR(event_id=$3) AS in_source
           FROM past GROUP BY person_key
       )
       SELECT g.*, o.avatar_url, COUNT(*) OVER ()::int AS total
         FROM grouped g
         LEFT JOIN organizers o ON o.id=g.account_id
        WHERE NOT EXISTS (SELECT 1 FROM follower_optouts fo WHERE fo.organizer_id=$1 AND LOWER(fo.email)=g.email)
          AND NOT ${connectedToTarget('g.email', 'g.user_id')}
          AND ($3::int IS NULL OR g.in_source)
          AND ($4 = '' OR CONCAT_WS(' ', g.first_name, g.last_name) ILIKE $4 OR g.email ILIKE $4)
        ORDER BY g.event_count DESC, g.last_event_date DESC, LOWER(COALESCE(g.first_name, g.email))
        LIMIT $5 OFFSET $6`,
      params
    );
    const total = people[0]?.total || 0;

    const plusOnes = offset > 0 ? { rows: [] } : await pool.query(
      `SELECT DISTINCT ON (LOWER(CONCAT_WS(' ', r.guest_first_name, r.guest_last_name)), LOWER(r.email))
              r.id, r.guest_first_name, r.guest_last_name, r.first_name AS host_first_name
         FROM rsvps r JOIN events e ON e.id=r.event_id
        WHERE e.organizer_id=$1 AND e.id<>$2 AND e.status='published'
          AND e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE e.timezone)::date
          AND r.status='confirmed' AND NULLIF(TRIM(r.guest_first_name),'') IS NOT NULL
          AND ($3::int IS NULL OR e.id=$3)
          AND ($4 = '' OR CONCAT_WS(' ', r.guest_first_name, r.guest_last_name) ILIKE $4)
          AND NOT EXISTS (
            SELECT 1 FROM rsvps own WHERE NULLIF(TRIM(r.guest_email),'') IS NOT NULL
               AND LOWER(own.email)=LOWER(TRIM(r.guest_email))
               AND own.event_id IN (SELECT id FROM events WHERE organizer_id=$1)
          )
        ORDER BY LOWER(CONCAT_WS(' ', r.guest_first_name, r.guest_last_name)), LOWER(r.email), e.event_date DESC
        LIMIT 24`,
      [req.organizer.id, target.id, sourceEventId, pattern]
    );

    const { rows: sources } = await pool.query(
      `SELECT e.id, e.title, e.event_date
         FROM events e
        WHERE e.organizer_id=$1 AND e.id<>$2 AND e.status='published'
          AND e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE e.timezone)::date
          AND EXISTS (SELECT 1 FROM rsvps r WHERE r.event_id=e.id AND r.status='confirmed')
        ORDER BY e.event_date DESC, e.id DESC`,
      [req.organizer.id, target.id]
    );
    const { rows: optoutRows } = await pool.query(
      `SELECT COUNT(DISTINCT past.email)::int AS n
         FROM (${PAST_RSVPS}) past
        WHERE EXISTS (SELECT 1 FROM follower_optouts fo WHERE fo.organizer_id=$1 AND LOWER(fo.email)=past.email)
          AND NOT ${connectedToTarget('past.email', 'past.user_id')}`,
      [req.organizer.id, target.id]
    );

    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      canInvite: true,
      sources: sources.map(source => ({ id: source.id, title: source.title, eventDate: source.event_date })),
      people: people.map(row => {
        const name = `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Guest';
        return {
          id: familiarFaceKey('rsvp', row.rsvp_id),
          name,
          detail: candidateDetail(row, sourceEventId),
          eventCount: row.event_count,
          avatarUrl: safeAvatarUrl(row.avatar_url),
          avatarEmoji: attendeeAvatar(`email:${row.email}`)
        };
      }),
      plusOnes: plusOnes.rows.map(row => {
        const name = `${row.guest_first_name || ''} ${row.guest_last_name || ''}`.trim();
        return {
          id: familiarFaceKey('guest', row.id),
          name,
          detail: plusOneLabel(row.host_first_name),
          avatarEmoji: attendeeAvatar(`guest:${row.id}:${name.toLowerCase()}`)
        };
      }),
      total,
      hasMore: offset + people.length < total,
      unsubscribedCount: optoutRows[0]?.n || 0
    });
  } catch (err) { next(err); }
});

// POST /api/events/:id/familiar-faces/people/invite — send to the selected
// past guests. Eligibility is rechecked here; each person's invitation names
// the past event their selected RSVP came from (one batch per source event).
router.post('/api/events/:id/familiar-faces/people/invite', async (req, res, next) => {
  const faceIds = Array.isArray(req.body?.faceIds) ? req.body.faceIds : [];
  const rsvpIds = parseFamiliarFaceIds(faceIds).rsvpIds;
  if (!rsvpIds.length) return res.status(400).json({ error: 'Choose at least one person' });
  if (rsvpIds.length > 500) return res.status(400).json({ error: 'Choose no more than 500 people at a time' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { target, canInvite } = await loadInviteTarget(client, {
      eventId: req.params.id, organizerId: req.organizer.id, lock: true
    });
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found' });
    }
    if (!canInvite) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invitations can only be sent to an upcoming published event' });
    }
    const { rows: selected } = await client.query(
      `SELECT past.* FROM (${PAST_RSVPS}) past
        WHERE past.id=ANY($3::int[])
          AND NOT EXISTS (SELECT 1 FROM follower_optouts fo WHERE fo.organizer_id=$1 AND LOWER(fo.email)=past.email)
          AND NOT ${connectedToTarget('past.email', 'past.user_id')}
        ORDER BY past.event_date DESC, past.id DESC`,
      [req.organizer.id, target.id, rsvpIds]
    );
    const byPerson = new Map();
    for (const row of selected) if (!byPerson.has(row.person_key)) byPerson.set(row.person_key, row);
    const bySource = new Map();
    for (const row of byPerson.values()) {
      if (!bySource.has(row.event_id)) bySource.set(row.event_id, { title: row.event_title, people: [] });
      bySource.get(row.event_id).people.push(row);
    }

    const batchIds = [];
    let queued = 0;
    for (const [sourceEventId, group] of bySource) {
      const { rows: batches } = await client.query(
        `INSERT INTO previous_guest_invitation_batches
           (target_event_id, source_event_id, source_event_title, recipient_count)
         VALUES ($1,$2,$3,0) RETURNING id`,
        [target.id, sourceEventId, group.title]
      );
      let batchQueued = 0;
      for (const person of group.people) {
        const name = `${person.first_name || ''} ${person.last_name || ''}`.trim() || null;
        const result = await client.query(
          `INSERT INTO message_log
             (event_id, previous_guest_invitation_batch_id, recipient, recipient_name, recipient_user_id,
              message_type, channel, status)
           VALUES ($1,$2,$3,$4,$5,'previous_guest_invite','email','pending')
           ON CONFLICT (event_id, LOWER(recipient)) WHERE message_type='previous_guest_invite'
           DO NOTHING RETURNING id`,
          [target.id, batches[0].id, person.email, name, person.user_id]
        );
        batchQueued += result.rowCount;
      }
      if (batchQueued) {
        await client.query('UPDATE previous_guest_invitation_batches SET recipient_count=$2 WHERE id=$1', [batches[0].id, batchQueued]);
        batchIds.push(batches[0].id);
        queued += batchQueued;
      } else {
        await client.query('DELETE FROM previous_guest_invitation_batches WHERE id=$1', [batches[0].id]);
      }
    }
    if (!queued) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'These people were already invited, RSVP’d, or can’t receive invitations' });
    }
    await client.query('COMMIT');
    batchIds.forEach(queuePreviousGuestInvitationBatch);
    res.status(202).json({ queued, skipped: rsvpIds.length - queued });
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
      `SELECT e.*,o.sms_credits,
              COALESCE(o.org_name,o.name,'Silver Glider Events') AS organizer_label
         FROM events e JOIN organizers o ON o.id=e.organizer_id
        WHERE e.id=$1 AND e.organizer_id=$2`,
      [req.params.id, req.organizer.id]
    );
    if (!ev.length) return res.status(404).json({ error: 'Event not found' });
    const preview = await makeFollowerAnnouncementPreview(pool, ev[0]);
    const didSendAnnouncement = Boolean(ev[0].announced_at);
    res.json({
      count: preview.count,
      emailCount: preview.emailCount,
      textCount: preview.textCount,
      textCreditCost: preview.creditCost,
      textBalance: preview.balance,
      canIncludeTexts: preview.canIncludeTexts,
      needsTextFunds: preview.needsFunds,
      fingerprint: preview.fingerprint,
      announcedAt: ev[0].announced_at,
      announcedCount: ev[0].announced_count,
      announcedTextCount: ev[0].announced_text_count,
      canAnnounce: ev[0].status === 'published' && ev[0].visibility === 'public' &&
        !didSendAnnouncement && (preview.emailCount > 0 || preview.textCount > 0)
    });
  } catch (err) { next(err); }
});

// POST /api/events/:id/announce — host-approved email + optional paid SMS update (one-shot)
router.post('/api/events/:id/announce', async (req, res, next) => {
  const client = await pool.connect();
  let event;
  let preview;
  let smsBatch = null;
  try {
    if (req.body?.confirm !== 'SEND_FOLLOWER_UPDATE') {
      return res.status(400).json({ error: 'Review and confirm the follower update before sending' });
    }
    await client.query('BEGIN');
    const { rows: ev } = await client.query(
      `SELECT e.*,o.sms_credits,
              COALESCE(o.org_name,o.name,'Silver Glider Events') AS organizer_label
         FROM events e JOIN organizers o ON o.id=e.organizer_id
        WHERE e.id=$1 AND e.organizer_id=$2 FOR UPDATE OF e,o`,
      [req.params.id, req.organizer.id]
    );
    if (!ev.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found' });
    }
    event = ev[0];

    if (event.status !== 'published') throw Object.assign(new Error('Publish the event before announcing it'), { statusCode: 400 });
    if (event.visibility !== 'public') throw Object.assign(new Error('Only public events can be announced to followers'), { statusCode: 400 });
    if (event.announced_at) throw Object.assign(new Error('This event was already announced'), { statusCode: 409 });

    preview = await makeFollowerAnnouncementPreview(client, event);
    if (String(req.body.fingerprint || '') !== preview.fingerprint) {
      throw Object.assign(new Error('The follower audience or text cost changed. Review the updated preview.'), { statusCode: 409 });
    }
    const includeTexts = req.body.includeTexts === true;
    if (!preview.emailCount && !(includeTexts && preview.textCount)) {
      throw Object.assign(new Error('No followers are eligible for this update'), { statusCode: 400 });
    }
    if (includeTexts) {
      if (!preview.canIncludeTexts) {
        const message = preview.needsFunds
          ? `Add ${preview.creditCost - preview.balance} more texting credits before sending texts.`
          : 'No followers are eligible for text updates.';
        throw Object.assign(new Error(message), { statusCode: preview.needsFunds ? 402 : 400 });
      }
      const created = await createFollowerAnnouncementBatch(client, event, preview);
      smsBatch = created.batch;
    }
    await client.query(
      `UPDATE events SET announced_at=NOW(),announced_count=0,announced_text_count=$2 WHERE id=$1`,
      [event.id, includeTexts ? preview.textCount : 0]
    );
    await client.query('COMMIT');
    if (smsBatch) queueSmsBatch(smsBatch.id);

    const organizerLabel = req.organizer.org_name || req.organizer.name || 'Silver Glider Events';
    let sent = 0;
    for (const r of preview._emails) {
      const unsubscribeUrl = `${process.env.APP_URL}/unsubscribe?token=${signOptout(req.organizer.id, r.email)}`;
      try {
        const delivery = await withActiveHostAccount(pool, event.organizer_id, () => (
          sendEventAnnouncement({
            to: r.email,
            event,
            organizerLabel,
            replyTo: req.organizer.email,
            unsubscribeUrl
          })
        ));
        if (!delivery.allowed) throw new Error(HOST_ACCOUNT_INACTIVE);
        sent++;
        await pool.query(
          `INSERT INTO message_log
             (event_id, recipient, recipient_user_id, message_type, channel, status, sent_at)
           VALUES ($1,$2,$3,'announcement','email','sent',NOW())`,
          [event.id, r.email, r.user_id]
        );
      } catch (err) {
        await pool.query(
          `INSERT INTO message_log
             (event_id, recipient, recipient_user_id, message_type, channel, status, error)
           VALUES ($1,$2,$3,'announcement','email','failed',$4)`,
          [event.id, r.email, r.user_id, err.message]
        ).catch(() => {});
      }
    }

    await pool.query('UPDATE events SET announced_count=$2 WHERE id=$1', [event.id, sent]);
    res.json({ sent, total: preview.emailCount, textsQueued: smsBatch ? preview.textCount : 0 });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof SmsCreditError || err.statusCode) {
      return res.status(err.status || err.statusCode).json({ error: err.message });
    }
    next(err);
  } finally {
    client.release();
  }
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
