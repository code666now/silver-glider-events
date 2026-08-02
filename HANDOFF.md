# Silver Glider Events — Master Reference

**Last updated:** August 2, 2026

## 1. What it is
Silver Glider Events is a lightweight tool for creating beautiful event pages, collecting RSVPs, linking guests to third-party ticket providers, and sending reminders. It is **Version 1** of a bigger platform, built for independent hosts, promoters, artists, venues, and private gatherings.

- **Live site:** https://silvergliderevents.com (custom domain; the Railway URL https://silver-glider-events-production.up.railway.app still serves the same app)
- **Silver Glider does not process ticket payments.** Hosts can publish free RSVP events or enter a price and link to an external ticket provider. There is no Stripe checkout, ticket inventory, ticket issuing, or payment processing inside this app.

## 2. How to use it (organizer)
1. Go to the site and click **Create your event** → enter your email.
2. You get a **magic-link** email ("sign-in link"). Click it — no password.
3. You're taken to your **Dashboard**. From there: **Create Event**.
4. Fill in title, date, time, venue (only these four are required), then choose a presentation:
   - **Standard** uses a cover image, full event details, and an optional gradient/effect background. **Choose image** opens the local uploader; **Browse free photos** opens Unsplash. The picker separates 4 **Gradients** (**Midnight**, **Aurora**, **Sunset**, **Ocean**) from 5 **Effects**, ordered (**Disco**, **Fog**, **Kraft paper**, **TV static**, **After Hours Saloon**). Every swatch is labeled and the picker shows the selected name. Standard pages keep the existing animated gradients and cover-derived adaptive palette.
   - **Flyer** accepts one poster/flyer upload and renders an isolated, centered, poster-first public page. The flyer is never cropped. The default Flyer backdrop is the fixed, darkened plaster-wall image at `public/images/flyer-plaster-wall.jpg`; Flyer pages deliberately skip cover-derived adaptive colors and gradient movement. An explicitly selected effect can still override that default. The normal RSVP, external-ticket, guest-list, comments, host, calendar, privacy, and organizer-management systems are reused unchanged.
   - The Unsplash picker opens on **Summer** (`pool party`) and includes curated **Silver Glider Picks**, which blend nightlife/live music, colorful summer gatherings, fashion/art, and rooftop dinner imagery. Disco and Fog use optimized Cloudinary-hosted Pexels video loops with static poster fallbacks; effects respect reduced-motion.
   - An optional **Presented by** name. The first one creates a reusable public host page at `/h/<slug>`; future events automatically reuse it. **Settings** controls the host name, unique slug, large header image, logo/avatar, bio, Instagram handle, and website URL. The signed-in account email remains the only email field until a separate Booking Email feature is designed.
   - Description, address, category, capacity, admission, and visibility. Admission can be free RSVP or a displayed price with an optional third-party ticket URL; without a ticket URL, the page can describe an at-door price. **Private — Link Only** events stay off public host pages, discovery, and The Line while remaining accessible to anyone with the direct link. Private events can optionally show a first-name-only guest list, allow one named guest per RSVP, and enable text-only comments. **Secret Show Mode** adds a six-character access-code gate to this same private flow; the Create Event banner is only a shortcut into those existing settings.
5. **Publish.** You get a shareable link and a mobile-first public page. QR download remains an organizer promotion tool and is not shown on the public event page.
6. Manage the event through a focused action bar: **Copy event link**, **View page**, and **Edit** stay visible; **Duplicate** and **Cancel** live under the clearly labeled **Event actions** menu. The QR code expands from the sharing area, **Export CSV** sits with the searchable guest list, and follower email plus **Submit to The Line** share a **Promote your event** card. To declutter the event list, **swipe an event left to Archive** (reversible — guest data always kept); permanent delete lives at the bottom of the manage page behind a double confirm.
7. **Submit to The Line** to request a feature in the Silver Glider SMS/marketing channel (an admin reviews it).
8. Use the quiet **Feedback** button in the bottom-right of any signed-in app page to report a bug, suggestion, or other feedback. Reports automatically include the authenticated host, page, related event when applicable, and browser context.

**You stay logged in for 30 days** on your device (and it auto-extends while you're active), so you won't need a new email every time.

## 3. How guests use it
- Open the event link → tap **RSVP**. On mobile, the RSVP action docks at the bottom until the inline action/form is reached.
- The compact form asks for name first and progressively reveals email; phone and host-update consent remain under **More options**. Guests do not create an account, and the expanded RSVP form can be collapsed.
- They get a **confirmation email with a calendar invite (.ics)** and can add it to their calendar.
- They receive **reminder emails** the day before (4pm) and day of (9am), in the event's time zone.
- If the event hits capacity, RSVPs stop and it shows "Event full."
- Guests can cancel their RSVP from a link in their email (which frees a spot).
- The on-page success message is **“Your RSVP is confirmed.”**
- When a private host enables **Allow guests**, an RSVP can include one named guest with an optional email. Capacity and the displayed attendance total count both the attendee and guest.
- When enabled, the public guest list shows first names only. A fresh RSVP unlocks the comment wall immediately on that browser; the confirmation-email link restores attendee access on another or returning device. Attendees can post or delete their own 300-character comments, while the event host can delete any comment. Existing-email attempts never grant access based on email knowledge alone.
- Secret Shows reveal no title, date, venue, description, metadata, or other event details until the correct code is entered. A signed, time-limited browser cookie remembers the unlock; afterward the guest sees the normal private event page and all enabled RSVP, guest-list, named-guest, comment, share, and calendar features.

## 4. Accounts & services behind it
| Service | What it's for | Notes |
|---|---|---|
| **Railway** | Hosting + database | Project: `silver-glider-events` (its own project + Postgres, separate from the ticketing app) |
| **Resend** | Sending emails | Sends as **"Silver Glider Events" from events@rockandrollschedule.com** (free plan allows 1 domain, shared with Rock & Roll Schedule) |
| **Cloudinary** | Storing cover photos, flyer uploads, host logos/headers, textures, and video effects | Cloud `dhvavjgnw`; production folders include `sg-events/covers`, `sg-events/flyers`, `sg-events/hosts`, `sg-events/hosts/headers`, `sg-events/textures`, and `sg-events/effects`; local uploads use the matching `sg-events-dev/...` folders |
| **Unsplash** | Free photo search in the form | Photographer is auto-credited on the event page; searches use a bounded 30-minute in-memory cache to reduce repeat API calls |

## 5. Login & security (plain English)
- Login is by **magic link** (email). No passwords ever.
- After the first login, a secure **30-day session** keeps you signed in on that browser; it auto-refreshes while you're active.
- Signing out clears it. Requesting too many magic links too fast is rate-limited.
- Public event pages are open to everyone; the organizer dashboard is protected. Secret Shows are private link-only events with a separately stored scrypt code hash, signed versioned unlock cookies, and per-session/per-IP attempt limits. Replacing the code invalidates prior unlocks.
- Public RSVP submissions and confirmation-email resend attempts are rate-limited to reduce spam and fake capacity filling.
- Host/admin-rendered text is escaped before insertion into HTML, and executable URL schemes are rejected. Database IDs from the authenticated session—not editable names or emails—are the authorization source of truth.

## 6. Tech summary (for a developer)
- **Stack:** Node.js + Express 5, PostgreSQL, server-rendered HTML + vanilla JS. No build step, no framework.
- **Repo (local):** `~/silver-glider-events`
- **Entry point:** `src/index.js`
- **Key folders:** `src/routes/` (auth, events, public, uploads, photos, admin), `src/lib/` (mailer, session, calendar/ics, unsplash, cloudinary, slug, csv), `src/jobs/reminders.js` (cron), `src/views/` (HTML pages), `public/` (CSS + JS/assets).
- **Database:** auto-migrations run on startup from `src/db/migrations/*.sql`. Tables: organizers, magic_link_tokens, events, event_secret_codes, rsvps, event_comments, message_log, line_submissions, feedback_submissions, host_invitations.
- **Current migrations:** `001` through `016_flyer_presentation_mode.sql`.
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
4. Commit only after local testing passes. Push when GitHub credentials are available.
5. Before deploying, explicitly report whether the release affects existing live event pages, shared Cloudinary assets, guest lists/RSVPs, outgoing emails/reminders, or only new/local behavior. Replacing an asset at an existing Cloudinary URL affects every live event using it.
6. Deploy to production from `~/silver-glider-events`:

```
git rev-parse --short HEAD > .git-sha && railway up --service silver-glider-events
```

7. Verify `curl https://silver-glider-events-production.up.railway.app/health` — the `sha` in the response should match `git rev-parse --short HEAD` — then perform a small, non-destructive production smoke test. (`.git-sha` stays a tracked-but-modified file each deploy — that's expected.)

**Current machine note:** GitHub HTTPS pushes currently fail because credentials are not configured (`could not read Username for 'https://github.com'`). This is separate from Railway. A direct `railway up --service silver-glider-events` deploy is the authoritative production path; repair GitHub authentication separately and do not mistake a failed push for a failed Railway release.

## 9. What's built (V1 complete)
Magic-link login + persistent sessions · organizer dashboard · Standard and **Flyer Presentation Mode** event creation · local cover/flyer upload + curated Unsplash picker · gradients and texture/video effects · mobile-first public pages · free RSVP plus **external paid-ticket links** (no native payment processing) · progressive, collapsible RSVP form + mobile docked CTA · capacity limits · confirmation email + calendar invite · day-before/day-of reminders · cancellation/manage link · searchable/CSV guest list · duplicate, cancel, archive, and promotion tools · **Private — Link Only** events with optional Secret Show codes, one named guest, first-name-only guest lists, attendance totals, and verified-attendee comments · rich `/h/<slug>` host pages · follower announcements with unsubscribe · Submit to The Line + admin review · authenticated feedback + admin inbox · personalized invitation generator · lightweight super-admin host tracking · branded Privacy Policy/Terms · app-wide output escaping and public-endpoint rate limiting.

**Photo picker (developer note):** Category presets live in `public/js/event-form.js`. **Summer** is the initial category and searches `pool party`. **Silver Glider Picks** runs four tuned Unsplash searches in parallel, requests a proportional share of the 24-photo page from each, interleaves and deduplicates the results, and preserves that query set when loading more. `/api/photos/search` accepts a capped `per_page` value (1–24). `src/lib/unsplash.js` caches search responses in memory for 30 minutes and evicts the oldest entry once the cache reaches 200 keys. The cache is per server instance and does not require Redis at the current single-instance scale.

**Background system (developer note):** `events.background_theme` holds one key—an MVP gradient (`midnight`, `aurora`, `sunset`, `ocean`) or an effect (`static`, `paper`, `disco`, `fog`, `saloon`). `violet` and `ember` are no longer offered or accepted for new saves, but `src/routes/public.js` retains legacy rendering support for already-published events. **Standard pages** use `.bg-theme .bg-<key>` and may receive an image-derived palette from `public/js/public-event.js`; their existing animated behavior is unchanged. **Flyer pages** are isolated in `src/views/event-public-flyer.html` and `public/css/event-public-flyer.css`. Without an explicit effect they use the fixed, grayscale plaster photograph `public/images/flyer-plaster-wall.jpg` under a dark readability veil; `applyCoverPalette()` returns early on `.flyer-public-page`, so no adaptive palette or moving gradient is applied. Explicit effects still render via `.event-bg.fx-<key>` and override the Flyer default. Kraft paper is a Cloudinary photo; After Hours Saloon has isolated warm reading washes; TV static is a canvas mounted in `public-event.js`; Disco and Fog are optimized Cloudinary video loops. Videos use native `autoplay`, `muted`, `loop`, and inline playback, retry after load/first touch, pause in hidden tabs, and fall back to posters for autoplay failure, data-saving mode, or reduced motion. Adding another effect requires a whitelisted key, asset mapping, picker swatch, and fallback; no schema change.

## 10. Open items / things to know
- **Flyer Presentation Mode (updated August 2):** migration `016_flyer_presentation_mode.sql` adds `events.presentation_mode` (`standard` by default) and nullable `flyer_image_url`. Authenticated create/edit uploads artwork to `sg-events[-dev]/flyers` under the existing 5 MB rules. Flyer pages use an isolated centered poster-first template, preserve poster aspect ratio, reuse all existing event systems, and use a fixed local plaster-wall background instead of adaptive cover colors. An explicit event effect still wins. Existing Standard layouts, animations, images, RSVP data, guest lists, and email behavior are unchanged. Confirmation/reminder senders select flyer-focused markup only when a valid flyer exists; Secret Show lock pages never query or render the flyer URL before unlock.
- **Secret Show (July 27):** migration `013_secret_show.sql` adds an off-by-default private-event flag/version and the separate `event_secret_codes` credential table. Hosts enable it inside **Private — Link Only**, set or replace a six-character code, and never see the saved code again. Locked links render a generic, `noindex` cinematic code page before the full event query, so private details never enter HTML, metadata, or public APIs. Codes use scrypt; versioned signed cookies remember valid access and are invalidated when a host changes or disables the code; failed attempts are limited per browser and IP. Secret Shows inherit the normal private RSVP, named-guest, guest-list, comments, share, and calendar flows after unlock and remain excluded from host pages, The Line, and follower announcements.
- **Private Event MVP (deployed July 26):** migration `012_private_event_mvp.sql` adds three opt-in event flags, optional named-guest fields on RSVPs, and the `event_comments` table. Existing events retain their prior behavior because every new flag defaults to false. Private pages send `noindex`; private events are excluded from host pages, follower announcements, and The Line even if they were submitted while public. The organizer view separates RSVP submissions, total people, guests, and comments. Focused privacy/validation tests run with `npm test`.
- **Host account/profile management (July 27):** `/admin/hosts` keeps its newest-first account tracking for creation, last login, event count, confirmed RSVP count, and invitation source. Its compact detail modal now also lets a super-admin edit the same public host identity fields available in Settings and upload a host logo/header. It still does not add account deletion, suspension, impersonation, billing, or CRM controls.
- **Personalized US host invitation generator (deployed July 16):** super-admins can create invitations at `/admin/invitations` using a required host/organization name and one required personal-selection sentence. Each record gets an unguessable `/i/<host-slug>-<random-token>` URL and renders a simplified, mobile-first Fog page with one `Create your first event` CTA. Admins can preview, copy, revoke, and restore links and see `Not joined` or `Joined` with the authenticated organizer identity. The existing magic-link `next` flow preserves the token and marks the invitation joined when the signed-in host reaches event creation, then removes the token from the browser URL. No email sender, bulk tool, analytics dashboard, templates, or CRM workflow was added. Migration: `011_host_invitations.sql`.
- **Private Mexico City invitations (July 15):** unlisted, `noindex` pages at `/invite/dna-studio` (Spanish), `/invite/dna-studio-en` (English), and `/invite/mmmargarita` (Spanish) reuse the proven Fog video/poster effect and personalized copy. The former misspelled `/invite/mmmargaritta` URL redirects to the corrected link. The product CTA enters the existing magic-link flow and returns to event creation; the Spanish-interest CTA clearly asks the recipient to reply to the sender. No Spanish product UI, tracking database, or regular-user navigation was added.
- **Feedback system (deployed July 14):** signed-in hosts get a quiet app-wide feedback bubble with Bug/Suggestion/Other and a message. Submissions use authenticated organizer IDs, snapshot the host contact and page/browser context, validate related-event ownership, and default to `new`. Admins can filter, inspect, open related pages, copy URLs, move reports through `new`, `reviewing`, and `resolved`, and permanently delete individual reports after confirmation at `/admin/feedback`. Migration: `010_feedback_submissions.sql`. Public/anonymous event pages do not show the bubble.
- **Public host pages (expanded July 27):** the create-event form's optional **Presented by** field still creates one reusable organizer identity and a stable `/h/<slug>` page, and public event attribution links back to it. Migration `014_host_page_profiles.sql` adds nullable header image, bio, website, legacy Instagram URL, and a reserved contact-email field plus `updated_at`; migration `015_instagram_handles.sql` adds `instagram_handle` and safely backfills existing Instagram profile URLs without dropping the rollback column. Settings accepts `@handle`, a bare handle, or a pasted Instagram profile URL and stores only the normalized handle; public pages generate the canonical link. It keeps account details immediately visible and presents host-page details as a compact summary card with separate **View page** and expandable **Edit host page** actions; account and host profile have independent save buttons. The redundant contact-email control is intentionally absent—the account email remains the only email in Settings until a clearly labeled Booking Email feature is designed. Any dormant stored value is preserved but never rendered publicly. Hosts and super-admins can edit the remaining profile fields. The public page shows a responsive header or branded fallback, logo or initials, bio, safe icon-only links, upcoming published/public events soonest first, and past published/public events newest first. Draft, private, Secret Show, and cancelled events remain excluded. Host headers upload to `sg-events[-dev]/hosts/headers`; existing logo and event assets are not replaced.
- **Email branding:** emails currently come from `@rockandrollschedule.com` because the free Resend plan allows one verified domain. To send from a Silver Glider address, verify a Silver Glider domain in Resend (needs a paid plan or a second Resend account) — then it's a one-variable change (`RESEND_FROM`).
- **The Line integration is manual for now:** approving a submission flags it; actual cross-promotion is done by hand.
- **Admin access:** The Line review and Feedback inbox are gated by an `is_admin` flag on the organizer row (set directly in the database).
- **Scale triggers (not needed yet):** if the app ever runs on more than one server instance, the in-memory rate limiter would need Redis; a "log out all devices" feature would need a small session-revocation change (a `sessions_valid_after` column). Neither is required at current scale.
- **Automated tests:** `npm test` currently runs **65 focused tests** covering Flyer Mode migration/upload/rendering/email/reminder compatibility, Standard/Flyer presentation isolation, private-event and Secret Show privacy, code hashing, signed unlocks, rate limits, guest counts, named-guest validation, comment length, and public-listing contracts. Broader route/integration coverage is still future work.
- **Repository push:** Railway deployment works directly from this checkout. GitHub HTTPS authentication is currently missing on this Mac, so a `git push` can fail even when production deploys and verifies correctly.

## 11. Future (planned, not in V1)
Native paid ticketing/payment processing (Stripe, issued QR tickets) · multiple brands/cohosts and advanced host analytics (possible Pro tier) · SMS reminders (credit-based) · broader public event discovery. Today, paid admission is only a displayed price plus an optional third-party ticket link; Silver Glider does not process the purchase.
