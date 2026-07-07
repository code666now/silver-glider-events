# Silver Glider Events — Master Reference

**Last updated:** July 6, 2026

## 1. What it is
Silver Glider Events is a free tool for creating beautiful event pages, collecting RSVPs, and sending reminders — think Partiful/Eventbrite but simpler. It is **Version 1** of a bigger platform; paid ticketing is planned for later, and the data model is already built to support it without a rebuild.

- **Live site:** https://silver-glider-events-production.up.railway.app
- **Not a ticketing platform (yet).** V1 is free RSVPs only. No Stripe, no paid tickets.

## 2. How to use it (organizer)
1. Go to the site and click **Create your event** → enter your email.
2. You get a **magic-link** email ("sign-in link"). Click it — no password.
3. You're taken to your **Dashboard**. From there: **Create Event**.
4. Fill in title, date, time, venue (only these four are required). Optionally add:
   - A **cover photo** — upload your own, **search free photos** (Unsplash), or pick one of **6 gradient background themes**.
   - Description, address, category, capacity, and public/private.
5. **Publish.** You get a shareable link, a QR code, and a page that works great on phones.
6. Manage the event: see the **RSVP count and guest list**, search guests, **export CSV**, **duplicate** the event, or **cancel** it.
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
| **Cloudinary** | Storing cover photos | Cloud `dhvavjgnw`, folder `sg-events/covers` |
| **Unsplash** | Free photo search in the form | Photographer is auto-credited on the event page |

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
APP_URL               – https://silver-glider-events-production.up.railway.app
NODE_ENV=production
RESEND_API_KEY        – email sending
RESEND_FROM           – Silver Glider Events <events@rockandrollschedule.com>
CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
UNSPLASH_ACCESS_KEY   – photo search
REMINDERS_ENABLED=true
```
Never put secrets in code — Railway variables only.

## 8. How to deploy a change
From `~/silver-glider-events`:
```
git rev-parse --short HEAD > .git-sha && railway up --service silver-glider-events
```
Then verify: `curl https://silver-glider-events-production.up.railway.app/health` — the `sha` in the response should match `git rev-parse --short HEAD`. (`.git-sha` stays a tracked-but-modified file each deploy — that's expected.)

## 9. What's built (V1 complete)
Magic-link login + persistent sessions · organizer dashboard · event creation with cover upload / Unsplash search / gradient themes · beautiful mobile-first public event pages (two-column on desktop) · RSVP with capacity limits · email confirmation + calendar invite · day-before & day-of email reminders · guest list, search, CSV export, duplicate, cancel · QR codes · share buttons · "Submit to The Line" + admin review · animated backgrounds throughout.

## 10. Open items / things to know
- **Email branding:** emails currently come from `@rockandrollschedule.com` because the free Resend plan allows one verified domain. To send from a Silver Glider address, verify a Silver Glider domain in Resend (needs a paid plan or a second Resend account) — then it's a one-variable change (`RESEND_FROM`).
- **The Line integration is manual for now:** approving a submission flags it; actual cross-promotion is done by hand.
- **Admin access:** The Line review is gated by an `is_admin` flag on the organizer row (set directly in the database).
- **Scale triggers (not needed yet):** if the app ever runs on more than one server instance, the in-memory rate limiter would need Redis; a "log out all devices" feature would need a small session-revocation change (a `sessions_valid_after` column). Neither is required at current scale.
- **No automated tests yet.**

## 11. Future (planned, not in V1)
Paid ticketing (Stripe, QR tickets) · organizer profiles & analytics (Pro tier) · SMS reminders (credit-based) · public event discovery page. The event data model already reserves an `admission_type` field (`free_rsvp` now; `paid`, `donation`, `door`, `vip` reserved) so paid ticketing can be layered on without rebuilding events.
