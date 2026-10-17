const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PNG } = require('pngjs');
const sharp = require('sharp');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'image-security-test-secret';

const { ImageUploadError, normalizeImageUpload } = require('../src/lib/image-upload');
const securityTraffic = require('../src/middleware/securityTraffic');

function png(width, height) {
  const image = new PNG({ width, height });
  image.data.fill(180);
  return PNG.sync.write(image);
}

test('uploaded images are decoded, bounded, stripped, and re-encoded as WebP', async () => {
  const normalized = await normalizeImageUpload(png(20, 10), {
    maxWidth: 12,
    maxHeight: 12
  });
  const metadata = await sharp(normalized.buffer).metadata();
  assert.equal(normalized.mimeType, 'image/webp');
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 12);
  assert.equal(metadata.height, 6);
});

test('image validation rejects MIME-spoofed bytes, unsupported formats, and pixel bombs', async () => {
  await assert.rejects(
    normalizeImageUpload(Buffer.from('not actually an image')),
    error => error instanceof ImageUploadError && error.code === 'invalid_image'
  );
  await assert.rejects(
    normalizeImageUpload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')),
    error => error instanceof ImageUploadError && error.code === 'invalid_image'
  );
  await assert.rejects(
    normalizeImageUpload(png(20, 20), { maxPixels: 100, maxTotalPixels: 1000 }),
    error => error instanceof ImageUploadError && error.code === 'image_dimensions_too_large'
  );
});

test('security traffic logging records useful outcomes without paths, tokens, or PII', () => {
  const response = new EventEmitter();
  response.statusCode = 429;
  const request = {
    method: 'POST',
    path: '/api/public/photo-collections/private-token-value',
    ip: '203.0.113.10',
    get(name) { return name.toLowerCase() === 'x-forwarded-for' ? '203.0.113.10' : undefined; }
  };
  const messages = [];
  const original = console.info;
  console.info = (...parts) => messages.push(parts.join(' '));
  try {
    let continued = false;
    securityTraffic(request, response, () => { continued = true; });
    assert.equal(continued, true);
    response.emit('finish');
  } finally {
    console.info = original;
  }
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^\[security-traffic\] /);
  assert.match(messages[0], /"category":"upload"/);
  assert.match(messages[0], /"outcome":"rate_limited"/);
  assert.doesNotMatch(messages[0], /private-token-value|203\.0\.113\.10/);
});
