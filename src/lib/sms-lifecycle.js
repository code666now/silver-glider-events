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

function buildTomorrowMessage(event, baseUrl = process.env.APP_URL, accessToken = null) {
  const root = String(baseUrl || 'https://silvergliderevents.com').replace(/\/$/, '');
  const host = compact(event.organizer_label, 'Silver Glider Events');
  const title = compact(event.title, 'Your event');
  const venue = compact(event.venue_name, 'the venue');
  const link = accessToken
    ? `${root}/t/${encodeURIComponent(accessToken)}`
    : `${root}/e/${encodeURIComponent(event.slug)}`;
  const suffix = ` is tomorrow at ${venue}. Details: ${link} Reply STOP to opt out.`;
  const maxHostAndTitle = Math.max(30, 300 - suffix.length);
  const lead = `${host}: ${title}`.slice(0, maxHostAndTitle).trim();
  return `${lead}${suffix}`;
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

module.exports = { buildTomorrowMessage, maskPhone, previewFingerprint, smsSegments };
