'use strict';

// Standalone GTFS schedule test. Does not open the database or call Geoapify.
const { createReadStream, createWriteStream } = require('node:fs');
const { mkdtemp, rmdir, stat, unlink } = require('node:fs/promises');
const os = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const { parseArgs } = require('node:util');
const { create511ScheduleSource } = require('../src/lib/transit/gtfs-feed');
const { compactStopTime } = require('../src/lib/transit/gtfs-schedule');
const { createMakeOutRoomTransit, selectPilotStopTimes } = require('../src/lib/transit');
const { PILOT } = require('../src/lib/transit/make-out-room');
const { compileSfSnapshot, selectSfTripIds } = require('../src/lib/transit/sf-transit');

const MIB = 1024 ** 2;
const CITY_ROW_LIMIT = 1_600_000; // Must be the same as createSfTransit.
const PILOT_ROW_LIMIT = 800_000; // Default in create511ScheduleSource.
const FIXTURE_DATE = '2026-11-27';
const FIXTURE_TIME = Date.parse('2026-11-27T12:00:00Z');
const round = (n, places = 2) => Number(n.toFixed(places));
const peakRssMiB = () => round(process.resourceUsage().maxRSS / 1024, 1);
const usage = 'Usage: node scripts/benchmark-sf-transit.js (--archive /path/to/511.zip | --live | --synthetic 1100000) [--event-date YYYY-MM-DD] [--include-pilot] [--refresh]';
const selectDate = now => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date(now));

function silentError(code) {
  return Object.assign(new Error(code), { reportedCode: code });
}

async function measured(work) {
  const begin = performance.now();
  const cpuBegin = process.cpuUsage();
  let result;
  let error;
  try { result = await work(); }
  catch (failed) { error = failed; }
  const cpu = process.cpuUsage(cpuBegin);
  return { result, error, stats: {
    wallMs: round(performance.now() - begin, 1),
    cpuMs: round((cpu.user + cpu.system) / 1000, 1),
    processPeakRssMiB: peakRssMiB()
  } };
}

function probes(schedule, sample, eventDate) {
  const times = [];
  const outcomes = {};
  for (const selection of sample) {
    const begin = performance.now();
    const plan = schedule.departure({ ...selection, date: eventDate, startTime: '20:00' });
    times.push(performance.now() - begin);
    outcomes[plan.status] = (outcomes[plan.status] || 0) + 1;
  }
  times.sort((a, b) => a - b);
  return { queries: sample.length, statuses: outcomes,
    p50Ms: times.length ? round(times[Math.floor((times.length - 1) * 0.5)], 3) : null,
    p95Ms: times.length ? round(times[Math.ceil(times.length * 0.95) - 1], 3) : null };
}

function probeCity(snapshot, eventDate) {
  const bus = new Map();
  const bart = new Map();
  for (const point of snapshot.points.values()) {
    const { stopId, stationId } = point;
    if (stationId && !bart.has(stationId)) {
      const destinationStationId = snapshot.schedule.destinations(stationId)[0]?.stationId;
      if (destinationStationId) bart.set(stationId, { stationId, destinationStationId });
    }
    for (const route of point.routes) {
      if (route.requiresDestination || bus.has(route.routeId)) continue;
      bus.set(route.routeId, { stopId, routeId: route.routeId, direction: route.direction, headsign: route.headsign });
    }
  }
  // Bounded samples of distinct route keys, keeping all station/stop IDs out
  // of the report. BART measures destination-aware planning separately.
  return { bus: probes(snapshot.schedule, [...bus.values()].slice(0, 32), eventDate),
    bart: probes(snapshot.schedule, [...bart.values()].slice(0, 8), eventDate) };
}

async function benchmark({ archive, live, fixture, eventDate, includePilot, refresh }) {
  let compressedBytes = null;
  let sourceOptions = {};
  if (archive) {
    const info = await stat(archive);
    if (!info.isFile() || info.size <= 0 || info.size > 192 * MIB) throw silentError('ARCHIVE_INVALID_OR_OVER_COMPRESSED_LIMIT');
    compressedBytes = info.size;
    sourceOptions = { apiKey: 'isolated-benchmark-no-network',
      fetchImpl: async () => new Response(Readable.toWeb(createReadStream(archive)), { headers: { 'content-length': String(info.size) } }) };
  } else if (live) {
    require('dotenv').config({ quiet: true });
    if (!(process.env.TRANSIT_511_API_KEY?.trim() || process.env['511_API_TOKEN']?.trim())) throw silentError('511_KEY_NOT_CONFIGURED');
    // Observe size only; responses still pass through the normal downloader,
    // which rejects or strips the upstream trailer without printing it.
    sourceOptions.fetchImpl = async (...args) => {
      const response = await fetch(...args);
      compressedBytes = Number(response.headers.get('content-length')) || null;
      return response;
    };
  }
  let clockOffset = 0;
  // Inject a short cache lifetime and advance only the cache's clock, so the
  // review can measure an actual refresh without waiting twelve hours.
  const forcedRefreshTtlMs = 60_000;
  const now = () => (fixture ? FIXTURE_TIME : Date.now()) + clockOffset;
  const serviceDate = eventDate || selectDate(now());
  const loop = monitorEventLoopDelay({ resolution: 10 });
  const baselineRssMiB = round(process.memoryUsage().rss / MIB, 1);
  loop.enable();

  let pilot;
  if (includePilot) {
    const source = create511ScheduleSource({ ...sourceOptions, now, selectStopTime: selectPilotStopTimes, maxRetainedRows: PILOT_ROW_LIMIT });
    const planner = createMakeOutRoomTransit({ source });
    pilot = { source, planner, report: await measured(async () => {
      const snapshot = await source.getSchedule();
      const options = await planner.getOptions({ status: 'published', visibility: 'public', venue_name: PILOT.name,
        venue_address: PILOT.address, venue_city: PILOT.city, venue_state: PILOT.state, timezone: PILOT.timezone });
      return { status: options.status, retainedStopTimes: snapshot.tables.stop_times.length, verifiedStops: options.stops?.length || 0 };
    }) };
  }

  let scheduledTripIds = 0;
  let metadataRows = 0;
  let retainedStopTimes = 0;
  let compileMs = null;
  const source = create511ScheduleSource({
    ...sourceOptions, now, maxRetainedRows: CITY_ROW_LIMIT,
    ...(refresh ? { ttlMs: forcedRefreshTtlMs } : {}),
    selectTripIds(tables) {
      metadataRows = Object.values(tables).reduce((count, rows) => count + rows.length, 0);
      const ids = selectSfTripIds(tables);
      scheduledTripIds = ids.size;
      return ids;
    },
    formatStopTime(row) { retainedStopTimes++; return compactStopTime(row); },
    compileSnapshot(tables) {
      const begin = performance.now();
      try { return compileSfSnapshot(tables); }
      finally { compileMs = round(performance.now() - begin, 1); }
    }
  });
  const cold = await measured(source.getSchedule);
  const candidateWalkingTargets = cold.result?.points.size ?? null;
  const initial = { metadataRows, retainedStopTimes, scheduledTripIds, compileMs };
  let warm = null;
  let planning = null;
  let refreshed = null;
  if (!cold.error) {
    warm = (await measured(async () => {
      for (let i = 0; i < 100; i++) await source.getSchedule();
    })).stats;
    planning = probeCity(cold.result, serviceDate);
    if (refresh) {
      cold.result = null; // Do not retain the old result outside its cache.
      clockOffset += forcedRefreshTtlMs;
      retainedStopTimes = 0;
      const next = await measured(source.getSchedule);
      refreshed = { ...next.stats, error: next.error?.code || null, compileMs: next.error ? null : compileMs };
    }
  }
  await new Promise(resolve => setTimeout(resolve, 20));
  loop.disable();
  const error = cold.error?.code || null;
  return {
    input: fixture ? 'synthetic-no-provider-data' : archive ? 'local-archive' : 'live-511',
    attribution: { label: 'data provided by 511.org', origin: 'https://511.org/open-data/transit' },
    runtime: { node: process.version, platform: process.platform, architecture: process.arch, logicalCpus: os.availableParallelism() },
    compressedBytes,
    baselineRssMiB,
    combinedProcessPeakRssMiB: peakRssMiB(),
    processRssAfterMiB: round(process.memoryUsage().rss / MIB, 1),
    heapAfterMiB: round(process.memoryUsage().heapUsed / MIB, 1),
    pilot: pilot ? { ...pilot.report.stats, ...pilot.report.result, error: pilot.report.error?.code || null } : null,
    city: { ...cold.stats, error, rowLimit: CITY_ROW_LIMIT, ...initial,
      countedRetainedRows: initial.metadataRows + initial.retainedStopTimes,
      stoppedAtRowCap: Boolean(error && initial.metadataRows > 0 && initial.metadataRows + initial.retainedStopTimes === CITY_ROW_LIMIT),
      candidateWalkingTargets, warm100CacheReadsMs: warm?.wallMs ?? null,
      sampledPlanning: planning?.bus ?? null, sampledBartPlanning: planning?.bart ?? null, forcedRefresh: refreshed },
    processEventLoopMaxDelayMs: round(loop.max / 1e6, 1),
    eventDate: serviceDate
  };
}

// Create a ZIP in a separate temporary workspace, then run the real loader in
// a fresh Node process so generated CSV allocation does not inflate peak RSS.
async function synthetic(rows, extraArgs) {
  if (!Number.isSafeInteger(rows) || rows < 800 || rows > 2_000_000) throw silentError('SYNTHETIC_ROWS_MUST_BE_800_TO_2000000');
  const root = await mkdtemp(join(os.tmpdir(), 'sge-transit-benchmark-'));
  const archive = join(root, 'fixture.zip');
  const files = ['agency.txt', 'stops.txt', 'routes.txt', 'calendar.txt', 'trips.txt', 'stop_times.txt', 'pathways.txt'];
  const syntheticTrips = Math.ceil(rows / 40);
  const unrelatedTrips = Math.ceil(syntheticTrips * 1.3);
  const totalTrips = syntheticTrips + unrelatedTrips;
  const agency = (i) => i >= syntheticTrips ? 'ZZ' : i % 13 === 0 ? 'BA' : 'SF';
  const routeNumber = (i, who) => i % (who === 'SF' ? 86 : who === 'BA' ? 8 : 220);
  const routeId = (i, who) => `${who}:R${routeNumber(i, who)}`;
  const stopId = (who, stop) => who === 'BA' ? `BA:P${stop}` : who === 'SF' && stop === 0 ? 'SF:15562' : `${who}:S${stop}`;
  const stopCount = who => who === 'BA' ? 50 : who === 'SF' ? 2000 : 5000;
  const time = (seconds) => `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const writers = {
    'agency.txt': function* () { yield 'agency_id,agency_name,agency_timezone\nSF,San Francisco Municipal Transportation Agency,America/Los_Angeles\nBA,Bay Area Rapid Transit,America/Los_Angeles\nZZ,Unrelated regional sample,America/Los_Angeles\n'; },
    'calendar.txt': function* () { yield 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nDaily,1,1,1,1,1,1,1,20261101,20261231\n'; },
    'routes.txt': function* () {
      yield 'route_id,agency_id,route_type,route_short_name\n';
      for (const [who, type, count] of [['SF', 3, 86], ['BA', 1, 8], ['ZZ', 3, 220]]) {
        for (let index = 0; index < count; index++) yield `${routeId(index, who)},${who},${type},${index + 1}\n`;
      }
    },
    'stops.txt': function* () {
      yield 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n';
      for (const who of ['SF', 'BA', 'ZZ']) {
        for (let index = 0; index < stopCount(who); index++) {
          if (who === 'BA') {
            const [lat, lon] = index === 0 ? [37.752583, -122.41833] : [37.75 + index * 0.0015, -122.402];
            const stationId = index === 0 ? 'BA:901609' : `BA:S${index}`;
            yield `${stationId},Synthetic station ${index},${lat},${lon},1,\n${stopId(who, index)},Platform,${lat},${lon},0,${stationId}\nBA:E${index},Entrance,${lat},${lon},2,${stationId}\n`;
          } else {
            const [lat, lon] = who === 'SF' && index === 0 ? [37.75517, -122.4188] :
              [37.7 + (index % 100) * 0.0011, (who === 'SF' ? -122.48 : -121.8) + (index % 61) * 0.0009];
            yield `${stopId(who, index)},Synthetic stop ${index},${lat},${lon},0,\n`;
          }
        }
      }
    },
    'trips.txt': function* () {
      yield 'route_id,service_id,trip_id,trip_headsign,direction_id\n';
      for (let i = 0; i < totalTrips; i++) yield `${routeId(i, agency(i))},Daily,T${i},Synthetic terminal,${i % 2}\n`;
    },
    'pathways.txt': function* () {
      yield 'pathway_id,from_stop_id,to_stop_id,is_bidirectional,pathway_mode\n';
      for (let index = 0; index < 50; index++) yield `walk${index},BA:E${index},BA:P${index},1,1\n`;
    },
    'stop_times.txt': function* () {
      yield 'trip_id,stop_id,stop_sequence,arrival_time,departure_time,timepoint\n';
      for (let i = 0; i < totalTrips; i++) {
        const who = agency(i);
        const first = (routeNumber(i, who) * 19) % stopCount(who);
        const start = 5 * 3600 + ((Math.floor(i / 83) * 613) % (22 * 3600));
        let batch = '';
        for (let j = 0; j < 40; j++) {
          const clock = time(start + j * 45);
          batch += `T${i},${stopId(who, (first + j) % stopCount(who))},${j + 1},${clock},${clock},1\n`;
        }
        yield batch;
      }
    }
  };
  try {
    for (const file of files) await pipeline(Readable.from(writers[file]()), createWriteStream(join(root, file), { flags: 'wx', mode: 0o600 }));
    await run('zip', ['-q', archive, ...files], { cwd: root, stdio: 'ignore' });
    await run(process.execPath, [__filename, '--archive', archive, '--fixture', ...extraArgs], { stdio: 'inherit' });
  } finally {
    for (const file of [...files, 'fixture.zip']) await unlink(join(root, file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(root);
  }
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(silentError('BENCHMARK_SUBPROCESS_FAILED')));
  });
}

async function main() {
  const { values } = parseArgs({ options: {
    archive: { type: 'string' }, live: { type: 'boolean' }, synthetic: { type: 'string' },
    'event-date': { type: 'string' }, 'include-pilot': { type: 'boolean' }, refresh: { type: 'boolean' },
    fixture: { type: 'boolean' }, help: { type: 'boolean' }
  } });
  if (values.help) return console.log(usage);
  if (Number(Boolean(values.archive)) + Number(Boolean(values.live)) + Number(Boolean(values.synthetic)) !== 1 ||
      (values['event-date'] && !/^\d{4}-\d{2}-\d{2}$/.test(values['event-date']))) throw silentError('INVALID_BENCHMARK_OPTIONS');
  if (values.synthetic) {
    const extraArgs = [...(values['include-pilot'] ? ['--include-pilot'] : []), ...(values.refresh ? ['--refresh'] : []),
      ...(values['event-date'] ? ['--event-date', values['event-date']] : [])];
    return synthetic(Number(values.synthetic), extraArgs);
  }
  const report = await benchmark({ archive: values.archive, live: values.live, fixture: values.fixture,
    eventDate: values['event-date'], includePilot: values['include-pilot'], refresh: values.refresh });
  console.log(JSON.stringify(report, null, 2));
  if (report.city.error || report.city.forcedRefresh?.error || report.pilot?.error) process.exitCode = 1;
}

main().catch(error => {
  // No exception stack from a network call, path, or provider response.
  console.error(error.reportedCode || 'TRANSIT_BENCHMARK_FAILED');
  process.exitCode = 1;
});
