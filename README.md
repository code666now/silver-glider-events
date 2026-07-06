# Silver Glider Events

Beautiful event pages, RSVPs, and email reminders for independent organizers. V1 of the Silver Glider Events platform — free RSVP events only; the `admission_type` column on `events` is the hook for paid ticketing later (`free_rsvp` today; `paid`, `donation`, `door`, `vip` reserved).

## Stack

Node.js, Express 5, CommonJS, PostgreSQL (`pg`), Resend (email), Cloudinary (cover images), `ics` + `qrcode`, `node-cron`. No build step. Server-rendered HTML + vanilla JS, same idiom as `uht-app` and `silver-glider-tickets`.

## Run locally

```bash
createdb sge_dev
cp .env.example .env   # fill SESSION_SECRET (openssl rand -hex 32)
npm install
npm run dev            # http://localhost:3100
```

Migrations run automatically on boot. With `RESEND_API_KEY` empty, magic links are printed to the console instead of emailed.

## Layout

```
src/index.js              # bootstrap: migrate → routes → listen → reminder cron
src/db/migrations/        # numbered .sql files, applied in order, tracked in schema_migrations
src/routes/               # auth (magic links), events (organizer API), public (/e/:slug, RSVP), uploads, admin (The Line)
src/lib/                  # mailer (Resend), session (HMAC cookie), slug, calendar (.ics), csv, cloudinary
src/jobs/reminders.js     # hourly cron; day-before 4pm + day-of 9am, event-local time
src/views/                # served HTML pages
public/                   # css tokens (brand.css), page JS
```

## Key mechanics

- **Auth**: magic link → one-time token (15 min, burned on use) → stateless HMAC session cookie (30 days). Attendees never log in; they get a `manage_token` link to cancel.
- **Capacity**: RSVP endpoint locks the event row (`SELECT … FOR UPDATE`) and counts confirmed RSVPs inside the transaction — 409 `{error:'full'}` at capacity. Cancelling frees the slot.
- **Reminder idempotency**: partial unique index on `message_log (rsvp_id, message_type, channel)`; the cron claims with `INSERT … ON CONFLICT DO NOTHING RETURNING id` and only sends on a successful claim. Double-sends are impossible.
- **Private events**: 16-char hex slug, never listed. The link is the access control.

## Deploy (Railway)

1. New Railway project → add PostgreSQL → new service from this repo.
2. Set env vars: `DATABASE_URL` (reference variable), `SESSION_SECRET`, `APP_URL` (public domain), `NODE_ENV=production`, `RESEND_API_KEY`, `RESEND_FROM`, `CLOUDINARY_*`.
3. **Resend domain must be verified before launch** — magic-link login depends on email delivery.
4. Deploy: `git rev-parse --short HEAD > .git-sha && railway up` (buildCommand in railway.toml also writes `.git-sha`).
5. Verify: `curl https://<domain>/health` — SHA should match `git rev-parse --short HEAD`.

## Admin

Set `is_admin=TRUE` on your organizer row to see The Line review queue at `/admin/line`:

```sql
UPDATE organizers SET is_admin=TRUE WHERE email='you@example.com';
```
