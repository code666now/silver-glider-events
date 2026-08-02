# Start Here — Silver Glider Events

**Current as of August 2, 2026.** This is the short operational guide for a new Codex chat. Read this file first, then read [`HANDOFF.md`](HANDOFF.md) completely before editing.

Silver Glider Events is a production Express/PostgreSQL app for beautiful event pages, RSVPs, external ticket links, reminders, private parties, Secret Shows, and public host pages. It does not process ticket payments.

## First actions

1. Read `CODEX.md`, `HANDOFF.md`, and `README.md`.
2. Inspect `git status --short` before touching files. Preserve unrelated user changes.
3. Run `npm install` if dependencies are missing.
4. Use a local PostgreSQL database only: `postgresql://localhost:5432/sge_dev`.
5. Keep `NODE_ENV=development` and `REMINDERS_ENABLED=false` locally.
6. Start with `npm run dev` (normally `http://localhost:3100`).
7. Verify `curl http://localhost:3100/health` and run `npm test` before release.

Never point local development, tests, or one-off scripts at Railway Postgres.

## Local services

- No `RESEND_API_KEY`: magic links and other emails print to the console.
- No Cloudinary credentials: cover/flyer/host uploads return 503.
- No `UNSPLASH_ACCESS_KEY`: the free-photo search control is hidden.
- `SESSION_SECRET` is required; use a long local-only value.
- Local uploads use `sg-events-dev/...`; production uses `sg-events/...`.

## Architecture

- CommonJS Node.js + Express 5, raw SQL via `pg`, server-rendered HTML, vanilla JavaScript/CSS.
- No build step and no frontend framework.
- `src/index.js` mounts routes, runs migrations, exposes `/health`, and starts reminder jobs.
- `src/db/migrations/` contains ordered migrations, currently `001` through `016_flyer_presentation_mode.sql`.
- `src/routes/` contains auth, organizer event, public, upload, photo, and admin flows.
- `src/lib/` contains sessions, mailer, calendar, Cloudinary, Unsplash, CSV, escaping, and validation helpers.
- `src/jobs/reminders.js` sends idempotent day-before/day-of reminders.
- Templates use string replacement of escaped `{{PLACEHOLDER}}` values. Follow the existing escaping and safe-URL helpers; do not interpolate host input directly into HTML.

## Public presentation modes

Keep Standard and Flyer behavior isolated.

### Standard

- Template: `src/views/event-public.html`
- Existing desktop/mobile layout must remain unchanged unless a task explicitly targets Standard.
- Gradients can move and uploaded covers can drive the adaptive color palette in `public/js/public-event.js`.
- Explicit effects (`static`, `paper`, `disco`, `fog`, `saloon`) use the shared effect system.

### Flyer

- Template: `src/views/event-public-flyer.html`
- Styles: `public/css/event-public-flyer.css`
- Centered, narrow, poster-first layout; the flyer preserves its aspect ratio and is never cropped.
- Default backdrop: fixed darkened plaster photo at `public/images/flyer-plaster-wall.jpg`.
- `applyCoverPalette()` intentionally returns early on `.flyer-public-page`; do not reintroduce adaptive colors or moving gradients without explicit approval.
- An explicitly chosen event effect can still override the default plaster backdrop.
- Reuse the existing RSVP, external ticket, guests, comments, host, calendar, privacy, and management systems. Do not duplicate endpoints or storage.

## Important product behavior

- Admission supports free RSVP or a displayed price with an optional external ticket URL. There is no native checkout.
- Mobile public pages use a docked RSVP CTA until the inline action/form is reached.
- RSVP expands progressively, can collapse, and confirms with “Your RSVP is confirmed.”
- Private—Link Only events are excluded from public host pages and promotion surfaces.
- Secret Show pages must not query or render protected event details before a valid unlock.
- Named guests, visible first names, and comments are opt-in private-event features.
- Host pages live at `/h/:hostSlug`; public attribution links back to them.
- Public event pages do not show a QR code; QR download belongs in the organizer promotion area.

## Security invariants

- Authorization uses authenticated organizer/database IDs, not editable names or emails.
- Escape host-entered text in organizer and admin HTML.
- Validate external URLs and reject executable schemes.
- Preserve RSVP and confirmation-resend rate limits.
- Preserve Secret Show scrypt hashes, signed versioned cookies, and per-session/per-IP attempt limits.
- Do not expose private-event emails, phones, surnames, IDs, or Secret Show metadata publicly.
- Keep secrets in environment variables only.

## Test expectations

`npm test` currently runs 65 focused tests. Before deploying, run it in full plus `git diff --check`. Add focused tests for presentation-mode isolation, privacy, authorization, validation, or email behavior whenever those areas change.

For UI changes, test desktop and mobile. For changes involving RSVP or email, verify the existing flow rather than creating parallel logic.

## Live-impact check before every deploy

Explicitly determine and tell the user whether the release affects:

- Existing live Standard event pages
- Existing live Flyer event pages
- Shared Cloudinary URLs or local public assets
- RSVP/guest/comment records or capacity counts
- Confirmation/reminder emails
- Public host pages or discovery visibility

Replacing an asset at an existing URL updates every live event using it. Prefer new versioned/local asset paths when the change should be controlled.

## Railway release sequence

Production is live at https://silvergliderevents.com and the direct Railway service is https://silver-glider-events-production.up.railway.app.

1. Inspect the diff and preserve unrelated work.
2. Run `git diff --check` and `npm test`.
3. Commit the intended files. Do not stage the deployment-only `.git-sha` modification.
4. Attempt the requested GitHub push if credentials are available.
5. Write the commit SHA to `.git-sha` and deploy directly:

```bash
git rev-parse --short HEAD > .git-sha
railway up --service silver-glider-events
```

6. Poll the production health endpoint until its `sha` matches the local commit.
7. Smoke-test the changed public asset/flow without mutating live user data.

`.git-sha` is tracked and remaining modified after a deploy is expected.

### Current GitHub limitation

GitHub HTTPS authentication is not configured on this Mac. `git push origin main` currently fails with `could not read Username for 'https://github.com'`. This does **not** mean the Railway deploy failed. Direct `railway up --service silver-glider-events` is the authoritative production deployment path; GitHub credentials should be repaired separately.

## Do not

- Commit `.env`, API keys, cookies, tokens, or production database URLs.
- Develop against production data.
- Rewrite Standard presentation while implementing Flyer-only work.
- Introduce a framework/build pipeline without a clear product reason.
- Remove underlying data or behavior for a visibility-only UI request.
- Deploy before tests and a live-impact review.
