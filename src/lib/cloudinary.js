const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');
const { randomBytes } = require('node:crypto');

const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
const configured = !!(cloudName && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
const coverFolder = process.env.CLOUDINARY_COVER_FOLDER ||
  (process.env.NODE_ENV === 'production' ? 'sg-events/covers' : 'sg-events-dev/covers');
const flyerFolder = process.env.CLOUDINARY_FLYER_FOLDER ||
  (process.env.NODE_ENV === 'production' ? 'sg-events/flyers' : 'sg-events-dev/flyers');
const hostLogoFolder = process.env.CLOUDINARY_HOST_LOGO_FOLDER ||
  (process.env.NODE_ENV === 'production' ? 'sg-events/hosts' : 'sg-events-dev/hosts');
const hostHeaderFolder = process.env.CLOUDINARY_HOST_HEADER_FOLDER ||
  (process.env.NODE_ENV === 'production' ? 'sg-events/hosts/headers' : 'sg-events-dev/hosts/headers');
const accountAvatarFolder = process.env.CLOUDINARY_ACCOUNT_AVATAR_FOLDER ||
  (process.env.NODE_ENV === 'production' ? 'sg-events/avatars' : 'sg-events-dev/avatars');
const eventPhotoFolder = process.env.CLOUDINARY_EVENT_PHOTO_FOLDER ||
  (process.env.NODE_ENV === 'production' ? 'sg-events/event-photos' : 'sg-events-dev/event-photos');
const vibePhotoFolder = process.env.CLOUDINARY_VIBE_PHOTO_FOLDER ||
  (process.env.NODE_ENV === 'production' ? 'sg-events/vibes' : 'sg-events-dev/vibes');
const homepagePhotoFolder = process.env.NODE_ENV === 'production' ? 'sg-events/homepage-photography' : 'sg-events-dev/homepage-photography';

if (configured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
} else if (process.env.NODE_ENV === 'production') {
  // Don't crash the whole app — uploads return 503 until the vars are set
  console.warn('[cloudinary] not configured — cover image uploads disabled (set CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET)');
}

async function uploadCover(buffer) {
  if (!configured) throw Object.assign(new Error('Image uploads are not configured'), { status: 503 });
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: coverFolder,
        colors: true,
        transformation: [{ width: 1600, height: 900, crop: 'limit', quality: 'auto', fetch_format: 'auto' }]
      },
      (error, result) => { if (error) reject(error); else resolve(result); }
    );
    Readable.from(buffer).pipe(stream);
  });
}

async function uploadFlyer(buffer) {
  if (!configured) throw Object.assign(new Error('Image uploads are not configured'), { status: 503 });
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: flyerFolder,
        colors: true,
        transformation: [{ width: 2000, height: 2600, crop: 'limit', quality: 'auto', fetch_format: 'auto' }]
      },
      (error, result) => { if (error) reject(error); else resolve(result); }
    );
    Readable.from(buffer).pipe(stream);
  });
}

function isManagedFlyerUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const folderPath = `/${flyerFolder.split('/').map(encodeURIComponent).join('/')}/`;
    return url.protocol === 'https:' &&
      url.hostname === 'res.cloudinary.com' &&
      url.pathname.includes('/image/upload/') &&
      url.pathname.includes(folderPath);
  } catch (_) {
    return false;
  }
}

async function uploadHostLogo(buffer) {
  if (!configured) throw Object.assign(new Error('Image uploads are not configured'), { status: 503 });
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: hostLogoFolder,
        transformation: [{ width: 512, height: 512, crop: 'limit', quality: 'auto', fetch_format: 'auto' }]
      },
      (error, result) => { if (error) reject(error); else resolve(result); }
    );
    Readable.from(buffer).pipe(stream);
  });
}

async function uploadHostHeader(buffer) {
  if (!configured) throw Object.assign(new Error('Image uploads are not configured'), { status: 503 });
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: hostHeaderFolder,
        transformation: [{ width: 2000, height: 1200, crop: 'limit', quality: 'auto', fetch_format: 'auto' }]
      },
      (error, result) => { if (error) reject(error); else resolve(result); }
    );
    Readable.from(buffer).pipe(stream);
  });
}

async function uploadAccountAvatar(buffer) {
  if (!configured) throw Object.assign(new Error('Image uploads are not configured'), { status: 503 });
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: accountAvatarFolder,
        transformation: [{ width: 512, height: 512, crop: 'fill', gravity: 'auto', quality: 'auto', fetch_format: 'auto' }]
      },
      (error, result) => { if (error) reject(error); else resolve(result); }
    );
    Readable.from(buffer).pipe(stream);
  });
}

async function uploadEventPhoto(buffer) {
  if (!configured) throw Object.assign(new Error('Image uploads are not configured'), { status: 503 });
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: eventPhotoFolder,
        transformation: [{ width: 2400, height: 2400, crop: 'limit', quality: 'auto', fetch_format: 'auto' }]
      },
      (error, result) => { if (error) reject(error); else resolve(result); }
    );
    Readable.from(buffer).pipe(stream);
  });
}

async function uploadVibePhoto(buffer) {
  if (!configured) throw Object.assign(new Error('Image uploads are not configured'), { status: 503 });
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: vibePhotoFolder,
        transformation: [{ width: 1600, height: 1200, crop: 'limit', quality: 'auto', fetch_format: 'auto' }]
      },
      (error, result) => { if (error) reject(error); else resolve(result); }
    );
    Readable.from(buffer).pipe(stream);
  });
}

async function uploadHomepagePhoto(buffer) {
  if (!configured) throw Object.assign(new Error('Image uploads are not configured'), { status: 503 });
  const publicId = `${homepagePhotoFolder}/${randomBytes(16).toString('hex')}`;
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { public_id: publicId, overwrite: false, resource_type: 'image', type: 'upload', format: 'webp', timeout: 25_000 },
      (error, result) => { if (error) reject(error); else resolve(result); }
    );
    Readable.from(buffer).pipe(stream);
  });
}

function homepagePhotoPublicIdFromUrl(value) {
  if (typeof value !== 'string' || value.length > 600 || !value.startsWith('https://res.cloudinary.com/') || /[\s\\%]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!cloudName || url.href !== value || url.origin !== 'https://res.cloudinary.com' || url.username || url.password || url.search || url.hash) return null;
    const prefix = `/${cloudName}/image/upload/`;
    if (!url.pathname.startsWith(prefix)) return null;
    const matched = /^v\d+\/(.+)\.webp$/.exec(url.pathname.slice(prefix.length));
    return matched && isHomepagePhotoPublicId(matched[1]) ? matched[1] : null;
  } catch { return null; }
}

function isHomepagePhotoPublicId(publicId) {
  return typeof publicId === 'string' && publicId.startsWith(`${homepagePhotoFolder}/`) && /^[0-9a-f]{32}$/.test(publicId.slice(homepagePhotoFolder.length + 1));
}

async function deleteUnattachedHomepagePhoto(publicId) {
  if (!configured || !isHomepagePhotoPublicId(publicId)) return false;
  await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
  return true;
}

function isManagedVibePhotoUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const folderPath = `/${vibePhotoFolder.split('/').map(encodeURIComponent).join('/')}/`;
    return url.protocol === 'https:' &&
      url.hostname === 'res.cloudinary.com' &&
      url.pathname.includes('/image/upload/') &&
      url.pathname.includes(folderPath);
  } catch (_) {
    return false;
  }
}

async function deleteEventPhoto(publicId) {
  if (!configured || !publicId) return;
  await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
}

const managedFolders = [
  coverFolder,
  flyerFolder,
  hostLogoFolder,
  hostHeaderFolder,
  accountAvatarFolder,
  eventPhotoFolder,
  vibePhotoFolder
].map(folder => String(folder || '').replace(/^\/+|\/+$/g, '')).filter(Boolean);

function managedPublicIdFromUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'res.cloudinary.com') return null;
    const segments = url.pathname.split('/').filter(Boolean);
    if (!cloudName || decodeURIComponent(segments[0] || '') !== cloudName) return null;
    if (segments[1] !== 'image') return null;
    const uploadIndex = segments.indexOf('upload');
    if (uploadIndex < 0) return null;
    const afterUpload = segments.slice(uploadIndex + 1);
    const versionIndex = afterUpload.findIndex(segment => /^v\d+$/.test(segment));
    const assetSegments = versionIndex >= 0 ? afterUpload.slice(versionIndex + 1) : afterUpload;
    const decoded = assetSegments.map(segment => decodeURIComponent(segment)).join('/');
    const publicId = decoded.replace(/\.[^/.]+$/, '');
    return isManagedPublicId(publicId) ? publicId : null;
  } catch (_) {
    return null;
  }
}

function isManagedPublicId(value) {
  const publicId = String(value || '').replace(/^\/+|\/+$/g, '');
  if (!publicId || publicId.includes('..') || /[\\?#]/.test(publicId)) return false;
  return managedFolders.some(folder => publicId.startsWith(`${folder}/`));
}

async function deleteManagedPublicId(value) {
  const publicId = String(value || '').replace(/^\/+|\/+$/g, '');
  if (!configured || !isManagedPublicId(publicId)) return false;
  await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
  return true;
}

// Emergency moderation: move a managed image out of public delivery (type
// 'private' needs a signed URL, so the old public address stops working) or
// back again. The file itself is kept, so a mistaken removal can be undone.
// invalidate clears the CDN copy of the original and every resized version.
async function setManagedImageDelivery(value, delivery) {
  const publicId = String(value || '').replace(/^\/+|\/+$/g, '');
  if (!isManagedPublicId(publicId)) throw new Error('Not a managed Silver Glider image');
  if (!configured) throw new Error('Image storage is not configured');
  const toType = delivery === 'private' ? 'private' : 'upload';
  const fromType = toType === 'private' ? 'upload' : 'private';
  try {
    await cloudinary.uploader.rename(publicId, publicId, {
      resource_type: 'image', type: fromType, to_type: toType, invalidate: true, overwrite: false
    });
  } catch (error) {
    // A retry after a partly-finished move: if the file is already where we
    // want it, the move is done.
    const already = await cloudinary.api.resource(publicId, { resource_type: 'image', type: toType })
      .then(() => true, () => false);
    if (!already) throw error;
  }
  return true;
}

async function deleteManagedImageUrl(value) {
  const publicId = managedPublicIdFromUrl(value);
  return deleteManagedPublicId(publicId);
}

module.exports = {
  setManagedImageDelivery,
  uploadCover, uploadFlyer, uploadHostHeader, uploadHostLogo, uploadAccountAvatar,
  uploadEventPhoto, uploadVibePhoto, uploadHomepagePhoto, homepagePhotoPublicIdFromUrl, deleteUnattachedHomepagePhoto,
  deleteEventPhoto, deleteManagedImageUrl, deleteManagedPublicId,
  isManagedFlyerUrl, isManagedVibePhotoUrl, isManagedPublicId, managedPublicIdFromUrl, configured
};
