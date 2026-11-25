# Make-Out Room transit pilot: data foundation

The pilot is disabled by default. The existing published event and address fields identify Make-Out Room at 3225 22nd Street, San Francisco; private, hidden, secret and other events are not eligible. No unrelated RSVP, follow, host credits, or existing reminder settings are changed.

Set `TRANSIT_511_API_KEY` (or the existing `511_API_TOKEN`) server-side for the [511 regional schedule feed](https://511.org/open-data/transit). It downloads and caches a bounded static GTFS snapshot for up to 12 hours; the worker uses a separate five-minute cache. Concurrent callers share the download. Expired or failed downloads do not return old departure times. The pilot displays [data provided by 511.org](https://www.511.org/) as required by the [511 agreement](https://511.org/media/6658/show). No key is embedded in the code or exposed in logs or responses.

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

The configured 511 token accepted a read-only live schedule probe on November 24. A synthetic November 28 evening event matched 35 boarding points, 19 distinct feed route IDs (including multiple BART lines), and 45 scheduled choices across selected stops/directions, plus overnight and no-service results. This is source verification, not a live trip or guarantee of service. Other nearby regional stops can be discovered but are not offered until their walking estimates are verified. Never use the example times in the mockup as schedule data.

## QA and rollout gates

- `TRANSIT_GETTING_HOME_ENABLED`: replaces directions only for eligible Going plans and exposes the protected Getting Home screen. Calculations use the walk plus a five-minute buffer; the optional text is 30 minutes before leave-by. Rideshare drop-off prefill uses a selected public BART station only.
- `TRANSIT_RIDE_REMINDERS_ENABLED`: requires both a daily and a lifetime `TRANSIT_SMS_*_SEGMENT_CAP`. Leave disabled with the default zero caps until a pilot budget and a controlled delivery check are in place. A verified US number, a confirmed Going RSVP and fresh one-time consent are required. No organizer credits. A cancellation or STOP prevents pending sends, and an ambiguous submission is never retried. The provider queues time-sensitive texts for at most [five minutes](https://www.twilio.com/docs/messaging/api/message-resource); delivery is not guaranteed.
- `TRANSIT_DISTRIBUTION_ENABLED`: inserts a short-lived read-only link in the existing day-before email and records deduplicated usage. That link is not a login, cannot schedule a text or access private saved routes, and is rechecked against current RSVP status. Day-of, the RSVP form, and its reminder checkbox stay unchanged.
- Saved routes are always optional and private. Removal is available on Getting Home or in Account settings. Saved preferences never start a new reminder.
- `transit_ride_totals` counts unique opens, successful route checks, pending reminder requests, provider-accepted sends, link opens and repeat use. The queue is authoritative for provider acceptance. Link opens can include email scanners; these are product interactions, not attendance or handset delivery. Temporary HMAC dedup keys expire after 45 days. No raw location, contact address, selection, or network data is collected for measurement.

Run `npm run check` against a dedicated local `sge_test` and keep the production flags off during QA. Check the email entry on a real iPhone and Android device and use a controlled test recipient before any public rollout. No real notifications should be sent by local or browser fixtures.
