const pool = require('../config/db');
const cloudinary = require('./cloudinary');

// Emergency moderation (V1). Super Admins can take an image off the public
// internet or hide an event, and undo either. Records, RSVPs and the image
// file itself are always kept, so every action is reversible and audited.

const IMAGE_FIELDS = Object.freeze([
  { field: 'cover_image_url', label: 'Cover image' },
  { field: 'flyer_image_url', label: 'Flyer' },
  { field: 'event_vibe_image_url', label: 'Artist photo 1' },
  { field: 'event_vibe_image_url_2', label: 'Artist photo 2' },
  { field: 'event_vibe_image_url_3', label: 'Artist photo 3' }
]);
const FIELD_NAMES = IMAGE_FIELDS.map(item => item.field);
const HIDEABLE_STATUSES = new Set(['published', 'cancelled']);

let storage = {
  publicIdFromUrl: cloudinary.managedPublicIdFromUrl,
  setDelivery: cloudinary.setManagedImageDelivery
};

class ModerationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function cleanReason(value) {
  const reason = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (reason.length < 3) throw new ModerationError('reason_required', 'Add a short reason (at least 3 characters).');
  return reason.slice(0, 500);
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function audit(db, { eventId, action, field = null, url = null, removalId = null, reason = null, operatorId }) {
  await db.query(
    `INSERT INTO event_moderation_actions (event_id,action,image_field,image_url,removal_id,reason,admin_operator_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [eventId, action, field, url, removalId, reason, operatorId]
  );
}

// Moves the file in Cloudinary and records the outcome. A failure leaves the
// page clean (the link was already cleared) and is shown to the admin to retry.
async function moveToPrivate(removalId, publicId) {
  try {
    await storage.setDelivery(publicId, 'private');
    await pool.query(
      `UPDATE event_image_removals SET storage_state='private', storage_error=NULL WHERE id=$1 AND restored_at IS NULL`,
      [removalId]
    );
    return 'private';
  } catch (error) {
    const message = String(error?.message || error || 'Image storage failed').slice(0, 300);
    console.error(`[moderation] removal ${removalId}: image is still publicly reachable:`, message);
    await pool.query(
      `UPDATE event_image_removals SET storage_state='failed', storage_error=$2 WHERE id=$1 AND restored_at IS NULL`,
      [removalId, message]
    );
    return 'failed';
  }
}

async function removeImage({ eventId, field, reason, operatorId }) {
  const id = positiveId(eventId);
  if (!id) throw new ModerationError('event_not_found', 'Event not found', 404);
  if (!FIELD_NAMES.includes(field)) throw new ModerationError('invalid_image', 'Choose an image on this event.');
  const why = cleanReason(reason);

  const removal = await withTransaction(async db => {
    const { rows } = await db.query(`SELECT id, ${field} AS url FROM events WHERE id=$1 FOR UPDATE`, [id]);
    if (!rows.length) throw new ModerationError('event_not_found', 'Event not found', 404);
    const url = rows[0].url;
    if (!url) throw new ModerationError('no_image', 'That image has already been removed or replaced.', 409);
    const publicId = storage.publicIdFromUrl(url) || null;

    // Duplicated events share image files. Clear the file from every event
    // that shows it, since hiding the file breaks it everywhere anyway.
    const matchSql = FIELD_NAMES.map(name => `${name}=$1${publicId ? ` OR POSITION($2 IN COALESCE(${name},''))>0` : ''}`).join(' OR ');
    const candidates = await db.query(
      `SELECT id, ${FIELD_NAMES.join(', ')} FROM events WHERE ${matchSql} ORDER BY id FOR UPDATE`,
      publicId ? [url, publicId] : [url]
    );
    const refs = [];
    for (const event of candidates.rows) {
      for (const name of FIELD_NAMES) {
        const value = event[name];
        if (!value) continue;
        const same = value === url || (publicId && storage.publicIdFromUrl(value) === publicId);
        if (same) refs.push({ eventId: Number(event.id), field: name, url: value });
      }
    }

    let inserted;
    try {
      inserted = await db.query(
        `INSERT INTO event_image_removals
           (event_id,image_field,image_url,cloudinary_public_id,storage_state,reason,removed_by_admin_operator_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [id, field, url, publicId, publicId ? 'pending' : 'not_applicable', why, operatorId]
      );
    } catch (error) {
      if (error.code === '23505') throw new ModerationError('already_removed', 'This image is already removed.', 409);
      throw error;
    }
    const removalId = Number(inserted.rows[0].id);
    for (const ref of refs) {
      await db.query(`UPDATE events SET ${ref.field}=NULL, updated_at=NOW() WHERE id=$1`, [ref.eventId]);
      await db.query(
        `INSERT INTO event_image_removal_refs (removal_id,event_id,image_field,image_url) VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING`,
        [removalId, ref.eventId, ref.field, ref.url]
      );
    }
    await audit(db, { eventId: id, action: 'remove_image', field, url, removalId, reason: why, operatorId });
    return { removalId, publicId, affectedEvents: new Set(refs.map(ref => ref.eventId)).size };
  });

  const storageState = removal.publicId ? await moveToPrivate(removal.removalId, removal.publicId) : 'not_applicable';
  return { removalId: removal.removalId, affectedEvents: removal.affectedEvents, storageState };
}

async function retryImageRemoval({ removalId, operatorId }) {
  const id = positiveId(removalId);
  const { rows } = await pool.query(
    'SELECT id,event_id,image_field,image_url,cloudinary_public_id,storage_state,restored_at FROM event_image_removals WHERE id=$1',
    [id]
  );
  const removal = rows[0];
  if (!removal) throw new ModerationError('removal_not_found', 'Removal not found', 404);
  if (removal.restored_at) throw new ModerationError('already_restored', 'This image was restored.', 409);
  if (!removal.cloudinary_public_id || removal.storage_state === 'private') {
    return { removalId: id, storageState: removal.storage_state };
  }
  const storageState = await moveToPrivate(id, removal.cloudinary_public_id);
  await audit(pool, {
    eventId: removal.event_id, action: 'retry_image', field: removal.image_field,
    url: removal.image_url, removalId: id, operatorId
  });
  return { removalId: id, storageState };
}

async function restoreImage({ removalId, operatorId }) {
  const id = positiveId(removalId);
  const { rows } = await pool.query(
    'SELECT id,event_id,image_field,image_url,cloudinary_public_id,storage_state,restored_at FROM event_image_removals WHERE id=$1',
    [id]
  );
  const removal = rows[0];
  if (!removal) throw new ModerationError('removal_not_found', 'Removal not found', 404);
  if (removal.restored_at) throw new ModerationError('already_restored', 'This image was already restored.', 409);

  // Make the file public again first: if that fails nothing else changes.
  if (removal.cloudinary_public_id && removal.storage_state !== 'not_applicable') {
    await storage.setDelivery(removal.cloudinary_public_id, 'public');
  }

  return withTransaction(async db => {
    const locked = await db.query('SELECT restored_at FROM event_image_removals WHERE id=$1 FOR UPDATE', [id]);
    if (locked.rows[0]?.restored_at) throw new ModerationError('already_restored', 'This image was already restored.', 409);
    const refs = await db.query(
      'SELECT event_id,image_field,image_url FROM event_image_removal_refs WHERE removal_id=$1 ORDER BY event_id',
      [id]
    );
    let restored = 0;
    for (const ref of refs.rows) {
      if (!FIELD_NAMES.includes(ref.image_field)) continue;
      // Never overwrite a replacement the organizer has uploaded since.
      const result = await db.query(
        `UPDATE events SET ${ref.image_field}=$2, updated_at=NOW()
          WHERE id=$1 AND ${ref.image_field} IS NULL`,
        [ref.event_id, ref.image_url]
      );
      restored += result.rowCount;
    }
    await db.query(
      `UPDATE event_image_removals
          SET restored_at=NOW(), restored_by_admin_operator_id=$2,
              storage_state=CASE WHEN cloudinary_public_id IS NULL THEN storage_state ELSE 'public' END,
              storage_error=NULL
        WHERE id=$1`,
      [id, operatorId]
    );
    await audit(db, {
      eventId: removal.event_id, action: 'restore_image', field: removal.image_field,
      url: removal.image_url, removalId: id, operatorId
    });
    return { removalId: id, restoredPlaces: restored };
  });
}

async function hideEvent({ eventId, reason, operatorId }) {
  const id = positiveId(eventId);
  if (!id) throw new ModerationError('event_not_found', 'Event not found', 404);
  const why = cleanReason(reason);
  return withTransaction(async db => {
    const { rows } = await db.query('SELECT status FROM events WHERE id=$1 FOR UPDATE', [id]);
    if (!rows.length) throw new ModerationError('event_not_found', 'Event not found', 404);
    if (rows[0].status === 'hidden') throw new ModerationError('already_hidden', 'This event is already hidden.', 409);
    if (!HIDEABLE_STATUSES.has(rows[0].status)) {
      throw new ModerationError('not_public', 'Only a published or cancelled event can be hidden.', 409);
    }
    await db.query(
      `UPDATE events
          SET hidden_previous_status=status, status='hidden', hidden_at=NOW(),
              hidden_reason=$2, hidden_by_admin_operator_id=$3, updated_at=NOW()
        WHERE id=$1`,
      [id, why, operatorId]
    );
    await audit(db, { eventId: id, action: 'hide_event', reason: why, operatorId });
    return { eventId: id, status: 'hidden' };
  });
}

async function unhideEvent({ eventId, reason, operatorId }) {
  const id = positiveId(eventId);
  if (!id) throw new ModerationError('event_not_found', 'Event not found', 404);
  const why = String(reason ?? '').trim().replace(/\s+/g, ' ').slice(0, 500) || null;
  return withTransaction(async db => {
    const { rows } = await db.query('SELECT status,hidden_previous_status FROM events WHERE id=$1 FOR UPDATE', [id]);
    if (!rows.length) throw new ModerationError('event_not_found', 'Event not found', 404);
    if (rows[0].status !== 'hidden') throw new ModerationError('not_hidden', 'This event is not hidden.', 409);
    const restoredStatus = HIDEABLE_STATUSES.has(rows[0].hidden_previous_status) ? rows[0].hidden_previous_status : 'published';
    await db.query(
      `UPDATE events
          SET status=$2, hidden_at=NULL, hidden_previous_status=NULL, hidden_reason=NULL,
              hidden_by_admin_operator_id=NULL, updated_at=NOW()
        WHERE id=$1`,
      [id, restoredStatus]
    );
    await audit(db, { eventId: id, action: 'unhide_event', reason: why, operatorId });
    return { eventId: id, status: restoredStatus };
  });
}

// Everything the admin panel needs for one event.
async function moderationState(eventId) {
  const id = positiveId(eventId);
  const { rows } = await pool.query(
    `SELECT e.id, e.title, e.slug, e.status, e.hidden_at, e.hidden_reason, e.hidden_previous_status,
            hider.email AS hidden_by, ${FIELD_NAMES.map(name => `e.${name}`).join(', ')}
       FROM events e
       LEFT JOIN admin_operators hider ON hider.id=e.hidden_by_admin_operator_id
      WHERE e.id=$1`,
    [id]
  );
  if (!rows.length) throw new ModerationError('event_not_found', 'Event not found', 404);
  const event = rows[0];
  const removals = await pool.query(
    `SELECT removal.id, removal.image_field, removal.image_url, removal.storage_state, removal.storage_error,
            removal.reason, removal.removed_at, remover.email AS removed_by,
            removal.restored_at, restorer.email AS restored_by,
            (SELECT COUNT(DISTINCT ref.event_id)::int FROM event_image_removal_refs ref WHERE ref.removal_id=removal.id) AS event_count
       FROM event_image_removals removal
       LEFT JOIN admin_operators remover ON remover.id=removal.removed_by_admin_operator_id
       LEFT JOIN admin_operators restorer ON restorer.id=removal.restored_by_admin_operator_id
      WHERE removal.id IN (SELECT removal_id FROM event_image_removal_refs WHERE event_id=$1)
         OR removal.event_id=$1
      ORDER BY removal.removed_at DESC
      LIMIT 30`,
    [id]
  );
  const history = await pool.query(
    `SELECT action.action, action.image_field, action.reason, action.created_at, operator.email AS admin
       FROM event_moderation_actions action
       LEFT JOIN admin_operators operator ON operator.id=action.admin_operator_id
      WHERE action.event_id=$1
      ORDER BY action.created_at DESC, action.id DESC
      LIMIT 30`,
    [id]
  );
  const label = field => IMAGE_FIELDS.find(item => item.field === field)?.label || 'Image';
  return {
    event: {
      id: Number(event.id),
      title: event.title,
      slug: event.slug,
      status: event.status,
      hidden: event.status === 'hidden',
      hiddenAt: event.hidden_at,
      hiddenReason: event.hidden_reason,
      hiddenBy: event.hidden_by,
      statusWhenUnhidden: event.hidden_previous_status
    },
    images: IMAGE_FIELDS.filter(item => event[item.field]).map(item => ({
      field: item.field, label: item.label, url: event[item.field]
    })),
    removals: removals.rows.map(row => ({
      id: Number(row.id),
      field: row.image_field,
      label: label(row.image_field),
      url: row.image_url,
      storageState: row.storage_state,
      storageError: row.storage_error,
      reason: row.reason,
      removedAt: row.removed_at,
      removedBy: row.removed_by,
      restoredAt: row.restored_at,
      restoredBy: row.restored_by,
      eventCount: Number(row.event_count || 0)
    })),
    history: history.rows.map(row => ({
      action: row.action,
      label: row.image_field ? label(row.image_field) : null,
      reason: row.reason,
      at: row.created_at,
      admin: row.admin
    }))
  };
}

// What the organizer is told on their own manage page. Never the reason.
async function organizerModerationNotice(db, eventId) {
  const { rows } = await db.query(
    `SELECT e.status='hidden' AS hidden,
            EXISTS (
              SELECT 1 FROM event_image_removal_refs ref
                JOIN event_image_removals removal ON removal.id=ref.removal_id
               WHERE ref.event_id=e.id AND removal.restored_at IS NULL
                 AND CASE ref.image_field
                       WHEN 'cover_image_url' THEN e.cover_image_url
                       WHEN 'flyer_image_url' THEN e.flyer_image_url
                       WHEN 'event_vibe_image_url' THEN e.event_vibe_image_url
                       WHEN 'event_vibe_image_url_2' THEN e.event_vibe_image_url_2
                       WHEN 'event_vibe_image_url_3' THEN e.event_vibe_image_url_3
                     END IS NULL
            ) AS image_removed
       FROM events e WHERE e.id=$1`,
    [eventId]
  );
  return { hidden: Boolean(rows[0]?.hidden), imageRemoved: Boolean(rows[0]?.image_removed) };
}

function setModerationStorageForTests(overrides = null) {
  storage = overrides
    ? { ...storage, ...overrides }
    : { publicIdFromUrl: cloudinary.managedPublicIdFromUrl, setDelivery: cloudinary.setManagedImageDelivery };
}

module.exports = {
  IMAGE_FIELDS,
  ModerationError,
  removeImage,
  retryImageRemoval,
  restoreImage,
  hideEvent,
  unhideEvent,
  moderationState,
  organizerModerationNotice,
  setModerationStorageForTests
};
