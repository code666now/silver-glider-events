# San Francisco transit resource benchmark

Run from the repository root with the same Node major version as Railway. Keep the citywide production switch off while measuring. The script uses the app's 511 archive loader and city schedule compiler, runs in a standalone process, and does not open Postgres, call Geoapify or request a ride reminder.

```sh
node scripts/benchmark-sf-transit.js --archive /path/to/credential-free-511-RG.zip --include-pilot --refresh
```

Use an approved, unmodified GTFS ZIP body without the non-ZIP provider trailer. Do not use a raw or unchecked 511 download: the provider has been observed appending an HTML footer that reflects the key. `--live` instead of `--archive` is only for an isolated environment with its own configured 511 key; it uses the app's downloader, which rejects or strips the footer. An archive run makes no network requests. `--include-pilot` constructs both existing caches in the same process, as can happen after rollout. Repeat without it for a city-only baseline and use a fresh process for each trial. `--event-date YYYY-MM-DD` controls the schedule query date, not the normal feed validity check.

The report includes compressed size, baseline and peak RSS, CPU and wall time, retained rows, warm cache reads, and sampled bus and BART schedule-query latency. `--refresh` forces a second city import with the pilot cache warm; omit it for a cold import only. Peak RSS is cumulative, wall time includes I/O, and warm route probes do not simulate HTTP or geocoding. Counts and timings do not establish actual service for a venue. Compare cold and refresh behavior against the worker's existing memory usage, its Railway limits and observed request latency before enabling it. Leave additional headroom for concurrent work; feature enablement is not a resource test.

No provider credentials or archive are needed for these stress tests (`zip` required):

```sh
node scripts/benchmark-sf-transit.js --synthetic 1500000 --include-pilot --refresh
node scripts/benchmark-sf-transit.js --synthetic 1520000
```

One synthetic run on macOS x64 / Node 25.8 retained 1,593,768 city rows (limit: 1,600,000). A cold city import with the pilot warm took 17.0 s wall / 18.0 s CPU and reached 655 MiB RSS. Refresh took 16.8 s wall / 17.9 s CPU and raised peak RSS to 717 MiB. Sampled warm bus queries were 3.2 ms median / 5.3 ms p95; sampled BART queries were 163 ms median / 271 ms p95. A separate synthetic overflow run hit 1,600,000 rows and exited nonzero without compiling a city snapshot. These are local stress measurements, not Railway resource usage or proof that the current 511 feed fits. Real feed data is provided by [511.org](https://511.org/open-data/transit).

## November 25, 2026: measured live input

With the city rollout off, one separate, low-priority and memory-capped Node process in the existing Railway service imported the actual regional 511 archive. It made no database writes and did not import into the live web process.

| Measurement | Observed |
| --- | --- |
| Container limit / memory before the test | 8 GB decimal / 440 MiB used |
| Compressed input | 60.1 MB |
| Retained rows | 1,503,019 of 1,600,000 (94%; 96,981 spare) |
| Cold import | 20.8 s wall / 20.3 CPU-seconds |
| Peak benchmark-process RSS | 455 MiB |
| Container memory at end of import | 856 MiB used |
| Synchronous city compile / isolated event-loop delay | 674 ms / 689 ms maximum |
| Warm bus route lookups (16 samples) | 1.72 ms median / 5.16 ms p95 |

One separate live Geoapify test checked four public Make-Out Room stops in 529 ms and returned four usable walks (four modeled credits; no guest data). This is a point-in-time measurement, not a production latency or capacity guarantee. The retained-row cap is the narrower margin than memory. Check a representative downtown BART entrance and live request latency under load before arming the rollout; do not assume the isolated process's event-loop figures measure guest web latency.
