const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');

const configured = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
const coverFolder = process.env.CLOUDINARY_COVER_FOLDER ||
  (process.env.NODE_ENV === 'production' ? 'sg-events/covers' : 'sg-events-dev/covers');
const hostLogoFolder = process.env.CLOUDINARY_HOST_LOGO_FOLDER ||
  (process.env.NODE_ENV === 'production' ? 'sg-events/hosts' : 'sg-events-dev/hosts');

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
        transformation: [{ width: 1600, height: 900, crop: 'limit', quality: 'auto', fetch_format: 'auto' }]
      },
      (error, result) => { if (error) reject(error); else resolve(result); }
    );
    Readable.from(buffer).pipe(stream);
  });
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

module.exports = { uploadCover, uploadHostLogo, configured };
