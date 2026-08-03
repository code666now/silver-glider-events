# Silver Glider Events

Silver Glider Events is a lightweight event publishing and RSVP platform for independent hosts, promoters, artists, venues, and private gatherings.

Hosts can publish a Standard event page or a poster-first Flyer page, collect free RSVPs, link to an external ticket provider, manage guest lists, send reminders, and maintain a public host page. Silver Glider does **not** process ticket payments or issue tickets in this MVP.

- Live: https://silvergliderevents.com
- Railway: https://silver-glider-events-production.up.railway.app
- Full product and operations reference: [`HANDOFF.md`](HANDOFF.md)
- New-agent starting guide: [`CODEX.md`](CODEX.md)

## Stack

- Node.js and Express 5 (CommonJS)
- PostgreSQL via `pg`
- Server-rendered HTML plus vanilla JavaScript and CSS
- Resend for email
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

- Passwordless host authentication with 30-day sliding sessions
- Organizer dashboard, archive/restore, duplicate, cancel, CSV export, and promotion tools
- Mobile-first organizer flows with expanded desktop Home, My Events, Settings, create/edit, and event-management workspaces
- Standard events with uploaded/Unsplash covers, gradients, and texture/video effects
- Flyer events with a centered, uncropped poster-first public layout
- Free RSVP and external paid-ticket links; no native payment processing
- Progressive RSVP form, mobile docked CTA, capacity enforcement, cancellation links, and confirmation resends
- Artwork-led RSVP confirmation emails with adaptive color treatment, linked host/vibe identity, conditional details, and calendar attachments; separate day-before/day-of reminders
- Public and Private—Link Only visibility
- Optional named guest, first-name-only guest list, and verified-attendee comments for private events
- Optional six-character Secret Show gate
- Public host pages at `/h/:hostSlug`
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

RSVP confirmations use a separate, table-based 620px email layout in `src/lib/mailer.js`. Event artwork is full-width and uncropped; Cloudinary-hosted landscape images receive a predominant-color padded 620×560 JPEG canvas while portrait images preserve their natural ratio. The selected event theme supplies a dark outer tint. Static effect posters are used only when no artwork exists, and email markup never embeds motion. Title, host, listening link, and date/time/venue rows are conditional; reminder timing, RSVP logic, calendar attachments, manage links, and event URLs are unchanged.

## Project layout

```text
src/index.js                 bootstrap, routes, health check, reminder cron
src/db/migrations/           numbered SQL migrations (currently 001–016)
src/routes/                  auth, organizer events, public events/hosts, uploads, photos, admin
src/lib/                     mailer (including adaptive RSVP confirmations), sessions, calendar, CSV, Cloudinary, Unsplash, escaping
src/jobs/reminders.js        idempotent day-before and day-of reminder job
src/views/                   server-rendered HTML templates
public/css/                  brand and page styles
public/js/                   browser behavior
public/images/               local presentation assets
test/                        focused Node test suite
```

## Key mechanics

- **Authentication:** one-time 15-minute magic-link token becomes a signed, httpOnly 30-day session cookie. Attendees do not create accounts.
- **Capacity:** the RSVP endpoint locks the event row and counts attendance inside the transaction before confirming.
- **Reminder idempotency:** `message_log` has a partial unique index; a reminder sends only after a successful claim.
- **Privacy:** private and Secret Show events are excluded from public host pages and promotion surfaces. Secret Show details are not rendered before unlock.
- **Security:** host/admin output is escaped, executable URL schemes are rejected, and public RSVP/resend endpoints are rate-limited.

## Tests

```bash
npm test
npm run check:static
```

As of August 2, 2026, the suite contains 69 tests. The 65 focused tests cover Flyer/Standard isolation, uploads and emails, private-event visibility, Secret Show security, rate limits, named guests, comments, listing contracts, and the event editor's desktop/mobile layout. Four HTTP/PostgreSQL integration tests exercise authenticated event creation, Standard/Flyer/host rendering, locked and unlocked Secret Shows, RSVP capacity transactions, and confirmation dispatch against `postgresql://localhost:5432/sge_test`.

Integration tests refuse to run against a database whose name is not `sge_test`. `npm run check:static` validates JavaScript syntax, local imports and assets, public-template placeholders, and browser event-data usage. Run the complete release check with `npm run check`.

## Admin

Set `is_admin=TRUE` on the organizer row, then use:

- `/admin/line`
- `/admin/hosts`
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

GitHub auto-deploy is not the production path. On the current Mac, GitHub HTTPS credentials are not configured, so `git push` may fail independently of a successful direct Railway deployment.
