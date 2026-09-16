(function exposeImageOptimizer(global) {
  const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
  const MAX_AVATAR_DIMENSION = 1600;

  function canvasBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not prepare that photo.')), type, quality);
    });
  }

  function loadImage(file) {
    if ('createImageBitmap' in global) {
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .then(bitmap => ({ image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }));
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => resolve({
        image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        close: () => URL.revokeObjectURL(url)
      });
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('That photo could not be read.'));
      };
      image.src = url;
    });
  }

  async function optimizeAvatar(file) {
    if (!file) throw new Error('Choose a photo first.');
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
      throw new Error('Choose a JPG, PNG, WebP, or GIF image.');
    }
    if (file.size > MAX_SOURCE_BYTES) {
      throw new Error('That image is larger than 20 MB.');
    }

    let loaded;
    try {
      loaded = await loadImage(file);
      const scale = Math.min(1, MAX_AVATAR_DIMENSION / Math.max(loaded.width, loaded.height));
      const width = Math.max(1, Math.round(loaded.width * scale));
      const height = Math.max(1, Math.round(loaded.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { alpha: true });
      if (!context) throw new Error('Could not prepare that photo.');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(loaded.image, 0, 0, width, height);
      const optimized = await canvasBlob(canvas, 'image/webp', 0.88);
      if (file.size <= 5 * 1024 * 1024 && file.size <= optimized.size) return file;
      return new File([optimized], `${String(file.name || 'photo').replace(/\.[^.]+$/, '')}.webp`, {
        type: 'image/webp',
        lastModified: Date.now()
      });
    } catch (error) {
      // Keep a valid source upload available when an older browser cannot use
      // Canvas/WebP. Cloudinary still performs the final avatar transformation.
      if (file.size <= MAX_SOURCE_BYTES) return file;
      throw error;
    } finally {
      loaded?.close?.();
    }
  }

  global.SGImageOptimizer = { optimizeAvatar, MAX_SOURCE_BYTES };
})(window);
