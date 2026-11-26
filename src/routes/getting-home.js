'use strict';

const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const pool = require('../config/db');
const { eventEndAtSql } = require('../lib/post-event');
const { attendeeCookieName, readCookie } = require('../lib/private-events');
const { readGuestSession, guestVerifiedFor } = require('../lib/guest-session');
const { createRateLimiter, clientIp } = require('../lib/rate-limit');
const { sendHtmlFile } = require('../lib/static-assets');
const { render404 } = require('../lib/public-html');
const { sameOriginMutation } = require('../middleware/requireOrganizer');
const { createGettingHome, gettingHomeEnabled, gettingHomeEligible, sfGettingHomeEligible, planningWindowEnd, readTransitSelection } = require('../lib/transit/getting-home');
const { createSfCoverageStore } = require('../lib/transit/sf-coverage-store');
const { isSfRolloutEnabled } = require('../lib/transit/sf-rollout');
const { RideReminderError, RIDE_SMS_CONSENT } = require('../lib/transit/ride-reminders');
const { rideReminders } = require('../jobs/transit-ride-reminders');
const { createSavedRouteService } = require('../lib/transit/saved-route');
const { createRideEntry, rideEntryCookieName } = require('../lib/transit/ride-entry');
const { createRideMetrics, TRANSPORTATION_INTERACTION_KINDS } = require('../lib/transit/ride-metrics');
const { createRidePreview, PREVIEW_SLUG, PREVIEW_PATH, PREVIEW_COOKIE,
  createCityRidePreview, CITY_PREVIEW_SLUG, CITY_PREVIEW_PATH, CITY_PREVIEW_COOKIE } = require('../lib/transit/ride-preview');

const PAGE = '/e/:slug/getting-home';
const API = '/api/public/events/:slug/getting-home';
const VIEW = path.join(__dirname, '../views/getting-home.html');
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const networkKey = crypto.randomBytes(32);

function protectResponse(res) {
  res.set('Cache-Control', 'private, no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Robots-Tag', 'noindex, nofollow');
}

function unavailableEmailPlan(res) {
  return res.status(404).send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1"><title>Getting Home unavailable</title>
    <link rel="stylesheet" href="/css/brand.css"></head><body><main class="sg-container" style="max-width:440px;margin:12vh auto;padding:24px">
    <h1>Getting Home is unavailable</h1><p>This link may have expired or the event or transit options may have changed.</p>
    <p>Check your event for directions or check the transit operator before you leave.</p>
    <p><a href="/dashboard">Back to Silver Glider</a></p></main></body></html>`);
}

async function loadEligibleGettingHomeEvent(db, slug, { env, now, allowSf = false }) {
  if (!gettingHomeEnabled(env) || typeof slug !== 'string' || !/^[a-z0-9-]{1,120}$/i.test(slug)
      || slug === PREVIEW_SLUG || slug === CITY_PREVIEW_SLUG) return null;
  const { rows: [event] } = await db.query(
    `SELECT id, slug, status, visibility, venue_name, venue_address, venue_city, venue_state,
            secret_show_enabled, hide_address_until_rsvp, timezone, start_time, end_time, event_date,
            google_place_id, venue_latitude, venue_longitude, archived_at,
            ${eventEndAtSql('e')} AS ends_at
       FROM events e WHERE e.slug=$1 AND e.status='published' AND e.visibility='public'`, [slug]);
  return event?.status === 'published' && event.visibility === 'public' && event.archived_at == null &&
    (gettingHomeEligible(event, env, now()) || (allowSf && sfGettingHomeEligible(event, env, now()))) ? event : null;
}

async function confirmedEmailRsvp(db, eventId, rsvpId) {
  const { rows: [rsvp] } = await db.query(
    `SELECT id, user_id FROM rsvps WHERE event_id=$1 AND id=$2 AND status='confirmed' AND wants_reminders=TRUE`,
    [eventId, rsvpId]);
  return rsvp ?? null;
}

async function accessForGettingHome(db, req, { env, now, rideEntry = createRideEntry({ secret: env.SESSION_SECRET, now }),
  sfCoverage = createSfCoverageStore({ db, now }), rolloutEnabled = isSfRolloutEnabled }) {
  const event = await loadEligibleGettingHomeEvent(db, req.params.slug, { env, now, allowSf: true });
  if (!event) return null;
  const city = !gettingHomeEligible(event, env, now());
  const grant = env.TRANSIT_DISTRIBUTION_ENABLED === 'true' &&
    rideEntry.verifyCookie(readCookie(req, rideEntryCookieName(event.id)), { eventId: event.id });
  const accountId = positiveId(req.sessionAccount?.id);
  const userId = positiveId(req.sessionAccount?.user_id);
  // A stale attendee cookie must not switch a signed-in browser to another
  // guest's verified identity. Signed-out guests can still use their RSVP.
  const token = accountId || userId ? '' : readCookie(req, attendeeCookieName(event.id));
  let rsvp;
  if (accountId || userId || token) {
    const { rows } = await db.query(
    `SELECT id, user_id FROM rsvps
      WHERE event_id=$1 AND status='confirmed' AND (
        ($2::int IS NOT NULL AND user_id=$2) OR
        ($3::int IS NOT NULL AND user_id IS NULL AND account_id=$3) OR
        ($4::text <> '' AND manage_token=$4))
      ORDER BY id DESC LIMIT 1`, [event.id, userId, accountId, token]);
    [rsvp] = rows;
  }
  const emailRsvp = grant && (!rsvp || rsvp.id === grant.rsvpId)
    ? await confirmedEmailRsvp(db, event.id, grant.rsvpId) : null;
  if (!rsvp && !emailRsvp) return null;
  if (city && !await rolloutEnabled({ db, env })) return null;
  const sfWalks = city ? await sfCoverage.getReadyWalks(event) : null;
  if (city && !sfWalks?.length) return null;
  return { event: city ? { ...event, sfWalks } : event, rsvp: rsvp || emailRsvp,
    readOnlyGrant: !rsvp, signedInUserId: rsvp ? userId : null, emailEntry: Boolean(emailRsvp), city };
}

async function verifiedRideUser(db, req, { accountWide = false } = {}) {
  const { event, rsvp, signedInUserId, readOnlyGrant } = req.gettingHome;
  if (readOnlyGrant) return null;
  const rsvpUserId = positiveId(rsvp.user_id);
  if (!rsvpUserId) return null;
  if (signedInUserId) return signedInUserId === rsvpUserId ? rsvpUserId : null;
  const guest = await readGuestSession(db, req);
  return guestVerifiedFor(guest, event.id) && positiveId(guest.user_id) === rsvpUserId &&
    (!accountWide || guest.verified_event_id == null) ? rsvpUserId : null;
}

function createGettingHomeRouter({ db = pool, env = process.env, now = Date.now,
  home = createGettingHome({ env, now }), reminders = rideReminders,
  saved = createSavedRouteService({ db, transit: home, now }),
  rideEntry = createRideEntry({ secret: env.SESSION_SECRET, now }),
  ridePreview = createRidePreview({ env, now }),
  cityRidePreview = createCityRidePreview({ env, now }),
  metrics = createRideMetrics({ db, secret: env.SESSION_SECRET, now }), sfCoverage = createSfCoverageStore({ db, now }),
  rolloutEnabled = isSfRolloutEnabled } = {}) {
  const router = express.Router();
  const metricsEnabled = () => env.TRANSIT_DISTRIBUTION_ENABLED === 'true';
  async function record(kind, { event, rsvp, signedInUserId, city, preview }) {
    const plannerMetric = kind === 'page_open' || kind === 'route_selected' || TRANSPORTATION_INTERACTION_KINDS.includes(kind);
    if (!rsvp || preview || (!plannerMetric && (!metricsEnabled() || (city && kind !== 'email_planner_open')))) return;
    try {
      await metrics.record({ kind, eventId: event.id, rsvpId: rsvp.id, userId: signedInUserId || undefined });
    } catch { /* Measurement never gates trip access. */ }
  }
  const limiter = createRateLimiter({ windowMs: 60_000, rules: [
    { name: 'network', max: 80, key: ctx => ctx.network },
    { name: 'guest', max: 24, key: ctx => ctx.rsvp ? String(ctx.rsvp.id) : '' }
  ] });
  setInterval(() => limiter.prune(), 60_000).unref();
  const gate = api => async (req, res, next) => {
    protectResponse(res);
    try {
      // Never treat the synthetic preview slug as a real event, even if
      // someone creates an event with that slug in the future.
      const pilotTest = req.params.slug === PREVIEW_SLUG;
      const cityTest = req.params.slug === CITY_PREVIEW_SLUG;
      const previewEvent = pilotTest ? ridePreview.verifyCookie(readCookie(req, PREVIEW_COOKIE))
        : cityTest ? cityRidePreview.verifyCookie(readCookie(req, CITY_PREVIEW_COOKIE)) : null;
      const ctx = pilotTest || cityTest
        ? (previewEvent && { event: previewEvent, preview: true, readOnlyGrant: true, city: cityTest })
        : await accessForGettingHome(db, req, { env, now, rideEntry, sfCoverage, rolloutEnabled });
      if (!ctx) return api ? res.status(404).json({ status: 'unavailable' }) : res.status(404).send(render404());
      if (api) {
        const network = crypto.createHmac('sha256', networkKey).update(clientIp(req)).digest('hex');
        const limit = limiter.consume({ network, rsvp: ctx.rsvp });
        if (!limit.allowed) return res.set('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000))).status(429).json({ status: 'unavailable' });
      }
      req.gettingHome = ctx;
      next();
    } catch (error) { next(error); }
  };
  const jsonMutation = (req, res, next) => {
    protectResponse(res);
    if (!sameOriginMutation(req)) return res.status(403).json({ status: 'unavailable' });
    if (!req.is('application/json')) return res.status(415).json({ status: 'unsupported-selection' });
    next();
  };

  for (const [preview, previewPath, name] of [
    [ridePreview, PREVIEW_PATH, PREVIEW_COOKIE], [cityRidePreview, CITY_PREVIEW_PATH, CITY_PREVIEW_COOKIE]
  ]) {
    router.get(`${previewPath}/from-test`, (req, res) => {
      protectResponse(res);
      if (req.method !== 'GET') return res.sendStatus(204);
      const event = preview.verifyLink(req.query.t);
      const token = event && preview.issueCookie(event.event_date, event.sfWalks);
      if (!token) return unavailableEmailPlan(res);
      res.cookie(name, token, {
        path: '/', httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', maxAge: event.ends_at - now()
      });
      res.redirect(303, previewPath);
    });
  }
  router.get(`${PAGE}/from-email`, async (req, res) => {
    protectResponse(res);
    if (req.method !== 'GET') return res.sendStatus(204);
    const grant = metricsEnabled() && gettingHomeEnabled(env) && rideEntry.verify(req.query.t);
    if (!grant) return unavailableEmailPlan(res);
    const event = await loadEligibleGettingHomeEvent(db, req.params.slug, { env, now, allowSf: true });
    if (!event || event.id !== grant.eventId) return unavailableEmailPlan(res);
    const rsvp = await confirmedEmailRsvp(db, event.id, grant.rsvpId);
    if (!rsvp) return unavailableEmailPlan(res);
    const city = !gettingHomeEligible(event, env, now());
    if (city && (!await rolloutEnabled({ db, env }) || !(await sfCoverage.getReadyWalks(event))?.length)) {
      return unavailableEmailPlan(res);
    }
    const expiresAt = Math.min(grant.expiresAt, planningWindowEnd(event));
    const token = rideEntry.issueCookie({ ...grant, expiresAt });
    if (!token) return unavailableEmailPlan(res);
    res.cookie(rideEntryCookieName(event.id), token, {
      path: '/', httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production',
      maxAge: expiresAt - now()
    });
    res.redirect(303, `/e/${encodeURIComponent(event.slug)}/getting-home`);
  });
  router.get(PAGE, gate(false), async (req, res) => {
    const ctx = req.gettingHome;
    if (req.method === 'GET' && !ctx.emailEntry) await record('page_open', ctx);
    if (req.method === 'GET' && metricsEnabled() && req.query.from === 'text' && !ctx.readOnlyGrant && !ctx.city) {
      try {
        const { rowCount } = await db.query(`SELECT 1 FROM transit_ride_reminders
          WHERE event_id=$1 AND rsvp_id=$2 AND status='sent' AND sent_at IS NOT NULL`, [ctx.event.id, ctx.rsvp.id]);
        if (rowCount) await record('text_link_open', ctx);
      } catch { /* Measurement never gates trip access. */ }
    }
    return sendHtmlFile(res, VIEW);
  });
  router.get(`${API}/options`, gate(true), async (req, res) => {
    const { event, preview, emailEntry } = req.gettingHome;
    const options = await home.getOptions(event);
    res.json(preview ? { ...options, previewDate: event.event_date }
      : emailEntry && options.status === 'available' ? { ...options, emailEntry: true } : options);
  });
  router.post(`${API}/departure`, jsonMutation, gate(true), async (req, res) => {
    if (!readTransitSelection(req.body)) return res.status(400).json({ status: 'unsupported-selection' });
    const ctx = req.gettingHome;
    const plan = await home.getDeparture(ctx.event, req.body, { includeUpcoming: true });
    if (['scheduled', 'overnight'].includes(plan.status)) await record('route_selected', ctx);
    const { proposedReminderAt, ...ride } = plan;
    res.json(!ctx.preview && !ctx.city && !ctx.readOnlyGrant && env.TRANSIT_RIDE_REMINDERS_ENABLED === 'true'
      && proposedReminderAt != null ? plan : ride);
  });
  router.post(`${API}/interaction`, jsonMutation, gate(true), async (req, res) => {
    const kind = req.body?.kind;
    if (kind === 'email_link_open') {
      if (!req.gettingHome.emailEntry) return res.status(403).end();
      await record('page_open', req.gettingHome);
      await record('email_planner_open', req.gettingHome);
      return res.status(204).end();
    }
    if (!TRANSPORTATION_INTERACTION_KINDS.includes(kind)) return res.status(400).end();
    await record(kind, req.gettingHome);
    return res.status(204).end();
  });

  const reminderAction = action => async (req, res) => {
    if (req.gettingHome.preview || req.gettingHome.city || env.TRANSIT_RIDE_REMINDERS_ENABLED !== 'true') return res.json({ status: 'unavailable' });
    try {
      const userId = await verifiedRideUser(db, req);
      if (!userId) return res.json({ status: 'identity-required' });
      const ids = { eventId: req.gettingHome.event.id, userId };
      if (action === 'getStatus') return res.json({ ...await reminders.getStatus(ids), consentLabel: RIDE_SMS_CONSENT });
      if (action === 'cancel') return res.json(await reminders.cancel(ids));
      const selection = readTransitSelection(req.body?.selection);
      const expectedReminderAt = req.body?.expectedReminderAt;
      if (!selection || !Number.isSafeInteger(expectedReminderAt)) return res.status(400).json({ status: 'unsupported-selection' });
      const result = await reminders.schedule({ ...ids, selection, expectedReminderAt, consent: req.body?.consent === true });
      if (result.status === 'pending') await record('reminder_requested', req.gettingHome);
      return res.json(result);
    } catch (error) {
      if (error instanceof RideReminderError) return res.status(error.status).json({ status: error.code });
      throw error;
    }
  };
  router.get(`${API}/reminder`, gate(true), reminderAction('getStatus'));
  router.post(`${API}/reminder`, jsonMutation, gate(true), reminderAction('schedule'));
  router.delete(`${API}/reminder`, jsonMutation, gate(true), reminderAction('cancel'));

  const preferenceAction = action => async (req, res) => {
    if (req.gettingHome.city) return res.json({ status: 'not-eligible' });
    const userId = await verifiedRideUser(db, req, { accountWide: true });
    if (!userId) return res.json({ status: 'not-eligible' });
    const event = req.gettingHome.event;
    if (action === 'get') return res.json(await saved.get({ userId, event }));
    if (action === 'remove') return res.json(await saved.remove({ userId }));
    const selection = readTransitSelection(req.body?.selection);
    if (!selection || req.body?.remember !== true) return res.status(400).json({ status: 'not-requested' });
    res.json(await saved.save({ userId, event, selection, remember: true }));
  };
  router.get(`${API}/saved-route`, gate(true), preferenceAction('get'));
  router.post(`${API}/saved-route`, jsonMutation, gate(true), preferenceAction('save'));
  router.delete(`${API}/saved-route`, jsonMutation, gate(true), preferenceAction('remove'));
  router.get('/api/account/saved-transit-route', async (req, res) => {
    protectResponse(res);
    const userId = positiveId(req.sessionAccount?.user_id);
    if (!userId) return res.status(401).json({ status: 'unavailable' });
    res.json(await saved.status({ userId }));
  });
  router.delete('/api/account/saved-transit-route', jsonMutation, async (req, res) => {
    const userId = positiveId(req.sessionAccount?.user_id);
    if (!userId) return res.status(401).json({ status: 'unavailable' });
    res.json(await saved.remove({ userId }));
  });
  return router;
}

module.exports = { createGettingHomeRouter, accessForGettingHome, verifiedRideUser };
