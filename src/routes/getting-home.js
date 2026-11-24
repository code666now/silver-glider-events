'use strict';

const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const pool = require('../config/db');
const { eventEndAtSql } = require('../lib/post-event');
const { attendeeCookieName, readCookie } = require('../lib/private-events');
const { createRateLimiter, clientIp } = require('../lib/rate-limit');
const { sendHtmlFile } = require('../lib/static-assets');
const { render404 } = require('../lib/public-html');
const { sameOriginMutation } = require('../middleware/requireOrganizer');
const { createGettingHome, gettingHomeEnabled, gettingHomeEligible, readTransitSelection } = require('../lib/transit/getting-home');

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

async function accessForGettingHome(db, req, { env, now }) {
  const slug = req.params.slug;
  if (!gettingHomeEnabled(env) || typeof slug !== 'string' || !/^[a-z0-9-]{1,120}$/i.test(slug)) return null;
  const { rows: [event] } = await db.query(
    `SELECT id, slug, status, visibility, venue_name, venue_address, venue_city, venue_state,
            secret_show_enabled, hide_address_until_rsvp, timezone, start_time, end_time, event_date,
            ${eventEndAtSql('e')} AS ends_at
       FROM events e WHERE e.slug=$1 AND e.status='published' AND e.visibility='public'`, [slug]);
  if (!gettingHomeEligible(event, env, now())) return null;
  const accountId = positiveId(req.sessionAccount?.id);
  const userId = positiveId(req.sessionAccount?.user_id);
  // A stale attendee cookie must not switch a signed-in browser to another
  // guest's verified identity. Signed-out guests can still use their RSVP.
  const token = accountId || userId ? '' : readCookie(req, attendeeCookieName(event.id));
  if (!accountId && !userId && !token) return null;
  const { rows: [rsvp] } = await db.query(
    `SELECT id, user_id FROM rsvps
      WHERE event_id=$1 AND status='confirmed' AND (
        ($2::int IS NOT NULL AND user_id=$2) OR
        ($3::int IS NOT NULL AND user_id IS NULL AND account_id=$3) OR
        ($4::text <> '' AND manage_token=$4))
      ORDER BY id DESC LIMIT 1`, [event.id, userId, accountId, token]);
  return rsvp ? { event, rsvp, signedInUserId: userId } : null;
}

function createGettingHomeRouter({ db = pool, env = process.env, now = Date.now,
  home = createGettingHome({ env, now }) } = {}) {
  const router = express.Router();
  const limiter = createRateLimiter({ windowMs: 60_000, rules: [
    { name: 'network', max: 80, key: ctx => ctx.network },
    { name: 'guest', max: 24, key: ctx => String(ctx.rsvp.id) }
  ] });
  setInterval(() => limiter.prune(), 60_000).unref();
  const gate = api => async (req, res, next) => {
    protectResponse(res);
    try {
      const ctx = await accessForGettingHome(db, req, { env, now });
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

  router.get(PAGE, gate(false), (_req, res) => sendHtmlFile(res, VIEW));
  router.get(`${API}/options`, gate(true), async (req, res) => {
    res.json(await home.getOptions(req.gettingHome.event));
  });
  router.post(`${API}/departure`, jsonMutation, gate(true), async (req, res) => {
    if (!readTransitSelection(req.body)) return res.status(400).json({ status: 'unsupported-selection' });
    res.json(await home.getDeparture(req.gettingHome.event, req.body));
  });
  return router;
}

module.exports = { createGettingHomeRouter, accessForGettingHome };
