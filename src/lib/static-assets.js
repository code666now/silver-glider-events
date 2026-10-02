const fs = require('fs');

const productionViewCache = new Map();
const VERSIONED_ASSET_RE = /(\b(?:src|href)=)(["'])(\/(?:(?:css|js|images)\/[^"'?#\s]+|(?:favicon|apple-touch-icon|logo|icon-\d+)\.png|site\.webmanifest))([^"']*)(\2)/gi;

function addVersion(urlTail, version) {
  const value = String(urlTail || '');
  if (/(?:^|[?&])v=/.test(value)) return value;
  const hashIndex = value.indexOf('#');
  const beforeHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : '';
  return `${beforeHash}${beforeHash.includes('?') ? '&' : '?'}v=${encodeURIComponent(version)}${hash}`;
}

function versionAssetUrls(html, version) {
  if (typeof html !== 'string' || !version) return html;
  return html.replace(VERSIONED_ASSET_RE, (match, attribute, quote, assetPath, tail) => (
    `${attribute}${quote}${assetPath}${addVersion(tail, version)}${quote}`
  ));
}

function versionHtmlResponses(version) {
  return (req, res, next) => {
    const send = res.send;
    res.send = function sendVersionedHtml(body) {
      const html = typeof body === 'string' && /(?:<!doctype\s+html|<html\b)/i.test(body)
        ? versionAssetUrls(body, version)
        : body;
      return send.call(this, html);
    };
    next();
  };
}

function markVersionedAssetRequest(version) {
  return (req, res, next) => {
    res.locals.currentAssetVersion = String(req.query?.v || '') === String(version);
    next();
  };
}

function setStaticCacheHeaders(res) {
  res.setHeader(
    'Cache-Control',
    res.locals.currentAssetVersion
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=3600'
  );
}

function readHtmlFile(filePath) {
  if (process.env.NODE_ENV !== 'production') return fs.readFileSync(filePath, 'utf8');
  if (!productionViewCache.has(filePath)) {
    productionViewCache.set(filePath, fs.readFileSync(filePath, 'utf8'));
  }
  return productionViewCache.get(filePath);
}

function sendHtmlFile(res, filePath) {
  return res.type('html').send(readHtmlFile(filePath));
}

module.exports = {
  markVersionedAssetRequest,
  sendHtmlFile,
  setStaticCacheHeaders,
  versionAssetUrls,
  versionHtmlResponses
};
