# Silver Glider Events

Silver Glider Events is a lightweight event publishing and RSVP platform for independent hosts, promoters, artists, venues, and private gatherings.

Hosts can publish a Standard event page or a poster-first Flyer page, collect free RSVPs, link to an external ticket provider, manage guest lists, send reminders, and maintain a public host page. A feature-gated integration boundary can also hand Silver Glider ticketed events to the separate Commerce service; this repository does **not** process ticket payments or issue tickets. Its only native payment flow is the separately gated purchase of host-owned SMS credits.

- Live: https://silvergliderevents.com
- Railway: https://silver-glider-events-production.up.railway.app
- Full product and operations reference: [`HANDOFF.md`](HANDOFF.md)
- New-agent starting guide: [`CODEX.md`](CODEX.md)

## Stack

- Node.js and Express 5 (CommonJS)
- PostgreSQL via `pg`
- Server-rendered HTML plus vanilla JavaScript and CSS
- Resend for email
- Twilio for server-side SMS delivery and Stripe-hosted Checkout for SMS credit packs
- Cloudinary for uploaded covers, flyers, host images, and visual effects
- Unsplash for the free-photo picker
- `ics`, `qrcode`, and `node-cron`
- No frontend framework and no build step

## Run locally

```bash
createdb sge_dev
createdb sge_test
cp .env.example .env
npm install
npm run dev
```

Set `DATABASE_URL=postgresql://localhost:5432/sge_dev`, provide a local `SESSION_SECRET`, and keep `REMINDERS_ENABLED=false`. The app starts at `http://localhost:3100`; migrations run automatically on boot.

When `RESEND_API_KEY` is empty, magic links and emails are printed to the server console. Without Cloudinary credentials, uploads return 503. Without an Unsplash key, the free-photo search control is hidden.

Never use the Railway production database for development or tests.

## Current product

- Passwordless shared identity authentication with 30-day sliding sessions
- Organizer dashboard, archive/restore, duplicate, cancel, CSV export, and promotion tools, including consent-aware invitations to guests from a past event
- Mobile-first organizer flows with expanded desktop Home, My Events, Settings, create/edit, and event-management workspaces
- Standard events with uploaded/Unsplash covers, gradients, and texture/video effects
- Flyer events with a centered, uncropped poster-first public layout
- Optional Event Vibe with one link or two labeled artist choices sharing a single active player
- Free RSVP, external ticket links, and a feature-gated Silver Glider Commerce handoff; hosts can request one launch email while native ticketing is marked Coming soon
- Progressive RSVP form, mobile docked CTA, capacity enforcement, cancellation links, and confirmation resends
- Artwork-led RSVP confirmation emails with adaptive color treatment, linked host/vibe identity, conditional details, and calendar attachments; separate day-before/day-of reminders
- Public and Private—Link Only visibility
- Optional named guest, first-name-only guest list, and verified-attendee comments for private events
- Optional six-character Secret Show gate
- Public host pages at `/h/:hostSlug`
- Follow Host V1 with email-only magic-link verification, immediate signed-in follows, unfollow, and a lightweight `/following` list
- Twilio Messaging Service delivery plus a paid Host Settings wallet with fixed Stripe Checkout SMS credit packs and an event-specific, consent-aware automatic day-before reminder
- Feedback reporting and super-admin feedback inbox
- Personalized host invitations and lightweight admin host tracking
- Privacy Policy and Terms available throughout the app
- Output escaping, safe URL validation, and public RSVP/resend rate limiting

## Presentation architecture

Standard and Flyer public pages are intentionally isolated:

- Standard template: `src/views/event-public.html`
- Flyer template: `src/views/event-public-flyer.html`
- Flyer-only styles: `public/css/event-public-flyer.css`
- Shared event client: `public/js/public-event.js`

Standard pages retain their existing animated gradients and cover-derived adaptive palette. Flyer pages skip adaptive palette extraction and, unless an explicit effect is selected, use the fixed darkened plaster background at `public/images/flyer-plaster-wall.jpg`. This keeps Flyer pages tactile and poster-like without changing Standard events.

Organizer pages remain mobile-first but expand at desktop widths: My Events can present upcoming events two-up, create/edit separates Page Design from Event Information, and event management places artwork beside a structured actions/promotions panel before the full-width guest list. The Standard editor keeps background choices available after cover selection.

RSVP confirmations use a separate, table-based 620px email layout in `src/lib/mailer.js`. The subject is **RSVP confirmed for [Event Title]** and the visible hierarchy moves directly from **RSVP CONFIRMED** to the event title—there is no generic “You’re on the list” headline. Event artwork is full-width and uncropped; Cloudinary-hosted landscape images receive a predominant-color padded 620×560 JPEG canvas while portrait images preserve their natural ratio. The body and container remain black, cards remain dark gray, and the primary **View Event** button uses the saved artwork accent. RSVP status, linked host, **Music vibe**, and Calendar/Maps/Manage RSVP actions use a brighter WCAG-safe tint from the same hue; their icons are served as ordinary dynamically recolored PNGs for broad email-client compatibility. Missing, neutral, muddy, or inaccessible artwork colors fall back to Silver Glider teal. Static effect posters are used only when no artwork exists, and email markup never embeds motion. Title, host, music row, and date/time/venue rows are conditional; reminder timing, RSVP logic, calendar attachments, manage links, and event URLs are unchanged.

## Project layout

```text
src/index.js                 bootstrap, routes, health check, scheduled email jobs
src/db/migrations/           numbered SQL migrations (currently 001–034)
src/routes/                  auth, organizer events, public events/hosts, uploads, photos, admin
src/lib/                     mailer (including adaptive RSVP confirmations), sessions, calendar, CSV, Cloudinary, Unsplash, escaping
src/jobs/                     reminders, critical event notices, and previous-guest invitation delivery
src/views/                   server-rendered HTML templates
public/css/                  brand and page styles
public/js/                   browser behavior
public/images/               local presentation assets
test/                        focused Node test suite
```

## Key mechanics

- **Authentication:** one-time 15-minute magic-link token becomes a signed, httpOnly 30-day session cookie. The existing `organizers` row is the shared email identity; follower-only identities do not receive Host Page fields. RSVP remains a separate guest flow.
- **Follow Host:** signed-in users follow immediately; signed-out users enter only an email and complete a server-stored `follow_host` intent through the existing magic link. The relationship is one reactivatable `host_follows` row per identity/Host pair. V1 sends no separate follow-confirmation email and keeps legacy RSVP announcement consent separate.
- **Previous guest invitations:** an upcoming public or private event can send one reviewed batch to confirmed primary RSVPs from one owned past event who opted into future host emails. Named guests, host opt-outs, existing target attendees, and already-notified recipients are excluded server-side; delivery is queued, retryable, and one-way.
- **SMS Go 1:** `src/lib/sms.js` owns E.164 normalization, Twilio environment validation, Messaging Service delivery, status callbacks, and sanitized results/errors. The original admin proof endpoint still sends only fixed server copy.
- **SMS fulfillment V1:** `src/lib/stripe-sms.js`, `src/lib/sms-credit-ledger.js`, and the protected SMS routes provide fixed server-priced Stripe-hosted Checkout packs. Hosts can independently enable an off-by-default **Day-before reminder** for a non-Secret event. That event's RSVP form then offers a separate unchecked phone opt-in; phone collection alone never grants permission. Event management always shows the automation state, eligible count, exact estimated cost, and balance, linking to **Add funds** only when a nonzero audience is underfunded. At 4 PM event-local on the day before the event, the worker atomically reserves the entire audience cost and queues one server-generated reminder per deduplicated, currently consented recipient. Underfunded events never partially send, duplicate batches are blocked, and each message contains an expiring private link that restores the existing event-scoped attendee cookie without creating an account. Delivery remains audited, never-accepted messages are refunded, STOP handling remains global, and there is no free allowance or free-form composer.
- **Capacity:** the RSVP endpoint locks the event row and counts attendance inside the transaction before confirming.
- **Reminder idempotency:** `message_log` has a partial unique index; a reminder sends only after a successful claim.
- **Privacy:** private and Secret Show events are excluded from public host pages and promotion surfaces. Secret Show details are not rendered before unlock.
- **Event Vibe:** one supported music/media link keeps the original simple embed. Hosts can optionally add a second labeled artist; Standard and Flyer pages show compact accessible tabs above one active player, and the inactive embed is not loaded.
- **Admission:** `free_rsvp` keeps the established guest flow, `external_tickets` keeps the existing displayed-price and outbound-link behavior, and `silver_glider_tickets` stores only a `commerce_event_id`. Commerce remains authoritative for price, inventory, availability, checkout, orders, and issued tickets.
- **Security:** host/admin output is escaped, executable URL schemes are rejected, and public RSVP/resend endpoints are rate-limited.

## Tests

```bash
npm test
npm run check:static
```

As of September 10, 2026, the suite contains 197 tests. Focused and HTTP/PostgreSQL integration coverage includes authentication, RSVP privacy and event-specific SMS consent, automatic day-before fulfillment, exact pricing, all-or-nothing atomic credit reservation, one-tap attendee access, deduplication, Twilio delivery callbacks and STOP handling, previous-guest invitation filtering and delivery, admin-only Twilio proof transport, Stripe Checkout pack allowlisting, signature verification and duplicate-safe ledger fulfillment, legacy PayPal refund boundaries, protected Settings destinations and isolated account/profile saves, Settings browser-script compilation and responsive layout, event management, admission modes, Commerce launch interest, unified locations, owner-side editing, Flyer credits, authenticated RSVP photos, historical RSVP linking, attendee-preview states, and duplicate-event behavior against `postgresql://localhost:5432/sge_test`.

Integration tests refuse to run against a database whose name is not `sge_test`. `npm run check:static` validates JavaScript syntax, local imports and assets, public-template placeholders, and browser event-data usage. Run the complete release check with `npm run check`.

## Versioning

Silver Glider Events uses semantic versions in the form `MAJOR.MINOR.PATCH`. The version in `package.json` is canonical, `package-lock.json` must match it, and every production release receives a matching `vMAJOR.MINOR.PATCH` Git tag. User-facing changes are recorded in [`CHANGELOG.md`](CHANGELOG.md). The `/health` response exposes both the application version and deployed commit SHA so a release can be verified without relying on the interface.

For a release, update the package version and changelog, run `npm run check`, commit the release, create the matching annotated tag, deploy, and verify that `/health` reports the expected version and SHA.

## Admin

Set `is_admin=TRUE` on the organizer row, then use:

- `/admin/line`
- `/admin/hosts`
- `/admin/ticketing`
- `/admin/feedback`
- `/admin/invitations`

```sql
UPDATE organizers SET is_admin=TRUE WHERE email='you@example.com';
```

## Deploy to Railway

Production may contain promoted live events. Test locally, run `npm test`, and explicitly check whether a release changes existing pages, shared Cloudinary assets, RSVP/guest data, or outgoing email.

```bash
git rev-parse --short HEAD > .git-sha
railway up --service silver-glider-events
curl https://silver-glider-events-production.up.railway.app/health
```

The health response SHA must match `git rev-parse --short HEAD`. `.git-sha` remaining modified after deployment is expected.

GitHub auto-deploy is not the production path. GitHub HTTPS authentication is active on the current Mac, but repository backup and a direct Railway deployment remain separate operations.
