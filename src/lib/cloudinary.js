const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');

const configured = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
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

async function deleteEventPhoto(publicId) {
  if (!configured || !publicId) return;
  await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
}

module.exports = {
  uploadCover, uploadFlyer, uploadHostHeader, uploadHostLogo, uploadAccountAvatar,
  uploadEventPhoto, deleteEventPhoto, isManagedFlyerUrl, configured
};
