'use strict';

const { createHash } = require('node:crypto');

const DATASF_ADDRESS_URL = 'https://data.sf.gov/resource/3mea-di5p.json';
const ADDRESS_FIELDS = 'address,zip_code,latitude,longitude,supervisor';
const MAX_REPLY_BYTES = 4_096;
const ZIP = /^941\d{2}$/;
const STREET_TYPES = new Map(Object.entries({
  ALLEY: 'ALY', AVENUE: 'AVE', BOULEVARD: 'BLVD', CIRCLE: 'CIR', COURT: 'CT',
  DRIVE: 'DR', HIGHWAY: 'HWY', HILL: 'HL', LANE: 'LN', PLACE: 'PL', PLAZA: 'PLZ',
  ROAD: 'RD', STAIRWAY: 'STWY', STREET: 'ST', TERRACE: 'TER'
}));

function upper(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase() : '';
}

function streetAddress(value) {
  // Match the city's base-address field, without dropping a unit, range, or
  // other information that could point to a different entrance.
  const address = upper(value).replace(/[’‘]/g, "'").replace(/\.(?= |$)/g, '');
  const match = /^([1-9]\d{0,5}[A-Z]?) ([A-Z0-9]+(?:['-][A-Z0-9]+)*(?: [A-Z0-9]+(?:['-][A-Z0-9]+)*)*)$/.exec(address);
  if (!match || !/[A-Z]/.test(match[2])) return null;
  const street = match[2].split(' ');
  if (street.length > 1) {
    // DataSF spells its single-digit numbered streets with a leading zero.
    street[0] = street[0].replace(/^[1-9](?:ST|ND|RD|TH)$/, '0$&');
    const suffix = street.length - (/^[NSEW]$/.test(street.at(-1)) ? 2 : 1);
    if (suffix > 0) street[suffix] = STREET_TYPES.get(street[suffix]) || street[suffix];
  }
  return `${match[1]} ${street.join(' ')}`;
}

function selectedAddress(value) {
  if (typeof value !== 'string' || value.length > 250 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const parts = value.split(',').map(upper);
  if (parts.some(part => !part) || ![1, 3, 4].includes(parts.length)) return null;
  const address = streetAddress(parts[0]);
  if (!address) return null;
  if (parts.length === 1) return { address, zipCode: null };
  const stateZip = /^(?:CA|CALIFORNIA)(?: (941\d{2})(?:-\d{4})?)?$/.exec(parts[2]);
  const country = parts[3]?.replace(/\./g, '');
  if (parts[1] !== 'SAN FRANCISCO' || !stateZip
      || (parts.length === 4 && !['US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA'].includes(country))) return null;
  return { address, zipCode: stateZip[1] ?? null };
}

function coordinate(value, max) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(value))) return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= max ? number : null;
}

function selectedSfVenue(event) {
  if (!event || event.status !== 'published' || event.visibility !== 'public'
      || event.secret_show_enabled || event.hide_address_until_rsvp
      || event.timezone !== 'America/Los_Angeles' || upper(event.venue_city) !== 'SAN FRANCISCO'
      || !['CA', 'CALIFORNIA'].includes(upper(event.venue_state))) return null;
  const placeId = typeof event.google_place_id === 'string' ? event.google_place_id.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(placeId)) return null;
  // Existing Places metadata is a selection signal, not the walking origin
  // or the source for the San Francisco geographic check.
  const lat = coordinate(event.venue_latitude, 90);
  const lon = coordinate(event.venue_longitude, 180);
  if (lat == null || lon == null || (lat === 0 && lon === 0)) return null;
  const selected = selectedAddress(event.venue_address);
  if (!selected) return null;
  const key = createHash('sha256').update(JSON.stringify(['sf-place-v1', placeId, selected.address, selected.zipCode])).digest('hex');
  return { key, ...selected };
}

async function readRows(response) {
  if (!response.ok || Number(response.headers.get('content-length')) > MAX_REPLY_BYTES || !response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REPLY_BYTES) {
        await reader.cancel();
        throw new Error();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const rows = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  if (!Array.isArray(rows)) throw new Error();
  return rows;
}

function createSfAddressResolver({ fetchImpl = globalThis.fetch, timeoutMs = 5_000 } = {}) {
  return async function resolveSfAddress(venue) {
    const address = streetAddress(venue?.address);
    const zipCode = venue?.zipCode;
    if (!address || address !== venue.address || (zipCode != null && (typeof zipCode !== 'string' || !ZIP.test(zipCode)))) return null;
    const url = new URL(DATASF_ADDRESS_URL);
    // SODA's literal equality filter avoids interpolating user input into SoQL.
    url.searchParams.set('address', address);
    url.searchParams.set('$select', ADDRESS_FIELDS);
    url.searchParams.set('$limit', '2');
    let rows;
    try {
      rows = await readRows(await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' }));
    } catch {
      const error = new Error('San Francisco address data is unavailable.');
      error.code = 'SF_ADDRESS_UNAVAILABLE';
      throw error;
    }
    if (rows.length !== 1) return null;
    const row = rows[0];
    if (row?.address !== address || (zipCode && String(row.zip_code) !== zipCode)
        || !/^(?:[1-9]|10|11)$/.test(String(row.supervisor))) return null;
    const lat = coordinate(row.latitude, 90);
    const lon = coordinate(row.longitude, 180);
    // Membership comes from the exact DataSF district address row. Bounds are
    // an extra sanity check on that independent point, never on a Google pin.
    if (lat == null || lon == null || lat < 37.68 || lat > 37.84 || lon < -122.53 || lon > -122.34) return null;
    return { lat, lon };
  };
}

module.exports = { createSfAddressResolver, selectedSfVenue };
