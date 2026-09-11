# Start Here — Silver Glider Events

**Current as of September 10, 2026.** This is the short operational guide for a new Codex chat. Read this file first, then read [`HANDOFF.md`](HANDOFF.md) completely before editing.

Silver Glider Events is a production Express/PostgreSQL app for beautiful event pages, RSVPs, external ticket links, reminders, private parties, Secret Shows, and public host pages. It does not process ticket payments.

## First actions

1. Read `CODEX.md`, `HANDOFF.md`, and `README.md`.
2. Inspect `git status --short` before touching files. Preserve unrelated user changes.
3. Run `npm install` if dependencies are missing.
4. Use local PostgreSQL only: `sge_dev` for development and the dedicated `sge_test` database for tests.
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
- `src/db/migrations/` contains ordered migrations, currently `001` through `035_familiar_faces.sql`.
- `src/routes/` contains auth, organizer event, public event, public host, upload, photo, and admin flows. Public host pages are isolated in `public-hosts.js`; guest event/RSVP flows remain in `public.js`.
- `src/lib/` contains sessions, mailer, calendar, Cloudinary, Unsplash, CSV, escaping, and validation helpers.
- `src/jobs/reminders.js` sends idempotent day-before/day-of reminders.
- Templates use string replacement of escaped `{{PLACEHOLDER}}` values. Follow the existing escaping and safe-URL helpers; do not interpolate host input directly into HTML.

## Responsive organizer workspaces

- Mobile remains the baseline and must not regress. Desktop enhancements begin at the existing large-screen breakpoints rather than replacing the mobile DOM or interaction flow.
- Home, My Events, Settings, create/edit, and event management expand into wider desktop compositions. My Events uses a two-column upcoming-event grid; the event editor separates Page Design from Event Information; the Secret Show prompt spans the editor; and event management pairs artwork with a structured action panel above the full-width Familiar Faces view.
- The Standard editor keeps background choices visible after a cover is selected. Local upload and free-photo browsing remain separate actions.
- On desktop, keep **Create Event** in the My Events page header. The event-management promotion panel uses descriptive action rows and a distinct editorial-opportunity block rather than an undifferentiated pill group.
- Free-photo modals must sit above native date/time controls and other form UI. Preserve the corrected stacking and modal isolation.

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
- Follow Host V1 reuses `organizers` as the shared authenticated identity. A follower-only row has no `org_name`/`public_slug`, so following never creates a Host Page. Signed-out follows use a server-stored `follow_host` magic-link intent; signed-in follows complete immediately. `/following` is an authenticated list only—no feed or recommendations.
- Authenticated `host_follows` and legacy RSVP `organizer_optin` announcement recipients are deliberately separate in V1. Do not merge their consent, unsubscribe, or email behavior without an explicit product migration.
- Event management renders Familiar Faces from event RSVPs and prior invitation logs. Reusable photos come only from an RSVP's verified `account_id`; never join arbitrary RSVP email input directly to an account image. When no verified photo exists, reuse the established attendee emoji palette and derive the fallback server-side so it stays consistent without exposing the identity seed. Direct event invitations may use confirmed primary RSVPs even when `organizer_optin` is false; source-first and target-first invites must recheck ownership, opt-outs, current target RSVPs, and previous delivery on the server. Keep `organizer_optin` limited to broader follower announcements and keep SMS on its separate event-specific consent.
- Public event pages do not show a QR code; QR download belongs in the organizer promotion area.

## RSVP confirmation email

- `src/lib/mailer.js` renders RSVP confirmations with a dedicated, table-based 620px layout. Shared reminder and activation-email layouts remain separate.
- The small Silver Glider mark is a platform signature. Event artwork is the primary visual and spans up to 620px; text/details retain readable inner gutters.
- Managed Cloudinary landscape artwork uses a derived JPEG with predominant-color padding (`b_auto` + `c_pad`) on a 620×560 canvas. The original composition is contained without cropping. Portrait artwork remains uncropped and keeps its natural aspect ratio.
- The email shell remains fixed black with neutral dark cards. The saved artwork accent colors the primary CTA; a lighter contrast-safe tint from the same hue colors confirmation status, linked identity, Music vibe, and secondary action labels/icons. Invalid or unusable accents fall back to Silver Glider teal. Disco, Fog, Kraft paper, and After Hours Saloon use static poster imagery only when an event has no cover/flyer artwork. Never put video, MP4, animated GIF, CSS motion, or critical background images into confirmation email markup.
- Title and optional linked host attribution sit outside the details card. A valid `event_vibe_url` adds **Listen here**. Date, time, venue, maps, host, vibe, and artwork rows are omitted when unavailable.
- Keep the CTA at least 48px high and full-width on mobile. Preserve inline critical styles, nested presentation tables, Outlook's conditional 620px wrapper, system-font fallbacks, high contrast, and safe HTTP(S) URL validation.
- RSVP sending, resend limits, calendar attachment, reminders, manage link, and attendee/event URL logic must remain unchanged unless a task explicitly targets them. Previously delivered email cannot change when an event is edited; a new confirmation/resend renders the current event data.
- Guests without a saved avatar may receive the secondary **Add your photo** block. It must use one-time magic-link authentication and save only to the persistent account avatar; guests with an existing avatar must not be prompted again.

## Security invariants

- Authorization uses authenticated organizer/database IDs, not editable names or emails.
- Escape host-entered text in organizer and admin HTML.
- Validate external URLs and reject executable schemes.
- Preserve RSVP and confirmation-resend rate limits.
- Preserve Secret Show scrypt hashes, signed versioned cookies, and per-session/per-IP attempt limits.
- Do not expose private-event emails, phones, surnames, IDs, or Secret Show metadata publicly.
- Keep secrets in environment variables only.
- `GET /auth/verify` stays read-only (Continue page); only the POST signs in. Sign-in tokens and codes are stored as hashes via `src/lib/sign-in-challenges.js`.
- Route ownership checks use `req.sessionAccount` (revocation-aware), not `parseSession`. Guest verification is checked with `guestVerifiedFor(guest, eventId)`; invitation links verify one event only.
- The Add your photo link grants the photo-only `sge_photo` cookie, never `sge_session`. See HANDOFF → "Sign-in, sessions, and returning guests — rules to keep".

## Test expectations

`npm test` currently runs 241 tests: 195 focused unit/source-contract tests and 46 HTTP/PostgreSQL integration tests. The integration suite waits for background confirmation emails (`settleBackgroundWork`) before each database reset; start any new fire-and-forget work with `runInBackground` in `src/routes/public.js` so it stays covered. Emails are never sent locally; integration tests read links and codes from `mailer.devOutbox`. Create the dedicated local database once with `createdb sge_test`; integration tests reject any database URL that does not end in `sge_test`. Before deploying, run `npm run check` plus `git diff --check`.

`npm run check:static` validates JavaScript syntax, local imports/assets, public-template placeholders, and unused browser event-data fields. `npm run test:unit` and `npm run test:integration` can be run separately while debugging.

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
2. For a user-facing release, update the semantic version in `package.json` and `package-lock.json`, record it in `CHANGELOG.md`, and use the matching `vMAJOR.MINOR.PATCH` Git tag. The package version is canonical.
3. Run `git diff --check` and `npm run check`.
4. Commit the intended files. Do not stage the deployment-only `.git-sha` modification.
5. Create the annotated release tag and attempt the requested GitHub push if credentials are available.
6. Write the commit SHA to `.git-sha` and deploy directly:

```bash
git rev-parse --short HEAD > .git-sha
railway up . --path-as-root --service silver-glider-events
```

The explicit application path and `--path-as-root` are required because the parent workspace has unrelated ignore rules that exclude deployable image assets.

7. Poll the production health endpoint until its `version` and `sha` match the local release. A production health check must also remain `ok`; `asset_error` means the logo or an email action icon was omitted or corrupted during deployment.
8. Smoke-test the changed public asset/flow without mutating live user data.

`.git-sha` is tracked and remaining modified after a deploy is expected.

### GitHub

GitHub CLI authentication works for `code666now` over HTTPS, and `origin` points at `https://github.com/code666now/silver-glider-events`. Claude Code also works in this repository through `claude/*` branches and pull requests, so `git pull` before starting. A GitHub push never deploys; `railway up . --path-as-root --service silver-glider-events` remains the only production deployment path.

## Do not

- Commit `.env`, API keys, cookies, tokens, or production database URLs.
- Develop against production data.
- Rewrite Standard presentation while implementing Flyer-only work.
- Introduce a framework/build pipeline without a clear product reason.
- Remove underlying data or behavior for a visibility-only UI request.
- Deploy before tests and a live-impact review.
