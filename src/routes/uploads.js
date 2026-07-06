const express = require('express');
const multer = require('multer');
const requireOrganizer = require('../middleware/requireOrganizer');
const { uploadCover } = require('../lib/cloudinary');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype));
  }
});

router.post('/api/uploads/cover', requireOrganizer, upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose an image (JPG, PNG, or WebP, max 5 MB)' });
    const result = await uploadCover(req.file.buffer);
    res.json({ url: result.secure_url });
  } catch (err) { next(err); }
});

module.exports = router;
