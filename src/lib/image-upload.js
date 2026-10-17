const sharp = require('sharp');

const DEFAULT_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif']);

class ImageUploadError extends Error {
  constructor(message, code = 'invalid_image') {
    super(message);
    this.name = 'ImageUploadError';
    this.code = code;
    this.status = 400;
  }
}

function safePositive(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

async function normalizeImageUpload(buffer, {
  allowedFormats = DEFAULT_FORMATS,
  maxInputBytes = 5 * 1024 * 1024,
  maxOutputBytes = 6 * 1024 * 1024,
  maxWidth = 2400,
  maxHeight = 2600,
  maxPixels = 40_000_000,
  maxFrames = 60,
  maxTotalPixels = 80_000_000
} = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new ImageUploadError('Choose a non-empty image file.');
  }
  if (buffer.length > maxInputBytes) {
    throw new ImageUploadError('Image is too large.', 'image_too_large');
  }

  const formats = allowedFormats instanceof Set ? allowedFormats : new Set(allowedFormats);
  let pipeline;
  let metadata;
  try {
    pipeline = sharp(buffer, {
      animated: true,
      failOn: 'error',
      limitInputPixels: maxTotalPixels
    });
    metadata = await pipeline.metadata();
  } catch (_) {
    throw new ImageUploadError('That file is not a readable image.');
  }

  const format = String(metadata.format || '').toLowerCase();
  const width = safePositive(metadata.width, 0);
  const height = safePositive(metadata.pageHeight || metadata.height, 0);
  const frames = safePositive(metadata.pages, 1);
  if (!formats.has(format) || !width || !height) {
    throw new ImageUploadError('Use a JPG, PNG, WebP, or GIF image.');
  }
  if (frames > maxFrames) {
    throw new ImageUploadError(`Animated images may contain at most ${maxFrames} frames.`, 'too_many_frames');
  }
  if (width * height > maxPixels || width * height * frames > maxTotalPixels) {
    throw new ImageUploadError('Image dimensions are too large.', 'image_dimensions_too_large');
  }

  try {
    const result = await pipeline
      .rotate()
      .resize({
        width: maxWidth,
        height: maxHeight,
        fit: 'inside',
        withoutEnlargement: true
      })
      // Re-encoding strips executable metadata and ensures Cloudinary receives
      // a decoded image rather than arbitrary bytes with an image MIME label.
      .webp({ quality: 86, alphaQuality: 90, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    if (!result.data.length || result.data.length > maxOutputBytes) {
      throw new ImageUploadError('The processed image is too large.', 'image_too_large');
    }
    return {
      buffer: result.data,
      format: 'webp',
      mimeType: 'image/webp',
      width: result.info.width,
      height: result.info.height,
      frames
    };
  } catch (error) {
    if (error instanceof ImageUploadError) throw error;
    throw new ImageUploadError('That file could not be safely processed as an image.');
  }
}

async function normalizeRequestImages(req, options) {
  const files = Array.isArray(req.files) ? req.files : (req.file ? [req.file] : []);
  for (const file of files) {
    const normalized = await normalizeImageUpload(file.buffer, options);
    file.buffer = normalized.buffer;
    file.mimetype = normalized.mimeType;
    file.detectedFormat = normalized.format;
    file.imageWidth = normalized.width;
    file.imageHeight = normalized.height;
    file.imageFrames = normalized.frames;
  }
  return files;
}

module.exports = {
  ImageUploadError,
  normalizeImageUpload,
  normalizeRequestImages
};
