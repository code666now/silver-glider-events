# Start Here (for an AI agent picking this up cold)

You are continuing work on **Silver Glider Events**, a Node.js/Express app for free RSVP event pages. Read this first, then `HANDOFF.md` for the full picture.

## First actions
1. Read `HANDOFF.md` (complete reference: features, services, env vars, deploy).
2. `npm install`
3. Create a local database and env file (see "Local setup" below).
4. `node src/index.js` → boots on `http://localhost:3100`. Migrations run automatically on startup.
5. Sanity check: `curl localhost:3100/health` → `{"status":"ok",...}`.

## Local setup (never develop against production)
- **Database:** local Postgres. `createdb sge_dev`, then set `DATABASE_URL=postgresql://localhost:5432/sge_dev`.
- **Env:** copy `.env.example` to `.env` and fill in. For local dev you can leave `RESEND_API_KEY`, `CLOUDINARY_*`, and `UNSPLASH_ACCESS_KEY` blank:
  - No `RESEND_API_KEY` → magic-link and other emails are printed to the console instead of sent (grep the server log for the link).
  - No `CLOUDINARY_*` → cover uploads return 503 (gradient themes and Unsplash still work if keys are set).
  - No `UNSPLASH_ACCESS_KEY` → the "Search free photos" button hides itself.
- `SESSION_SECRET` is required (any long random string locally).
- **Production DB/services live on Railway.** Do not run migrations, tests, or scripts against them.

## Architecture (what to know before editing)
- **No build step, no framework.** Express serves static HTML from `src/views/` and browser JS/CSS from `public/`. Pages are server-rendered by string-replacing `{{PLACEHOLDER}}` tokens (see `src/routes/public.js` for the event page).
- **Routing:** `src/index.js` mounts route modules and defines page routes. App pages are guarded server-side by `requireOrganizer` / `requireAdmin`; public pages (`/e/:slug`, `/unsubscribe`) are open.
- **Auth:** magic link → stateless HMAC-signed session cookie (`src/lib/session.js`), 30-day, httpOnly, sliding refresh. No password, no session table.
- **DB:** raw SQL via `pg` (`src/config/db.js`). Schema changes = add a new numbered file in `src/db/migrations/` (e.g. `005_*.sql`); the runner applies unran files on startup and records them in `schema_migrations`.
- **Email:** `src/lib/mailer.js` (Resend). All emails share the `layout()` helper.
- **External services:** `src/lib/cloudinary.js` (cover uploads), `src/lib/unsplash.js` (photo search), `src/lib/calendar.js` (.ics invites).
- **Cron:** `src/jobs/reminders.js` (day-before / day-of reminders, idempotent via `message_log`).

## Conventions
- CommonJS (`require`/`module.exports`), not ESM.
- Keep secrets in env vars only — never hardcode keys (there's a cautionary tale in the sibling repo about a committed Cloudinary secret).
- Match existing style: small route handlers, `try/catch` → `next(err)`, validation helpers that whitelist fields.
- Brand tokens are in `public/css/brand.css` (dark theme, teal `#1CC5BE`, Sulphur Point + Montserrat).

## Deploy (Railway)
Production is live and may have promoted events. Use this release sequence for every change:

1. Develop and test locally at `http://localhost:3100` using the local `sge_dev` database.
2. Keep local `REMINDERS_ENABLED=false`; never point local development at Railway Postgres.
3. Verify `/health` plus the specific organizer and guest flows affected by the change.
4. Commit and push only after local verification.
5. Deploy to Railway only when the change is ready for live users.
6. Confirm production `/health` returns the deployed commit SHA and perform a non-destructive smoke test.

```
git rev-parse --short HEAD > .git-sha && railway up --service silver-glider-events
```
Verify: `curl https://silver-glider-events-production.up.railway.app/health` — the returned `sha` must match `git rev-parse --short HEAD`. `.git-sha` is tracked and shows as modified each deploy; that's expected. GitHub auto-deploy is not the deploy path — use `railway up`.

## Do NOT
- Commit `.env` or any real API keys.
- Point local dev at the production database.
- Add a build pipeline / framework without a clear reason — the no-build simplicity is intentional.
