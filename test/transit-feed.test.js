'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { deflateRawSync } = require('node:zlib');
const { create511ScheduleSource, GTFS_511_ATTRIBUTION } = require('../src/lib/transit/gtfs-feed');
const { compactStopTime } = require('../src/lib/transit/gtfs-schedule');

const NOW = Date.parse('2026-11-25T07:59:00Z'); // 23:59 Nov 24 in San Francisco
const FAKE_KEY = 'fixture-key-that-must-not-be-in-errors';
const files = {
  'agency.txt': 'agency_id,agency_name,agency_timezone\nm,Muni,America/Los_Angeles',
  'stops.txt': '\ufeffstop_id,stop_name,stop_lat,stop_lon\r\n22,"Mission, ""22nd""",37.75,-122.42\r\n',
  'routes.txt': 'route_id,agency_id,route_type,route_short_name\nr,m,3,49',
  'trips.txt': 'route_id,service_id,trip_id\nr,a,t\nr,a,unrelated',
  'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\na,1,1,1,1,1,0,0,20261120,20261130',
  'calendar_dates.txt': 'service_id,date,exception_type\na,20261126,2',
  'stop_times.txt': 'trip_id,stop_id,stop_sequence,arrival_time,departure_time,ignored\nt,22,2,24:01:00,24:01:00,n/a\nt,elsewhere,10,24:20:00,24:20:00,n/a\nunrelated,other,1,23:00:00,23:00:00,n/a',
  'directions.txt': 'route_id,direction_id,direction\nr,0,Outbound'
};

// Tiny in-memory ZIP writer for fixture CSVs; nothing depends on a system zip
// executable or copies a publisher's schedule.
function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}
function zipFixture(entries) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    if (value === null) continue;
    const fileName = Buffer.from(name);
    const body = Buffer.from(value);
    const compressed = deflateRawSync(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(body), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    local.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(offset, 42);
    offset += local.length + fileName.length + compressed.length;
    locals.push(local, fileName, compressed);
    directory.push(entry, fileName);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(directory.reduce((sum, item) => sum + item.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...directory, end]);
}

const source = options => create511ScheduleSource({ apiKey: FAKE_KEY, now: () => NOW, ...options });
const goodResponse = () => new Response(zipFixture(files));

test('511 feed is lazy and fails closed without server configuration', async () => {
  const unconfigured = source({ apiKey: ' ', fetchImpl: () => assert.fail('fetch must not run') });
  await assert.rejects(unconfigured.getSchedule(), { code: 'GTFS_511_UNCONFIGURED' });
});

test('511 feed caches and coalesces loads; a matched stop retains the entire trip', async () => {
  let count = 0;
  const schedule = source({
    fetchImpl: async (url, options) => {
      count++;
      assert.equal(url.origin + url.pathname, 'https://api.511.org/transit/datafeeds');
      assert.equal(url.searchParams.get('api_key'), FAKE_KEY);
      assert.equal(url.searchParams.get('operator_id'), 'RG');
      assert.equal(options.redirect, 'error');
      return goodResponse();
    },
    selectStopTime: tables => {
      assert.equal(tables.stops[0].stop_name, 'Mission, "22nd"');
      assert.deepEqual(tables.directions[0], { route_id: 'r', direction_id: '0', direction: 'Outbound' });
      return row => row.stop_id === '22';
    }
  });
  const [first, second] = await Promise.all([schedule.getSchedule(), schedule.getSchedule()]);
  assert.equal(first.fetchedAt, NOW);
  assert.equal(first, second);
  assert.equal(await schedule.getSchedule(), first);
  assert.equal(count, 1);
  assert.deepEqual(first.tables.stop_times.map(row => [row.stop_id, row.departure_time]), [
    ['22', '24:01:00'], ['elsewhere', '24:20:00']
  ]);
  assert.equal('ignored' in first.tables.stop_times[0], false);
  assert.deepEqual(GTFS_511_ATTRIBUTION, { label: 'data provided by 511.org', url: 'https://www.511.org/' });
});

test('city loader selects whole trips, reads pathways and publishes only the compiled snapshot', async () => {
  const route = source({
    fetchImpl: async () => new Response(zipFixture({ ...files,
      'pathways.txt': 'pathway_id,from_stop_id,to_stop_id,is_bidirectional,pathway_mode\np,entrance,platform,0,1' })),
    selectTripIds: tables => {
      assert.equal(tables.pathways[0].from_stop_id, 'entrance');
      return new Set(['t']);
    },
    formatStopTime: compactStopTime,
    compileSnapshot: tables => ({ trips: tables.stop_times.map(row => [row.trip_id, row.stop_id, row.departure]) })
  });
  const snapshot = await route.getSchedule();
  assert.deepEqual(snapshot, { trips: [['t', '22', 86460], ['t', 'elsewhere', 87600]], fetchedAt: NOW });
});

test('failed refresh never returns the old cache and throttles retries', async () => {
  let count = 0;
  let time = NOW;
  const schedule = source({
    now: () => time,
    ttlMs: 10,
    retryDelayMs: 20,
    fetchImpl: async (url) => {
      if (++count === 2) throw new Error(`provider exception for ${url}`);
      return goodResponse();
    }
  });
  const first = await schedule.getSchedule();
  time += 10;
  await assert.rejects(schedule.getSchedule(), error => {
    assert.equal(error.code, 'GTFS_511_UNAVAILABLE');
    assert.doesNotMatch(error.stack, new RegExp(FAKE_KEY));
    assert.equal(error.cause, undefined);
    return true;
  });
  await assert.rejects(schedule.getSchedule(), { code: 'GTFS_511_UNAVAILABLE' });
  assert.equal(count, 2);
  time += 20;
  assert.notEqual(await schedule.getSchedule(), first);
  assert.equal(count, 3);
});

test('511 feed rejects upstream errors and times out a stalled request', async () => {
  const upstream = source({ fetchImpl: async () => new Response('rate limited', { status: 429 }) });
  await assert.rejects(upstream.getSchedule(), { code: 'GTFS_511_UNAVAILABLE' });
  const timeout = source({
    timeoutMs: 5,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })
  });
  await assert.rejects(timeout.getSchedule(), { code: 'GTFS_511_UNAVAILABLE' });
});

test('511 feed rejects bad archives, missing schedule data and archive size limits', async () => {
  for (const [options, code] of [
    [{ fetchImpl: async () => new Response('bad ZIP') }, 'GTFS_511_INVALID'],
    [{ fetchImpl: async () => new Response(zipFixture({ ...files, 'stop_times.txt': null })) }, 'GTFS_511_INVALID'],
    [{ fetchImpl: async () => new Response(zipFixture({ ...files, 'routes.txt': 'route_id,route_id\na,b' })) }, 'GTFS_511_INVALID'],
    [{ maxArchiveBytes: 20 }, 'GTFS_511_UNAVAILABLE'],
    [{ maxUncompressedBytes: 20 }, 'GTFS_511_INVALID'],
    [{ maxRetainedRows: 2 }, 'GTFS_511_INVALID']
  ]) {
    const schedule = source({ fetchImpl: async () => goodResponse(), ...options });
    await assert.rejects(schedule.getSchedule(), { code });
  }
});

function reflected511Html(key) {
  return Buffer.from(`\r\n\r\n<!DOCTYPE html><html lang="en"><head><title>511</title></head><body><code>GET /transit/datafeeds?api_key=${key}&amp;operator_id=RG</code></body></html>\r\n`);
}

test('511 feed accepts only its reflected HTML trailer after an intact ZIP directory', async () => {
  // Force the streaming writer to flush archive bytes far earlier than the
  // footer, and split the source prefix/central records across chunks.
  const archive = zipFixture({ ...files, 'not-schedule.txt': randomBytes(120000) });
  const withFooter = Buffer.concat([archive, reflected511Html(FAKE_KEY)]);
  const schedule = source({ fetchImpl: async () => {
    let offset = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (offset >= withFooter.length) return controller.close();
      const end = Math.min(withFooter.length, offset + (offset === 0 ? 2 : 1031));
      controller.enqueue(withFooter.subarray(offset, end));
      offset = end;
    } }));
  } });
  assert.equal((await schedule.getSchedule()).tables.routes[0].route_short_name, '49');

  const brokenDirectory = Buffer.from(archive);
  const directoryOffset = archive.readUInt32LE(archive.length - 6);
  brokenDirectory[directoryOffset] = 0;
  for (const bytes of [
    Buffer.concat([archive, reflected511Html('not-the-request-key')]),
    Buffer.concat([archive, Buffer.from(`other text, even if it has api_key=${FAKE_KEY}`)]),
    Buffer.concat([archive, Buffer.alloc(4500, 0x20), reflected511Html(FAKE_KEY)]),
    Buffer.concat([brokenDirectory, reflected511Html(FAKE_KEY)])
  ]) {
    await assert.rejects(source({ fetchImpl: async () => new Response(bytes) }).getSchedule(), error => {
      assert.equal(error.code, 'GTFS_511_INVALID');
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.stack, new RegExp(FAKE_KEY));
      return true;
    });
  }
});

test('511 feed does not use a cached publisher schedule after its local last day', async () => {
  let time = NOW;
  const schedule = source({
    now: () => time,
    fetchImpl: async () => new Response(zipFixture({
      ...files, 'feed_info.txt': 'feed_publisher_name,feed_end_date\n511,20261124'
    }))
  });
  assert.equal((await schedule.getSchedule()).fetchedAt, NOW);
  time += 61_000;
  await assert.rejects(schedule.getSchedule(), { code: 'GTFS_511_INVALID' });
});
