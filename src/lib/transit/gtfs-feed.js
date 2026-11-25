'use strict';

const { createWriteStream } = require('node:fs');
const { mkdtemp, unlink, rmdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { parse } = require('csv-parse');
const yauzl = require('yauzl');

const FEED_URL = 'https://api.511.org/transit/datafeeds';
const GTFS_511_ATTRIBUTION = Object.freeze({
  label: 'data provided by 511.org',
  url: 'https://www.511.org/'
});
const MIB = 1024 * 1024;
const MAX_ZIP_ENTRIES = 200;
const ZIP_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_END = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP_END_BYTES = 22;
const MAX_511_HTML_TRAILER = 4096;
// Bounded rolling buffer: max ZIP comment, a small central directory, and
// the provider's non-ZIP footer. Never write that footer to the archive file.
const ZIP_TAIL_BYTES = 65535 + ZIP_END_BYTES + 16384 + MAX_511_HTML_TRAILER;
const PACIFIC_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
});

function schema(required, optional = '') {
  const columns = required.split(' ');
  return { required: columns, allowed: new Set([...columns, ...optional.split(' ').filter(Boolean)]) };
}

// Parse only the GTFS fields this foundation uses. Read stop_times last so a
// pilot can retain all calls for trips that serve its stops (and all BART trips).
const TABLES = new Map(Object.entries({
  agency: schema('agency_name agency_timezone', 'agency_id agency_url'),
  stops: schema('stop_id stop_name stop_lat stop_lon', 'location_type parent_station stop_code platform_code wheelchair_boarding'),
  routes: schema('route_id route_type', 'agency_id route_short_name route_long_name route_desc route_url continuous_pickup continuous_drop_off'),
  trips: schema('route_id service_id trip_id', 'direction_id trip_headsign trip_short_name wheelchair_accessible'),
  calendar: schema('service_id monday tuesday wednesday thursday friday saturday sunday start_date end_date'),
  calendar_dates: schema('service_id date exception_type'),
  feed_info: schema('feed_publisher_name', 'feed_start_date feed_end_date feed_version'),
  transfers: schema('transfer_type', 'from_stop_id to_stop_id from_route_id to_route_id from_trip_id to_trip_id min_transfer_time'),
  frequencies: schema('trip_id start_time end_time headway_secs', 'exact_times'),
  directions: schema('route_id direction_id direction'),
  route_attributes: schema('route_id', 'category subcategory running_way'),
  stop_times: schema('trip_id stop_id stop_sequence arrival_time departure_time', 'stop_headsign pickup_type drop_off_type timepoint')
}));
const REQUIRED_TABLES = ['agency', 'stops', 'routes', 'trips', 'stop_times'];

class TransitFeedError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function possible511Footer(bytes, apiKey) {
  if (!bytes.length || bytes.length > MAX_511_HTML_TRAILER) return false;
  let left = 0;
  let right = bytes.length;
  const space = byte => byte === 0x20 || byte === 0x0d || byte === 0x0a || byte === 0x09;
  while (left < right && space(bytes[left])) left++;
  while (left < right && space(bytes[right - 1])) right--;
  const footer = bytes.subarray(left, right);
  const open = Buffer.from('<!DOCTYPE html');
  const close = Buffer.from('</html>');
  if (!footer.subarray(0, open.length).equals(open) || !footer.subarray(-close.length).equals(close)) return false;
  if (!footer.includes('<html') || !footer.includes('<body') || !footer.includes('</body>')) return false;
  // 511's HTTPS RG response has been observed appending an HTML page that
  // reflects the request key. Match its shape in memory; never decode, save,
  // or include any of it in diagnostics. Other unexpected trailers fail shut.
  const marker = footer.indexOf('api_key');
  return marker >= 0 && footer.indexOf(apiKey, marker + 'api_key'.length) >= 0;
}

function completeSmallDirectory(tail, start, end, count, archiveBase) {
  if (start < 0) return false;
  let cursor = start;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || tail.readUInt32LE(cursor) !== 0x02014b50) return false;
    if (tail.readUInt16LE(cursor + 34) !== 0 || tail.readUInt32LE(cursor + 42) >= archiveBase) return false;
    const nameBytes = tail.readUInt16LE(cursor + 28);
    if (!nameBytes) return false;
    cursor += 46 + nameBytes + tail.readUInt16LE(cursor + 30) + tail.readUInt16LE(cursor + 32);
  }
  return cursor === end;
}

function verifiedArchiveEnd(tail, bytes, apiKey) {
  let footer = tail.lastIndexOf(ZIP_END);
  while (footer >= 0) {
    if (footer + ZIP_END_BYTES <= tail.length) {
      const comment = tail.readUInt16LE(footer + 20);
      const end = footer + ZIP_END_BYTES + comment;
      // Standard ZIP/ZIP64 validation and real ZIP comments stay with yauzl.
      if (end === tail.length) return end;
      if (comment === 0 && possible511Footer(tail.subarray(end), apiKey)) {
        const count = tail.readUInt16LE(footer + 10);
        const directorySize = tail.readUInt32LE(footer + 12);
        const directoryOffset = tail.readUInt32LE(footer + 16);
        const tailBase = bytes - tail.length;
        if (count > 0 && count <= MAX_ZIP_ENTRIES && tail.readUInt16LE(footer + 8) === count
          && tail.readUInt16LE(footer + 4) === 0 && tail.readUInt16LE(footer + 6) === 0
          && directoryOffset + directorySize === tailBase + footer
          && completeSmallDirectory(tail, directoryOffset - tailBase, footer, count, directoryOffset)) return end;
      }
    }
    if (footer === 0) break;
    footer = tail.lastIndexOf(ZIP_END, footer - 1);
  }
  return -1;
}

async function downloadArchive({ path, apiKey, fetchImpl, timeoutMs, maxArchiveBytes }) {
  const url = new URL(FEED_URL);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('operator_id', 'RG');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxArchiveBytes) {
      await response.body?.cancel();
      throw new Error('Unavailable archive');
    }
    let bytes = 0;
    let tail = Buffer.alloc(0);
    let hasHeader = false;
    await pipeline(Readable.fromWeb(response.body), new Transform({
      transform(chunk, encoding, done) {
        bytes += chunk.length;
        if (bytes > maxArchiveBytes) return done(new Error('Archive size exceeded'));
        tail = Buffer.concat([tail, chunk]);
        if (!hasHeader && tail.length >= ZIP_HEADER.length) {
          if (!tail.subarray(0, ZIP_HEADER.length).equals(ZIP_HEADER)) {
            return done(new TransitFeedError('GTFS_511_INVALID', '511 transit schedule is invalid or out of date.'));
          }
          hasHeader = true;
        }
        if (tail.length <= ZIP_TAIL_BYTES) return done();
        const prefix = tail.subarray(0, tail.length - ZIP_TAIL_BYTES);
        tail = tail.subarray(prefix.length);
        return done(null, prefix);
      },
      flush(done) {
        const end = hasHeader ? verifiedArchiveEnd(tail, bytes, apiKey) : -1;
        if (end < 0) return done(new TransitFeedError('GTFS_511_INVALID', '511 transit schedule is invalid or out of date.'));
        return done(null, tail.subarray(0, end));
      }
    }), createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
  } catch (error) {
    // Upstream and fetch errors can contain the entire request URL.
    if (error instanceof TransitFeedError) throw error;
    throw new TransitFeedError('GTFS_511_UNAVAILABLE', '511 transit schedule download unavailable.');
  } finally {
    clearTimeout(timer);
  }
}

async function forEachRecord(zip, entry, fields, visit) {
  await pipeline(await zip.openReadStreamPromise(entry), parse({
    bom: true,
    trim: true,
    skip_empty_lines: true,
    max_record_size: 32 * 1024,
    columns(values) {
      const columns = values.map(value => value.toLowerCase());
      if (new Set(columns).size !== columns.length || fields.required.some(field => !columns.includes(field))) {
        throw new Error('Invalid GTFS columns');
      }
      return columns.map(field => fields.allowed.has(field) ? field : false);
    }
  }), async function collect(records) {
    for await (const row of records) visit(row);
  });
}

async function parseArchive(path, { maxUncompressedBytes, maxRetainedRows, selectStopTime }) {
  const zip = await yauzl.openPromise(path, { autoClose: false, strictFileNames: true, validateEntrySizes: true });
  try {
    if (zip.entryCount > MAX_ZIP_ENTRIES) throw new Error('Too many archive entries');
    const entries = new Map();
    let uncompressedBytes = 0;
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName.endsWith('.txt') && entry.fileName.slice(0, -4);
      if (!TABLES.has(name)) continue;
      uncompressedBytes += entry.uncompressedSize;
      if (entries.has(name) || uncompressedBytes > maxUncompressedBytes) throw new Error('Invalid archive size or file set');
      entries.set(name, entry);
    }
    if (REQUIRED_TABLES.some(name => !entries.has(name)) || !(entries.has('calendar') || entries.has('calendar_dates'))) {
      throw new Error('Missing GTFS schedule tables');
    }

    const tables = {};
    let retainedRows = 0;
    for (const [name, fields] of TABLES) {
      if (!entries.has(name)) continue;
      const entry = entries.get(name);
      let selectedTrips;
      if (name === 'stop_times' && selectStopTime) {
        const select = selectStopTime(tables);
        if (typeof select !== 'function') throw new Error('Missing stop time selector');
        selectedTrips = new Set();
        // Retain the whole trip once any row matches. A final trip's boarding
        // stop alone does not establish that there is a later alighting stop.
        await forEachRecord(zip, entry, fields, row => {
          if (select(row)) selectedTrips.add(row.trip_id);
          if (selectedTrips.size > maxRetainedRows) throw new Error('Schedule row limit exceeded');
        });
      }
      const rows = [];
      let rowCount = 0;
      await forEachRecord(zip, entry, fields, row => {
        rowCount++;
        if (selectedTrips && !selectedTrips.has(row.trip_id)) return;
        if (++retainedRows > maxRetainedRows) throw new Error('Schedule row limit exceeded');
        rows.push(row);
      });
      if (!rowCount && REQUIRED_TABLES.includes(name)) throw new Error('Empty GTFS schedule table');
      tables[name] = rows;
    }
    if (!tables.calendar?.length && !tables.calendar_dates?.length) throw new Error('Missing GTFS service dates');
    return tables;
  } finally {
    zip.close();
  }
}

function pacificDate(timestamp) {
  return PACIFIC_DATE.formatToParts(timestamp).filter(({ type }) => type !== 'literal').map(({ value }) => value).join('');
}

function validDate(value) {
  if (!/^\d{8}$/.test(value)) return false;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso;
}

function scheduleEnd(tables) {
  const knownFeedEnds = (tables.feed_info || []).map(row => row.feed_end_date).filter(Boolean);
  const datedService = knownFeedEnds.length ? knownFeedEnds : [
    ...(tables.calendar || []).map(row => row.end_date),
    ...(tables.calendar_dates || []).filter(row => row.exception_type === '1').map(row => row.date)
  ];
  return datedService.reduce((latest, date) => validDate(date) && date > latest ? date : latest, '');
}

function create511ScheduleSource({
  apiKey = process.env.TRANSIT_511_API_KEY || process.env['511_API_TOKEN'],
  fetchImpl = globalThis.fetch,
  now = Date.now,
  ttlMs = 12 * 60 * 60 * 1000,
  retryDelayMs = 60 * 1000,
  timeoutMs = 45 * 1000,
  maxArchiveBytes = 192 * MIB,
  maxUncompressedBytes = 768 * MIB,
  maxRetainedRows = 800_000,
  selectStopTime
} = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  let cached;
  let inFlight;
  let retryAt = 0;
  let lastError;

  async function refresh() {
    try {
      const directory = await mkdtemp(join(tmpdir(), 'sge-gtfs-'));
      const path = join(directory, 'feed.zip');
      try {
        await downloadArchive({ path, apiKey: key, fetchImpl, timeoutMs, maxArchiveBytes });
        const tables = await parseArchive(path, { maxUncompressedBytes, maxRetainedRows, selectStopTime });
        const fetchedAt = now();
        const validThrough = scheduleEnd(tables);
        if (validThrough < pacificDate(fetchedAt)) throw new Error('No current GTFS coverage');
        return { schedule: { tables, fetchedAt }, validThrough };
      } finally {
        await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await rmdir(directory);
      }
    } catch (error) {
      if (error instanceof TransitFeedError) throw error;
      throw new TransitFeedError('GTFS_511_INVALID', '511 transit schedule is invalid or out of date.');
    }
  }

  return {
    async getSchedule() {
      if (!key) throw new TransitFeedError('GTFS_511_UNCONFIGURED', '511 transit schedule source is not configured.');
      const time = now();
      if (cached && time < cached.schedule.fetchedAt + ttlMs && pacificDate(time) <= cached.validThrough) {
        return cached.schedule;
      }
      if (inFlight) return inFlight;
      if (lastError && time < retryAt) throw lastError;
      cached = null;
      inFlight = refresh().then(result => {
        lastError = null;
        cached = result;
        return result.schedule;
      }, error => {
        lastError = error;
        retryAt = now() + retryDelayMs;
        throw error;
      }).finally(() => { inFlight = null; });
      return inFlight;
    }
  };
}

module.exports = { create511ScheduleSource, GTFS_511_ATTRIBUTION };
