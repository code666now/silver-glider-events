const express = require('express');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { normalizeHex } = require('../../public/js/artwork-color');

const router = express.Router();
const ICON_NAMES = new Set(['music', 'calendar', 'map', 'manage']);
const ICON_ROOT = path.join(__dirname, '..', '..', 'public', 'images', 'email');
const iconSources = new Map();
const renderedIcons = new Map();

function sourceIcon(name) {
  if (!iconSources.has(name)) {
    iconSources.set(name, fs.readFileSync(path.join(ICON_ROOT, `${name}.png`)));
  }
  return iconSources.get(name);
}

function recolorIcon(name, color) {
  const cacheKey = `${name}:${color}`;
  if (renderedIcons.has(cacheKey)) return renderedIcons.get(cacheKey);
  const target = {
    r: parseInt(color.slice(1, 3), 16),
    g: parseInt(color.slice(3, 5), 16),
    b: parseInt(color.slice(5, 7), 16)
  };
  const png = PNG.sync.read(sourceIcon(name));
  for (let index = 0; index < png.data.length; index += 4) {
    const red = png.data[index];
    const green = png.data[index + 1];
    const blue = png.data[index + 2];
    const isTealStroke = green > 80 && blue > 80 && red < green * 0.7 && Math.abs(green - blue) < 90;
    if (!isTealStroke) continue;
    png.data[index] = target.r;
    png.data[index + 1] = target.g;
    png.data[index + 2] = target.b;
  }
  const output = PNG.sync.write(png);
  if (renderedIcons.size >= 128) renderedIcons.delete(renderedIcons.keys().next().value);
  renderedIcons.set(cacheKey, output);
  return output;
}

router.get('/images/email/:icon/:color.png', (req, res, next) => {
  try {
    const icon = String(req.params.icon || '').toLowerCase();
    const color = normalizeHex(req.params.color);
    if (!ICON_NAMES.has(icon) || !color) return res.status(404).end();
    res.set({
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Type': 'image/png'
    });
    return res.send(recolorIcon(icon, color));
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
