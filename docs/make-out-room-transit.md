# Make-Out Room transit pilot: data foundation

This commit adds a server-side service only. No HTTP routes, app screens, email links, reminders, database changes, or background workers use it yet. The existing published event and address fields identify Make-Out Room at 3225 22nd Street, San Francisco; private, hidden, secret and other events are not eligible.

Set `TRANSIT_511_API_KEY` server-side to verify the [511 regional schedule feed](https://511.org/open-data/transit). It downloads and caches a bounded static GTFS snapshot for up to 12 hours. Concurrent callers share the download. Expired or failed downloads do not return old departure times. In any future display include [data provided by 511.org](https://www.511.org/), as required by the [511 agreement](https://511.org/media/6658/show). No key is embedded in the code or exposed in logs or responses.

The schedule layer applies service calendars and holiday overrides in agency time, including after-midnight GTFS times. The pilot's night ends at 4 AM local time; service extending regularly into the morning is separate from a final departure. For BART, pass the origin station and destination. The engine checks all available lines at the origin and onward connections, allowing for same-station transfers, published transfer rules and a conservative boarding buffer. This is scheduled service, not live delays or cancellations. Missing or uncertain data must not produce a time. Timings labeled `feed-estimate` are interpolated by the feed, not by this app.

## Walking coverage checked November 24, 2026

[DataSF Muni Stops](https://data.sf.gov/d/i28k-bkz6) and [BART station coordinates](https://www.bart.gov/schedules/developers/gtfs) were screened within 850 m straight-line, then checked on the [OSM pedestrian network](https://routing.openstreetmap.de/about.html) and against agency stop and route pages. The closest option in each direction is summarized below, rounded up. These are walking estimates to the stop or street entrance, not to the train platform or an accessible route guarantee. [© OpenStreetMap contributors](https://www.openstreetmap.org/copyright).

| Service | Boarding points and direction | Estimated walk |
| --- | --- | --- |
| [14](https://www.sfmta.com/routes/14-mission), [49](https://www.sfmta.com/routes/49-van-nessmission) | Mission & 22nd: 14 Downtown / Daly City; 49 Fort Mason / City College | 2 min; 14 runs overnight |
| [14R](https://www.sfmta.com/routes/14r-mission-rapid) | Mission & 24th toward Downtown; Mission & 20th toward Daly City | 6 min |
| [48](https://www.sfmta.com/routes/48-quintara24th-street) | 24th & Mission: Potrero Hill / Ocean Beach; shorter Owl routing | 6 min |
| [27](https://www.sfmta.com/routes/27-bryant), [67](https://www.sfmta.com/routes/67-bernal-heights) | 24th & Mission or Valencia: 27 toward Russian Hill; 67 toward Bernal Heights | 6–7 min; no boarding assumed on an arrival-only call |
| [12](https://www.sfmta.com/routes/12-folsompacific) | Folsom & 22nd: Nob Hill / The Mission via Rincon Hill | 7 min |
| [J Church](https://www.sfmta.com/routes/j-church) | Church & 22nd: Downtown / Balboa Park | 10–11 min |
| [33](https://www.sfmta.com/routes/33-ashbury18th-street) | 18th & Mission toward the Richmond; 18th & Valencia toward SF General | 11 min; no overnight route at 22nd & Mission |
| [714](https://www.sfmta.com/routes/714-bart-early-bird) | Mission & 24th: Downtown / Daly City BART | 6 min; weekday early morning only |
| [BART](https://www.bart.gov/stations/24th) | 24th St./Mission, northbound and southbound platforms; require a destination for the connection | 6 min to street entrance |

Agency stop evidence is not live 511 validation. A live token was not configured during development; regional stop ID matching, feed limits and event-specific departures still need a live check. Other nearby regional stops can be discovered from the feed, but get no walk time or departure result until their walks are checked. Never use the example times in the design mockup as schedule data.

Run `node --test test/transit-*.test.js` for the adapter, walking coverage, schedule and transfer fixtures.
