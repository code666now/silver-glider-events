# Silver Glider Events — Master Reference

**Last updated:** July 13, 2026

## 1. What it is
Silver Glider Events is a free tool for creating beautiful event pages, collecting RSVPs, and sending reminders — think Partiful/Eventbrite but simpler. It is **Version 1** of a bigger platform; paid ticketing is planned for later, and the data model is already built to support it without a rebuild.

- **Live site:** https://silvergliderevents.com (custom domain; the Railway URL https://silver-glider-events-production.up.railway.app still serves the same app)
- **Not a ticketing platform (yet).** V1 is free RSVPs only. No Stripe, no paid tickets.

## 2. How to use it (organizer)
1. Go to the site and click **Create your event** → enter your email.
2. You get a **magic-link** email ("sign-in link"). Click it — no password.
3. You're taken to your **Dashboard**. From there: **Create Event**.
4. Fill in title, date, time, venue (only these four are required). Optionally add:
   - A **cover photo** — upload your own, **search free photos** (Unsplash), or pick a **background**. The picker separates 4 **Gradients** (**Midnight**, **Aurora**, **Sunset**, **Ocean**) from 4 **Effects**, ordered from broadest to most experimental (**Disco**, **Fog**, **Kraft paper**, **TV static**). Every swatch is labeled and the picker shows the currently selected name. Disco and Fog use optimized Cloudinary-hosted Pexels video loops, with static poster fallbacks. The photo picker opens on **Summer** (`pool party`) and includes curated **Silver Glider Picks**, which blend nightlife/live music, colorful summer gatherings, fashion/art, and rooftop dinner imagery. Effects are free, sit behind the whole page, and respect reduced-motion.
   - Description, address, category, capacity, and public/private.
5. **Publish.** You get a shareable link, a QR code, and a page that works great on phones.
6. Manage the event through a focused action bar: **Copy event link**, **View page**, and **Edit** stay visible; **Duplicate** and **Cancel** live under the clearly labeled **Event actions** menu. The QR code expands from the sharing area, **Export CSV** sits with the searchable guest list, and follower email plus **Submit to The Line** share a **Promote your event** card. To declutter the event list, **swipe an event left to Archive** (reversible — guest data always kept); permanent delete lives at the bottom of the manage page behind a double confirm.
7. **Submit to The Line** to request a feature in the Silver Glider SMS/marketing channel (an admin reviews it).

**You stay logged in for 30 days** on your device (and it auto-extends while you're active), so you won't need a new email every time.

## 3. How guests use it
- Open the event link → tap **RSVP**.
- Enter first name, last name, email (phone optional). No account needed.
- They get a **confirmation email with a calendar invite (.ics)** and can add it to their calendar.
- They receive **reminder emails** the day before (4pm) and day of (9am), in the event's time zone.
- If the event hits capacity, RSVPs stop and it shows "Event full."
- Guests can cancel their RSVP from a link in their email (which frees a spot).

## 4. Accounts & services behind it
| Service | What it's for | Notes |
|---|---|---|
| **Railway** | Hosting + database | Project: `silver-glider-events` (its own project + Postgres, separate from the ticketing app) |
| **Resend** | Sending emails | Sends as **"Silver Glider Events" from events@rockandrollschedule.com** (free plan allows 1 domain, shared with Rock & Roll Schedule) |
| **Cloudinary** | Storing cover photos, textures, and video effects | Cloud `dhvavjgnw`; folders `sg-events/covers`, `sg-events/textures`, and `sg-events/effects` |
| **Unsplash** | Free photo search in the form | Photographer is auto-credited on the event page; searches use a bounded 30-minute in-memory cache to reduce repeat API calls |

## 5. Login & security (plain English)
- Login is by **magic link** (email). No passwords ever.
- After the first login, a secure **30-day session** keeps you signed in on that browser; it auto-refreshes while you're active.
- Signing out clears it. Requesting too many magic links too fast is rate-limited.
- Public event pages are open to everyone; the organizer dashboard is protected.

## 6. Tech summary (for a developer)
- **Stack:** Node.js + Express 5, PostgreSQL, server-rendered HTML + vanilla JS. No build step, no framework.
- **Repo (local):** `~/silver-glider-events`
- **Entry point:** `src/index.js`
- **Key folders:** `src/routes/` (auth, events, public, uploads, photos, admin), `src/lib/` (mailer, session, calendar/ics, unsplash, cloudinary, slug, csv), `src/jobs/reminders.js` (cron), `src/views/` (HTML pages), `public/` (CSS + JS).
- **Database:** auto-migrations run on startup from `src/db/migrations/*.sql`. Tables: organizers, magic_link_tokens, events, rsvps, message_log, line_submissions.
- **Health check:** `GET /health` returns `{status:"ok", sha:"..."}`.

## 7. Environment variables (set in Railway)
```
DATABASE_URL          – Postgres (Railway reference)
SESSION_SECRET        – signs login cookies
APP_URL               – https://silvergliderevents.com (base for email/QR/calendar links)
NODE_ENV=production
RESEND_API_KEY        – email sending
RESEND_FROM           – Silver Glider Events <events@rockandrollschedule.com>
CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
UNSPLASH_ACCESS_KEY   – photo search
REMINDERS_ENABLED=true
```
Never put secrets in code — Railway variables only.

## 8. How to deploy a change
Production may contain promoted events, so the MVP workflow is **local first, production second**:

1. Run and test the change locally at `http://localhost:3100` against `postgresql://localhost:5432/sge_dev`.
2. Keep `NODE_ENV=development` and `REMINDERS_ENABLED=false` locally. Never use the Railway production database for development or test data.
   Local cover uploads automatically go to `sg-events-dev/covers`; production covers remain in `sg-events/covers`.
3. Verify `/health` and the specific organizer/guest flows affected by the change.
4. Commit and push only after local testing passes.
5. Before deploying, explicitly report whether the release affects existing live event pages, shared Cloudinary assets, guest lists/RSVPs, outgoing emails/reminders, or only new/local behavior. Replacing an asset at an existing Cloudinary URL affects every live event using it.
6. Deploy to production from `~/silver-glider-events`:

```
git rev-parse --short HEAD > .git-sha && railway up --service silver-glider-events
```

7. Verify `curl https://silver-glider-events-production.up.railway.app/health` — the `sha` in the response should match `git rev-parse --short HEAD` — then perform a small, non-destructive production smoke test. (`.git-sha` stays a tracked-but-modified file each deploy — that's expected.)

## 9. What's built (V1 complete)
Magic-link login + persistent sessions · organizer dashboard · event creation with cover upload / **curated Unsplash photo picker** (Summer default, mixed Silver Glider Picks, category browsing, custom search, infinite scroll) / gradient themes / **background effects (TV static, kraft paper, Disco video, Fog video)** · beautiful mobile-first public event pages (two-column on desktop) · RSVP with capacity limits · email confirmation + calendar invite · day-before & day-of email reminders · guest list, search, CSV export, duplicate, cancel · **swipe-to-archive on the events list** (reversible; permanent delete behind a double confirm on the manage page) · QR codes · share buttons · **follower announcements** (organizer-triggered "Email my followers" to guests who opted in, with unsubscribe) · "Submit to The Line" + admin review · animated backgrounds throughout.

**Photo picker (developer note):** Category presets live in `public/js/event-form.js`. **Summer** is the initial category and searches `pool party`. **Silver Glider Picks** runs four tuned Unsplash searches in parallel, requests a proportional share of the 24-photo page from each, interleaves and deduplicates the results, and preserves that query set when loading more. `/api/photos/search` accepts a capped `per_page` value (1–24). `src/lib/unsplash.js` caches search responses in memory for 30 minutes and evicts the oldest entry once the cache reaches 200 keys. The cache is per server instance and does not require Redis at the current single-instance scale.

**Background system (developer note):** `events.background_theme` holds one key — an MVP gradient (`midnight`, `aurora`, `sunset`, `ocean`) or an effect (`static`, `paper`, `disco`, `fog`). `violet` and `ember` are no longer offered or accepted for new saves, but `src/routes/public.js` retains legacy rendering support for already-published events. Gradients use the `.bg-theme .bg-<key>` classes (+ an image-derived palette when there's a cover, applied client-side in `public-event.js`). Effects render via `.event-bg.fx-<key>` and bypass the palette: **kraft paper** is a Cloudinary photo (`sg-events/textures/kraft-paper`) with a baked-in dark overlay; **TV static** is a canvas mounted in `public-event.js`; **Disco** and **Fog** are Cloudinary video assets (`sg-events/effects/disco`, sourced from Pexels file `6982940-uhd_2880_2160_25fps.mp4`; and `sg-events/effects/fog`, sourced from the faster vertical Pexels file `16011289_1080_1920_30fps.mp4`) delivered as progressive H.264 MP4s with automatic eco quality and a 1280px width limit for mobile reliability. Video effects use native `autoplay`, `muted`, `loop`, and inline-playback attributes for mobile Safari, with JavaScript retries on load and the first touch when autoplay is blocked; they pause when the tab is hidden and stay on the static poster when autoplay fails, data-saving mode is enabled, or `prefers-reduced-motion` is enabled. All effects add a darkening `.fx-veil` (paper uses the lighter `.fx-veil-soft`). Adding another video effect requires a new whitelisted key, Cloudinary asset mapping, picker swatch, and fallback poster; no schema change.

## 10. Open items / things to know
- **Email branding:** emails currently come from `@rockandrollschedule.com` because the free Resend plan allows one verified domain. To send from a Silver Glider address, verify a Silver Glider domain in Resend (needs a paid plan or a second Resend account) — then it's a one-variable change (`RESEND_FROM`).
- **The Line integration is manual for now:** approving a submission flags it; actual cross-promotion is done by hand.
- **Admin access:** The Line review is gated by an `is_admin` flag on the organizer row (set directly in the database).
- **Scale triggers (not needed yet):** if the app ever runs on more than one server instance, the in-memory rate limiter would need Redis; a "log out all devices" feature would need a small session-revocation change (a `sessions_valid_after` column). Neither is required at current scale.
- **No automated tests yet.**

## 11. Future (planned, not in V1)
Paid ticketing (Stripe, QR tickets) · organizer profiles & analytics (Pro tier) · SMS reminders (credit-based) · public event discovery page. The event data model already reserves an `admission_type` field (`free_rsvp` now; `paid`, `donation`, `door`, `vip` reserved) so paid ticketing can be layered on without rebuilding events.
