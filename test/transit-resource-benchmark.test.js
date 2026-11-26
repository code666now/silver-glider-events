'use strict';

const assert = require('node:assert/strict');
const { execFile, spawnSync } = require('node:child_process');
const { join } = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const run = promisify(execFile);
const script = join(__dirname, '../scripts/benchmark-sf-transit.js');

test('transit benchmark measures both loaders without provider access', async t => {
  if (spawnSync('zip', ['-v'], { stdio: 'ignore' }).status !== 0) return t.skip('zip executable is not installed');
  const { stdout } = await run(process.execPath, [script, '--synthetic', '800', '--include-pilot', '--refresh']);
  const report = JSON.parse(stdout);
  assert.equal(report.input, 'synthetic-no-provider-data');
  assert.equal(report.eventDate, '2026-11-27');
  assert.equal(report.city.retainedStopTimes, 800);
  assert.equal(report.city.countedRetainedRows, report.city.metadataRows + 800);
  assert.equal(report.city.error, null);
  assert.equal(report.city.stoppedAtRowCap, false);
  assert.ok(report.city.candidateWalkingTargets > 0);
  assert.ok(report.city.sampledPlanning.queries > 0);
  assert.ok(report.city.sampledBartPlanning.queries > 0);
  assert.ok(report.city.warm100CacheReadsMs >= 0);
  assert.ok(report.city.cpuMs > 0);
  assert.equal(report.city.forcedRefresh.error, null);
  assert.ok(report.city.forcedRefresh.compileMs > 0);
  assert.ok(report.combinedProcessPeakRssMiB >= report.baselineRssMiB);
  assert.equal(report.pilot.status, 'available');
  assert.ok(report.pilot.verifiedStops > 0);
});

test('transit benchmark rejects unbounded generation', async () => {
  await assert.rejects(run(process.execPath, [script, '--synthetic', '9000000']), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /^SYNTHETIC_ROWS_MUST_BE_800_TO_2000000\s*$/);
    return true;
  });
});
