(function exposeArtworkColor(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SGArtworkColor = api;
})(typeof window !== 'undefined' ? window : globalThis, function createArtworkColorApi() {
  'use strict';

  const DEFAULT_ACCENT = '#1CC5BE';

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeHex(value) {
    const raw = String(value || '').trim();
    const short = raw.match(/^#?([0-9a-f]{3})$/i);
    if (short) return `#${short[1].split('').map(char => char + char).join('').toUpperCase()}`;
    const full = raw.match(/^#?([0-9a-f]{6})$/i);
    return full ? `#${full[1].toUpperCase()}` : null;
  }

  function hexToRgb(value) {
    const hex = normalizeHex(value);
    if (!hex) return null;
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16)
    };
  }

  function rgbToHex({ r, g, b }) {
    return `#${[r, g, b].map(value => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  }

  function rgbToHsl({ r, g, b }) {
    const red = r / 255;
    const green = g / 255;
    const blue = b / 255;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;
    let h = 0;
    const l = (max + min) / 2;
    const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
    if (delta) {
      if (max === red) h = 60 * (((green - blue) / delta) % 6);
      else if (max === green) h = 60 * (((blue - red) / delta) + 2);
      else h = 60 * (((red - green) / delta) + 4);
    }
    return { h: h < 0 ? h + 360 : h, s, l };
  }

  function hslToRgb({ h, s, l }) {
    const chroma = (1 - Math.abs(2 * l - 1)) * s;
    const segment = h / 60;
    const x = chroma * (1 - Math.abs((segment % 2) - 1));
    let values = [0, 0, 0];
    if (segment < 1) values = [chroma, x, 0];
    else if (segment < 2) values = [x, chroma, 0];
    else if (segment < 3) values = [0, chroma, x];
    else if (segment < 4) values = [0, x, chroma];
    else if (segment < 5) values = [x, 0, chroma];
    else values = [chroma, 0, x];
    const match = l - chroma / 2;
    return { r: (values[0] + match) * 255, g: (values[1] + match) * 255, b: (values[2] + match) * 255 };
  }

  function relativeLuminance(color) {
    const rgb = typeof color === 'string' ? hexToRgb(color) : color;
    if (!rgb) return 0;
    const channels = [rgb.r, rgb.g, rgb.b].map(value => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function contrastRatio(a, b) {
    const first = relativeLuminance(a);
    const second = relativeLuminance(b);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  }

  function candidateFrom(value) {
    if (Array.isArray(value)) {
      const rgb = hexToRgb(value[0]);
      return rgb ? { ...rgb, weight: Number(value[1]) || 0 } : null;
    }
    if (!value || typeof value !== 'object') return null;
    const rgb = value.hex ? hexToRgb(value.hex) : {
      r: Number(value.r), g: Number(value.g), b: Number(value.b)
    };
    if (!rgb || ![rgb.r, rgb.g, rgb.b].every(Number.isFinite)) return null;
    return { ...rgb, weight: Number(value.weight ?? value.count) || 0 };
  }

  function stabilizeAccent(rgb) {
    const hsl = rgbToHsl(rgb);
    return rgbToHex(hslToRgb({
      h: hsl.h,
      s: clamp(hsl.s, 0.56, 0.88),
      l: clamp(hsl.l, 0.42, 0.68)
    }));
  }

  function selectAccentColor(values, { fallback = DEFAULT_ACCENT } = {}) {
    const candidates = (Array.isArray(values) ? values : [values]).map(candidateFrom).filter(Boolean);
    const maxWeight = Math.max(1, ...candidates.map(candidate => candidate.weight));
    const scored = candidates.map(candidate => {
      const hsl = rgbToHsl(candidate);
      const luminance = relativeLuminance(candidate);
      const chroma = (Math.max(candidate.r, candidate.g, candidate.b) - Math.min(candidate.r, candidate.g, candidate.b)) / 255;
      if (hsl.s < 0.22 || chroma < 0.16 || luminance < 0.055 || luminance > 0.91) return null;
      const lightnessFitness = 1 - Math.min(1, Math.abs(hsl.l - 0.55) / 0.55);
      const frequency = Math.sqrt(Math.max(0, candidate.weight) / maxWeight);
      const score = hsl.s * 0.48 + chroma * 0.25 + lightnessFitness * 0.19 + frequency * 0.08;
      return { candidate, score };
    }).filter(Boolean).sort((a, b) => b.score - a.score);
    return scored.length ? stabilizeAccent(scored[0].candidate) : normalizeHex(fallback);
  }

  function softenRgb({ r, g, b }, { darken = 0.66, desaturate = 0.18 } = {}) {
    const average = (r + g + b) / 3;
    return {
      r: Math.round((average * desaturate + r * (1 - desaturate)) * darken),
      g: Math.round((average * desaturate + g * (1 - desaturate)) * darken),
      b: Math.round((average * desaturate + b * (1 - desaturate)) * darken)
    };
  }

  function paletteForBackground(candidates, options) {
    const values = (Array.isArray(candidates) ? candidates : []).map(candidateFrom).filter(Boolean);
    const colors = values.sort((a, b) => b.weight - a.weight).slice(0, 3).map(color => softenRgb(color, options));
    if (colors.length < 2) throw new Error('Not enough image color data');
    return colors;
  }

  function rgba({ r, g, b }, alpha) {
    return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha})`;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = url;
    });
  }

  async function extractPalette(url, { size = 40 } = {}) {
    if (typeof Image === 'undefined' || typeof document === 'undefined') throw new Error('Image palette extraction requires a browser');
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, size, size);
    const data = context.getImageData(0, 0, size, size).data;
    const buckets = new Map();
    for (let index = 0; index < data.length; index += 16) {
      if (data[index + 3] < 128) continue;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const luminance = relativeLuminance({ r, g, b });
      if (luminance < 0.04 || luminance > 0.95) continue;
      const key = [r, g, b].map(value => Math.min(255, Math.round(value / 32) * 32)).join(',');
      const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, count: 0 };
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.count += 1;
      buckets.set(key, bucket);
    }
    const candidates = [...buckets.values()].map(bucket => ({
      r: Math.round(bucket.r / bucket.count),
      g: Math.round(bucket.g / bucket.count),
      b: Math.round(bucket.b / bucket.count),
      count: bucket.count
    })).sort((a, b) => b.count - a.count);
    if (candidates.length < 2) throw new Error('Not enough image color data');
    return candidates;
  }

  function blendHex(foreground, background, amount) {
    const front = hexToRgb(foreground);
    const back = hexToRgb(background);
    const mix = clamp(amount, 0, 1);
    return rgbToHex({
      r: front.r * mix + back.r * (1 - mix),
      g: front.g * mix + back.g * (1 - mix),
      b: front.b * mix + back.b * (1 - mix)
    });
  }

  function createEmailTheme(savedAccent) {
    const normalized = normalizeHex(savedAccent);
    const selected = normalized ? selectAccentColor([[normalized, 1]], { fallback: DEFAULT_ACCENT }) : DEFAULT_ACCENT;
    const accentColor = selected || DEFAULT_ACCENT;
    const darkText = '#080808';
    const lightText = '#FFFFFF';
    const accentTextColor = contrastRatio(accentColor, darkText) >= contrastRatio(accentColor, lightText) ? darkText : lightText;
    return {
      accentColor,
      accentTextColor,
      mutedAccentColor: blendHex(accentColor, '#111111', 0.18),
      borderColor: '#292929'
    };
  }

  return {
    DEFAULT_ACCENT,
    normalizeHex,
    hexToRgb,
    rgbToHex,
    relativeLuminance,
    contrastRatio,
    selectAccentColor,
    softenRgb,
    paletteForBackground,
    rgba,
    extractPalette,
    createEmailTheme
  };
});
