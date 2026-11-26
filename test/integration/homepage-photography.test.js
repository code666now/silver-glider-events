'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const express = require('express');
const sharp = require('sharp');
const { Pool } = require('pg');

const connectionString = process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/sge_test';
if (new URL(connectionString).pathname !== '/sge_test') throw new Error('Homepage photography integration requires sge_test');
const schema = `homepage_photos_${randomBytes(10).toString('hex')}`;
const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 2_000 });
const localSchema = new URL(connectionString);
localSchema.searchParams.set('options', `-c search_path=${schema}`);
Object.assign(process.env, {
  DATABASE_URL: localSchema.href, SESSION_SECRET: 'homepage-photography-fixture-secret', NODE_ENV: 'development',
  CLOUDINARY_CLOUD_NAME: 'fixture-gallery', CLOUDINARY_API_KEY: '', CLOUDINARY_API_SECRET: ''
});
const db = require('../../src/config/db');
const cloudinary = require('../../src/lib/cloudinary');
const { signAdminSession, COOKIE_NAME } = require('../../src/lib/admin-session');
const { listActive, MAX_PHOTOS, MAX_UPLOAD_BYTES, safePhotoUrl } = require('../../src/lib/homepage-photography');
const router = require('../../src/routes/admin-homepage-photography');
const base = '/api/admin/homepage-photography';
let created = false;
let server;
let origin;
let samples = 0;
let revokedDuringUpload = false;
const cleanup = [];
const originals = { configured: cloudinary.configured, upload: cloudinary.uploadHomepagePhoto, delete: cloudinary.deleteUnattachedHomepagePhoto };
const publicId = num => `sg-events-dev/homepage-photography/${String(num).padStart(32, '0')}`;
const imageUrl = num => `https://res.cloudinary.com/fixture-gallery/image/upload/v1/${publicId(num)}.webp`;
const operatorCookie = id => `${COOKIE_NAME}=${signAdminSession(id)}`;
const newImage = async (input = sharp({ create: { width: 80, height: 56, channels: 3, background: 'tomato' } })) => input.jpeg().toBuffer();

test.before(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  assert.equal((await db.query('SELECT current_schema() AS active')).rows[0].active, schema);
  await db.query(`CREATE TABLE admin_operators(id integer PRIMARY KEY,email text,role text,status text,
      sessions_valid_after timestamptz,last_login_at timestamptz,created_at timestamptz,updated_at timestamptz);
    INSERT INTO admin_operators(id,email,role,status) VALUES
      (1,'super@example.test','super_admin','active'),(2,'support@example.test','support','active');
    CREATE TABLE admin_account_audit_log(id int GENERATED ALWAYS AS IDENTITY,actor_admin_operator_id int REFERENCES admin_operators(id),
      action_type text,reason text,before_state jsonb,after_state jsonb);`);
  await db.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/096_homepage_photography.sql'), 'utf8'));
  await db.query(`INSERT INTO homepage_photos(title,alt_text,credit,active,image_url,width,height,sort_order) VALUES
    ('Built in','A shadowed room','House photographer',true,'/images/homepage-photography/room.webp',100,60,0),
    ('Off','A street at night','',false,'/images/homepage-photography/night.webp',100,60,1)`);
  cloudinary.configured = true;
  cloudinary.uploadHomepagePhoto = async buffer => {
    const photo = await sharp(buffer).metadata();
    assert.equal(photo.format, 'webp');
    assert.equal(photo.exif, undefined);
    if (revokedDuringUpload) await db.query(`UPDATE admin_operators SET sessions_valid_after=NOW()+interval '1 hour' WHERE id=1`);
    const n = ++samples;
    return { public_id: publicId(n), secure_url: imageUrl(n) };
  };
  cloudinary.deleteUnattachedHomepagePhoto = async id => { cleanup.push(id); };
  const app = express();
  app.use(express.json(), router);
  server = await new Promise((resolve, reject) => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
    running.on('error', reject);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  cloudinary.configured = originals.configured;
  cloudinary.uploadHomepagePhoto = originals.upload;
  cloudinary.deleteUnattachedHomepagePhoto = originals.delete;
  if (server) await new Promise(resolve => server.close(resolve));
  await db.end();
  try { if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
  finally { await admin.end(); }
});

function call(suffix = '', { method = 'GET', cookie, body, cross = false } = {}) {
  const headers = { 'sec-fetch-site': cross ? 'cross-site' : 'same-origin' };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  return fetch(`${origin}${base}${suffix}`, { method, headers, body: body instanceof FormData ? body : JSON.stringify(body) });
}

function upload(buffer, fields) {
  const form = new FormData();
  form.set('image', new Blob([buffer], { type: 'image/jpeg' }), 'fixture.jpg');
  for (const [name, value] of Object.entries(fields || {})) form.set(name, value);
  return form;
}

test('gallery accepts only the first-party image folder and its dedicated Cloudinary URL', () => {
  assert.equal(safePhotoUrl('/images/homepage-photography/scene.webp', null), '/images/homepage-photography/scene.webp');
  assert.equal(safePhotoUrl(imageUrl(1), publicId(1)), imageUrl(1));
  for (const url of ['https://outside.example/file.jpg', 'javascript:alert(1)', '//outside.example/pic.jpg',
    '/images/homepage-photography/../../logo.png', '/images/homepage-photography/scene.webp?test',
    imageUrl(1).replace('https:', 'http:'), imageUrl(1).replace('res.cloudinary.com', 'res.cloudinary.com.evil'),
    imageUrl(1).replace('fixture-gallery', 'different-cloud'), imageUrl(1).replace('/image/upload/', '/video/upload/'),
    imageUrl(1).replace('homepage-photography', 'covers'), imageUrl(1).replace('v1/', 'c_crop/v1/'),
    imageUrl(1).replace('v1/', 'v1/skip/../'), `${imageUrl(1)}#ignore`]) {
    assert.equal(safePhotoUrl(url, publicId(1)), '', url);
  }
  assert.equal(safePhotoUrl(imageUrl(1), publicId(2)), '');
});

test('dedicated Super Admins can upload, replace, reorder, credit, hide and remove photos without exposing untrusted images', async () => {
  const superCookie = operatorCookie(1);
  const supportCookie = operatorCookie(2);
  const request = (suffix, method = 'GET', body) => call(suffix, { cookie: superCookie, method, body });
  assert.equal((await call()).status, 401);
  assert.equal((await call('', { cookie: supportCookie })).status, 403);
  assert.equal((await call('/1', { cookie: superCookie, method: 'PATCH', body: { active: false }, cross: true })).status, 403);
  const list = await request('');
  assert.match(list.headers.get('cache-control'), /no-store/);
  const settings = await list.json();
  assert.deepEqual([settings.uploadsEnabled, settings.maxPhotos, settings.maxUploadBytes], [true, MAX_PHOTOS, MAX_UPLOAD_BYTES]);
  assert.deepEqual(settings.photos.map(item => [item.title, item.altText, item.credit, item.active]),
    [['Built in', 'A shadowed room', 'House photographer', true], ['Off', 'A street at night', '', false]]);
  assert.deepEqual((await listActive()).map(item => item.id), [1]);

  const fields = { title: ' New photo ', altText: ' Warm lights ', credit: ' Studio Example ', active: 'true' };
  assert.equal((await request('', 'POST', upload(Buffer.from('<svg></svg>'), fields))).status, 400);
  assert.equal(samples, 0);
  assert.equal((await request('', 'POST', upload(await newImage(), { ...fields, title: '' }))).status, 400);
  assert.equal(samples, 0);
  const initial = await request('', 'POST', upload(await newImage(), fields));
  assert.equal(initial.status, 201);
  const { photo } = await initial.json();
  assert.deepEqual(photo, { id: 3, title: 'New photo', altText: 'Warm lights', credit: 'Studio Example', active: true,
    imageUrl: imageUrl(1), width: 80, height: 56, sortOrder: 2 });
  assert.equal((await request('/3', 'PATCH', { imageUrl: 'https://outside.example/' })).status, 400);
  assert.equal((await request('/3', 'PATCH', { active: 'true' })).status, 400);
  const edit = await request('/3', 'PATCH', { credit: 'New Credit', active: false });
  assert.equal((await edit.json()).photo.credit, 'New Credit');
  assert.deepEqual((await listActive()).map(row => row.id), [1]);

  const replacement = await request('/3/image', 'POST', upload(await newImage()));
  assert.equal(replacement.status, 200);
  assert.deepEqual((await replacement.json()).photo, { ...photo, active: false, credit: 'New Credit', imageUrl: imageUrl(2) });
  assert.deepEqual(cleanup, [], 'changing a gallery link leaves the old original recoverable');
  assert.equal((await request('/order', 'PUT', { ids: [3, 1] })).status, 409);
  assert.equal((await request('/order', 'PUT', { ids: [3, 1, 1] })).status, 400);
  const reordered = await request('/order', 'PUT', { ids: [3, 2, 1] });
  assert.deepEqual((await reordered.json()).photos.map(row => [row.id, row.sortOrder]), [[3, 0], [2, 1], [1, 2]]);
  assert.equal((await request('/3', 'PATCH', { active: true })).status, 200);
  assert.deepEqual((await listActive()).map(row => row.id), [3, 1]);
  assert.equal((await request('/1', 'DELETE')).status, 204);
  assert.equal((await request('/1', 'DELETE')).status, 404);
  assert.deepEqual((await listActive()).map(row => row.id), [3]);
  const actions = (await db.query('SELECT actor_admin_operator_id,action_type FROM admin_account_audit_log ORDER BY id')).rows;
  assert.deepEqual(actions.map(row => row.action_type), ['homepage_photo_created', 'homepage_photo_updated', 'homepage_photo_replaced',
    'homepage_photos_reordered', 'homepage_photo_updated', 'homepage_photo_removed']);
  assert.ok(actions.every(row => row.actor_admin_operator_id === 1));
});

test('the upload path caps gallery size and a revoked operator cannot attach a photo uploaded in flight', async () => {
  const cookie = operatorCookie(1);
  await db.query(`INSERT INTO homepage_photos(title,alt_text,image_url,width,height,sort_order,active)
    SELECT 'Extra','Extra','/images/homepage-photography/extra-' || n || '.webp',10,10,100+n,false
    FROM generate_series(1,$1) AS t(n)`, [MAX_PHOTOS - 2]);
  const form = upload(await newImage(), { title: 'Cap', altText: 'Test image' });
  assert.equal((await call('', { method: 'POST', cookie, body: form })).status, 409);
  assert.equal(samples, 2);
  revokedDuringUpload = true;
  const rejected = await call('/3/image', { method: 'POST', cookie, body: upload(await newImage()) });
  assert.equal(rejected.status, 403);
  assert.deepEqual(cleanup, [publicId(3)]);
  assert.equal((await listActive())[0].imageUrl, imageUrl(2));
  assert.equal((await call('', { method: 'GET', cookie })).status, 401);
});
