const crypto = require('crypto');

const GSM_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_\u03a6ΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
);
const GSM_EXTENDED = new Set('^{}\\[~]|€');

function smsSegments(body) {
  const text = String(body || '');
  let units = 0;
  let gsm = true;
  for (const character of text) {
    if (GSM_BASIC.has(character)) units += 1;
    else if (GSM_EXTENDED.has(character)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  // Twilio's UCS-2 accounting follows UTF-16 code units, so astral symbols
  // such as emoji consume two units rather than one JavaScript code point.
  if (!gsm) units = text.length;
  const singleLimit = gsm ? 160 : 70;
  const joinedLimit = gsm ? 153 : 67;
  return {
    encoding: gsm ? 'GSM-7' : 'UCS-2',
    units,
    segments: Math.max(1, units <= singleLimit ? 1 : Math.ceil(units / joinedLimit))
  };
}

function compact(value, fallback) {
  return String(value || fallback || '').replace(/\s+/g, ' ').trim();
}

const SINGLE_SEGMENT_TEMPLATE_VERSION = 'single_segment_v1';
const SMS_OPT_OUT_SUFFIX = ' Reply STOP to opt out.';

function singleSegmentError() {
  return Object.assign(new Error('This text cannot safely fit in one credit. Please contact support before sending.'), {
    code: 'sms_single_segment_required', status: 400, statusCode: 400
  });
}

function assertSingleSegmentMessage(body) {
  const info = smsSegments(body);
  if (!body || info.encoding !== 'GSM-7' || info.segments !== 1 || !body.endsWith(SMS_OPT_OUT_SUFFIX)) {
    throw singleSegmentError();
  }
  return info;
}

function publicSmsRoot(baseUrl) {
  let url;
  try { url = new URL(baseUrl || 'https://silvergliderevents.com'); } catch (_) { throw singleSegmentError(); }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.search || url.hash) {
    throw singleSegmentError();
  }
  return url.toString().replace(/\/$/, '');
}

function smsHostLabel(value) {
  // SMS is the short pointer, not the full event page. Normalize decorative
  // typography and accents so a host's emoji cannot turn every send into UCS-2.
  const normalized = compact(value, 'Silver Glider')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\x20-\x7e]/g, '');
  return compact(normalized, 'Silver Glider');
}

function buildSingleSegmentMessage(hostName, copy, link) {
  const tail = `: ${copy} ${link}${SMS_OPT_OUT_SUFFIX}`;
  let host = smsHostLabel(hostName);
  const remaining = 160 - smsSegments(tail).units;
  // Never shorten a token or URL. Only the human-readable host label can be
  // condensed, and a known brand replaces names that cannot be represented.
  if (smsSegments(host).units > remaining) {
    while (host.length && smsSegments(`${host}...`).units > remaining) host = host.slice(0, -1);
    host = host.trim();
    host = host.length >= 8 ? `${host}...` : 'Silver Glider';
  }
  const body = `${host}${tail}`;
  assertSingleSegmentMessage(body);
  return body;
}

function buildTomorrowMessage(event, baseUrl = process.env.APP_URL, accessToken = null) {
  const root = publicSmsRoot(baseUrl);
  if (accessToken != null && !/^[a-z0-9]{32}$/i.test(String(accessToken))) throw singleSegmentError();
  const link = accessToken
    ? `${root}/t/${encodeURIComponent(accessToken)}`
    : `${root}/e/${encodeURIComponent(event.slug)}`;
  return buildSingleSegmentMessage(event.organizer_label, 'Your event is tomorrow. Details:', link);
}

function buildFollowerAnnouncementMessage(event, baseUrl = process.env.APP_URL) {
  const id = Number(event.id);
  if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw singleSegmentError();
  const link = `${publicSmsRoot(baseUrl)}/s/e/${id}`;
  return buildSingleSegmentMessage(event.organizer_label, 'New event! Details & RSVP:', link);
}

function previewFingerprint({ event, recipients, messageBody, creditCost }) {
  const audience = recipients
    .map(recipient => `${recipient.id}:${recipient.phone}`)
    .sort()
    .join('|');
  return crypto.createHash('sha256')
    .update(`${event.id}|${event.updated_at?.toISOString?.() || event.updated_at || ''}|${messageBody}|${creditCost}|${audience}`)
    .digest('hex');
}

function maskPhone(phone) {
  const value = String(phone || '');
  return value.length > 4 ? `•••• ${value.slice(-4)}` : value;
}

module.exports = {
  SINGLE_SEGMENT_TEMPLATE_VERSION, assertSingleSegmentMessage,
  buildFollowerAnnouncementMessage, buildTomorrowMessage, maskPhone,
  previewFingerprint, smsSegments
};
