const crypto = require('crypto');

const VERSION = 'v1';

function encryptionKey() {
  const secret = String(process.env.SESSION_SECRET || '').trim();
  if (!secret) throw new Error('SESSION_SECRET is required to protect durable credentials');
  return crypto.createHash('sha256')
    .update(`silver-glider:durable-secret:${secret}`)
    .digest();
}

function aadFor(purpose) {
  const value = String(purpose || '').trim();
  if (!value) throw new Error('A durable credential purpose is required');
  return Buffer.from(`silver-glider:${VERSION}:${value}`, 'utf8');
}

function sealSecret(value, purpose) {
  const plaintext = String(value || '');
  if (!plaintext) throw new Error('A durable credential value is required');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(aadFor(purpose));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'),
    ciphertext.toString('base64url')].join('.');
}

function openSecret(envelope, purpose) {
  const parts = String(envelope || '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('The durable credential envelope is invalid');
  }
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const ciphertext = Buffer.from(parts[3], 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) {
      throw new Error('invalid envelope');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    decipher.setAAD(aadFor(purpose));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (_) {
    throw new Error('The durable credential could not be opened');
  }
}

module.exports = { openSecret, sealSecret };
