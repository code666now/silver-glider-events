'use strict';

const pool = require('../config/db');
const cloudinary = require('./cloudinary');
const { normalizeImageUpload } = require('./image-upload');

const MAX_PHOTOS = 12;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const ROOT_IMAGE = /^\/images\/homepage-photography\/[a-z0-9_-]+\.(?:webp|avif|jpg|png)$/;
const PHOTO_FIELDS = ['title', 'altText', 'credit', 'active'];
const SELECT_COLUMNS = 'id,title,alt_text,credit,image_url,width,height,cloudinary_public_id,sort_order,active';
const VALID_ID = value => Number.isInteger(value) && value >= 1 && value <= 2147483647;

class HomepagePhotographyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function safePhotoUrl(url, publicId, images = cloudinary) {
  if (typeof url !== 'string' || url.length > 600) return '';
  if (ROOT_IMAGE.test(url) && publicId == null) return url;
  if (typeof publicId !== 'string' || !publicId) return '';
  return images.homepagePhotoPublicIdFromUrl(url) === publicId ? url : '';
}

function photoFields(payload, { create = false } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !PHOTO_FIELDS.includes(key))) {
    throw new HomepagePhotographyError(400, 'invalid_photo_fields', 'Use only title, description, credit and visibility.');
  }
  const result = {};
  const field = (key, label, limit, required, fallback = '') => {
    if (!create && !Object.hasOwn(payload, key)) return;
    const value = Object.hasOwn(payload, key) ? payload[key] : fallback;
    const clean = typeof value === 'string' ? value.trim() : null;
    if (clean == null || clean.length > limit || /[\u0000-\u001f\u007f]/.test(clean) || (required && !clean)) {
      throw new HomepagePhotographyError(400, 'invalid_photo_fields', `${label} ${required ? 'is required and ' : ''}must be ${limit} characters or fewer.`);
    }
    result[key] = clean;
  };
  field('title', 'A title', 100, true);
  field('altText', 'An image description', 180, true);
  field('credit', 'Photographer credit', 120, false);
  if (create || Object.hasOwn(payload, 'active')) {
    const active = Object.hasOwn(payload, 'active') ? payload.active : true;
    if (typeof active !== 'boolean' && !(create && (active === 'true' || active === 'false'))) {
      throw new HomepagePhotographyError(400, 'invalid_photo_fields', 'Choose whether this photo is visible.');
    }
    result.active = active === true || active === 'true';
  }
  if (!Object.keys(result).length) throw new HomepagePhotographyError(400, 'invalid_photo_fields', 'Choose a photo detail to update.');
  return result;
}

function dto(row, images) {
  return {
    id: row.id, title: row.title, altText: row.alt_text, credit: row.credit,
    imageUrl: safePhotoUrl(row.image_url, row.cloudinary_public_id, images), width: row.width, height: row.height,
    sortOrder: row.sort_order, active: row.active
  };
}

function parsedPhotoId(value) {
  return typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) && VALID_ID(Number(value)) ? Number(value) : null;
}

function missing() { return new HomepagePhotographyError(404, 'photo_not_found', 'This photo is no longer available.'); }
function capacity() { return new HomepagePhotographyError(409, 'photo_limit', `The homepage gallery holds up to ${MAX_PHOTOS} photos. Remove one before adding another.`); }
function staleOrder() { return new HomepagePhotographyError(409, 'photo_order_changed', 'The gallery has changed. Refresh the list and try again.'); }

function createHomepagePhotographyStore({ db = pool, images = cloudinary } = {}) {
  async function locked(actor, callback) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows: [operator] } = await client.query('SELECT id,role,status,sessions_valid_after FROM admin_operators WHERE id=$1 FOR SHARE', [actor?.operatorId]);
      if (!operator || operator.role !== 'super_admin' || operator.status !== 'active' ||
          !Number.isSafeInteger(actor?.issuedAt) || actor.issuedAt <= 0 ||
          (operator.sessions_valid_after && actor.issuedAt < new Date(operator.sessions_valid_after).getTime())) {
        throw new HomepagePhotographyError(403, 'super_admin_required', 'Sign in again as a Super Admin.');
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['homepage-photography-maintenance-v1']);
      const result = await callback(client, operator.id);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async function audit(client, actorId, action, before = {}, after = {}) {
    await client.query(`INSERT INTO admin_account_audit_log(actor_admin_operator_id,action_type,reason,before_state,after_state)
      VALUES ($1,$2,'Updated the homepage photography gallery',$3::jsonb,$4::jsonb)`, [actorId, action, JSON.stringify(before), JSON.stringify(after)]);
  }

  async function rowFor(connection, id) {
    if (!VALID_ID(id)) throw missing();
    const { rows: [row] } = await connection.query(`SELECT ${SELECT_COLUMNS} FROM homepage_photos WHERE id=$1`, [id]);
    if (!row) throw missing();
    return row;
  }

  async function rowsFor(connection, activeOnly = false) {
    const { rows } = await connection.query(`SELECT ${SELECT_COLUMNS} FROM homepage_photos ${activeOnly ? 'WHERE active' : ''} ORDER BY sort_order ASC,id ASC`);
    return rows;
  }

  async function upload(buffer) {
    if (!images.configured) throw new HomepagePhotographyError(503, 'uploads_unavailable', 'Photo uploads are not set up yet.');
    const image = await normalizeImageUpload(buffer, { allowedFormats: ['jpeg', 'png', 'webp'], maxInputBytes: MAX_UPLOAD_BYTES,
      maxOutputBytes: 3 * 1024 * 1024, maxWidth: 2400, maxHeight: 2400, maxPixels: 40_000_000, maxFrames: 1, maxTotalPixels: 40_000_000 });
    let returned;
    try { returned = await images.uploadHomepagePhoto(image.buffer); } catch {
      throw new HomepagePhotographyError(502, 'photo_upload_failed', 'Couldn’t upload this photo. Try again.');
    }
    const { public_id: publicId, secure_url: url } = returned || {};
    if (!publicId || !safePhotoUrl(url, publicId, images)) {
      throw new HomepagePhotographyError(502, 'photo_upload_failed', 'The image service did not return a valid homepage photo.');
    }
    return { publicId, url, width: image.width, height: image.height };
  }

  async function cleanup(publicId) {
    try {
      const { rowCount } = await db.query('SELECT 1 FROM homepage_photos WHERE cloudinary_public_id=$1', [publicId]);
      // A lost COMMIT reply can be ambiguous. Keep the asset if the DB is
      // unreachable or a committed row now uses it. Never delete old assets.
      if (rowCount === 0) await images.deleteUnattachedHomepagePhoto(publicId);
    } catch { /* Failed cleanup must not conceal the save error. */ }
  }

  return {
    async listActive() { return (await rowsFor(db, true)).map(row => dto(row, images)).filter(photo => photo.imageUrl); },
    async listAll() { return (await rowsFor(db)).map(row => dto(row, images)); },
    async create(buffer, payload, actor) {
      const fields = photoFields(payload, { create: true });
      if ((await rowsFor(db)).length >= MAX_PHOTOS) throw capacity();
      const asset = await upload(buffer);
      try {
        return await locked(actor, async (client, actorId) => {
          const rows = await rowsFor(client);
          if (rows.length >= MAX_PHOTOS) throw capacity();
          const order = rows.length ? rows.at(-1).sort_order + 1 : 0;
          const { rows: [row] } = await client.query(`INSERT INTO homepage_photos(title,alt_text,credit,active,image_url,width,height,cloudinary_public_id,sort_order)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${SELECT_COLUMNS}`,
          [fields.title, fields.altText, fields.credit, fields.active, asset.url, asset.width, asset.height, asset.publicId, order]);
          const photo = dto(row, images);
          await audit(client, actorId, 'homepage_photo_created', {}, { photo });
          return photo;
        });
      } catch (error) {
        await cleanup(asset.publicId);
        throw error;
      }
    },
    async update(id, payload, actor) {
      const fields = photoFields(payload);
      return locked(actor, async (client, actorId) => {
        const before = dto(await rowFor(client, id), images);
        if (Object.entries(fields).every(([key, value]) => before[key] === value)) return before;
        const values = { ...before, ...fields };
        const { rows: [row] } = await client.query(`UPDATE homepage_photos SET title=$2,alt_text=$3,credit=$4,active=$5,updated_at=NOW()
          WHERE id=$1 RETURNING ${SELECT_COLUMNS}`, [id, values.title, values.altText, values.credit, values.active]);
        const photo = dto(row, images);
        await audit(client, actorId, 'homepage_photo_updated', { photo: before }, { photo });
        return photo;
      });
    },
    async replace(id, buffer, actor) {
      await rowFor(db, id);
      const asset = await upload(buffer);
      try {
        return await locked(actor, async (client, actorId) => {
          const before = dto(await rowFor(client, id), images);
          const { rows: [row] } = await client.query(`UPDATE homepage_photos SET image_url=$2,width=$3,height=$4,cloudinary_public_id=$5,updated_at=NOW()
            WHERE id=$1 RETURNING ${SELECT_COLUMNS}`, [id, asset.url, asset.width, asset.height, asset.publicId]);
          const photo = dto(row, images);
          await audit(client, actorId, 'homepage_photo_replaced', { photo: before }, { photo });
          return photo;
        });
      } catch (error) {
        await cleanup(asset.publicId);
        throw error;
      }
    },
    async reorder(ids, actor) {
      if (!Array.isArray(ids) || ids.length > MAX_PHOTOS || !ids.every(VALID_ID) || new Set(ids).size !== ids.length) {
        throw new HomepagePhotographyError(400, 'invalid_photo_order', 'Include each photo once in the new order.');
      }
      return locked(actor, async (client, actorId) => {
        const rows = await rowsFor(client);
        const previous = rows.map(row => row.id);
        const requested = new Set(ids);
        if (previous.length !== ids.length || previous.some(id => !requested.has(id))) throw staleOrder();
        if (previous.every((id, index) => id === ids[index])) return rows.map(row => dto(row, images));
        await client.query(`UPDATE homepage_photos p SET sort_order=(requested.ord-1)::int,updated_at=NOW()
          FROM unnest($1::int[]) WITH ORDINALITY AS requested(id,ord) WHERE p.id=requested.id`, [ids]);
        await audit(client, actorId, 'homepage_photos_reordered', { ids: previous }, { ids });
        return (await rowsFor(client)).map(row => dto(row, images));
      });
    },
    async remove(id, actor) {
      await locked(actor, async (client, actorId) => {
        const before = dto(await rowFor(client, id), images);
        await client.query('DELETE FROM homepage_photos WHERE id=$1', [id]);
        await audit(client, actorId, 'homepage_photo_removed', { photo: before });
      });
    }
  };
}

const listActive = ({ db = pool } = {}) => createHomepagePhotographyStore({ db }).listActive();
module.exports = { createHomepagePhotographyStore, HomepagePhotographyError, parsedPhotoId, safePhotoUrl, listActive, MAX_PHOTOS, MAX_UPLOAD_BYTES };
