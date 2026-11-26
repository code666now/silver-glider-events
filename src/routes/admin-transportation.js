'use strict';

const express = require('express');
const nodePath = require('node:path');
const pool = require('../config/db');
const requireAdmin = require('../middleware/requireAdmin');
const { requireDedicatedAdmin, requireSuperAdmin, isDedicatedSuperAdmin, actorIds } = require('../middleware/requireAdmin');
const { readSfRollout, writeSfRollout } = require('../lib/transit/sf-rollout');
const { getTransportationAnalytics } = require('../lib/transit/ride-metrics');
const { createVenueTester, TESTER_PAGE, TESTER_PLAN, TESTER_API, TESTER_COOKIE, TESTER_MAX_AGE } = require('../lib/transit/venue-tester');
const { createGettingHome, readTransitSelection } = require('../lib/transit/getting-home');
const { createRateLimiter } = require('../lib/rate-limit');
const { readCookie } = require('../lib/private-events');
const { sendHtmlFile } = require('../lib/static-assets');

const router = express.Router();
const path = '/api/admin/transportation';
const tester = createVenueTester();
const home = createGettingHome();
const scope = req => ({ operatorId: actorIds(req).actorAdminOperatorId, sessionIssuedAt: req.adminSession?.issuedAt });
const testerLimiter = createRateLimiter({ windowMs: 5 * 60_000,
  rules: [{ name: 'venue-tester-operator', max: 8, key: req => scope(req).operatorId }] });
const planLimiter = createRateLimiter({ windowMs: 60_000,
  rules: [{ name: 'venue-tester-plan', max: 45, key: req => scope(req).operatorId }] });
for (const limiter of [testerLimiter, planLimiter]) setInterval(() => limiter.prune(), 60_000).unref();

router.use(path, (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
}, requireAdmin, requireDedicatedAdmin);

const testerPage = file => (req, res) => {
  res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' });
  return sendHtmlFile(res, nodePath.join(__dirname, '..', 'views', file));
};
router.get(TESTER_PAGE, requireAdmin, requireDedicatedAdmin, requireSuperAdmin, testerPage('admin-transportation-venue-test.html'));
router.get(TESTER_PLAN, requireAdmin, requireDedicatedAdmin, requireSuperAdmin, testerPage('getting-home.html'));
router.use(TESTER_API, requireSuperAdmin);

router.get(`${TESTER_API}/places/config`, (_req, res) => {
  // Uses the same referrer-restricted browser key as the event venue picker.
  const apiKey = String(process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_BROWSER_KEY || '').trim();
  return res.json(apiKey ? { enabled: true, apiKey } : { enabled: false });
});

function rateAllowed(limiter, req, res) {
  const limit = limiter.consume(req);
  if (limit.allowed) return true;
  res.set('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000))).status(429)
    .json({ status: 'unavailable', message: 'Too many checks. Wait a moment and try again.' });
  return false;
}

router.post(`${TESTER_API}/prepare`, async (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ status: 'unsupported-selection' });
  if (!rateAllowed(testerLimiter, req, res)) return;
  try {
    const token = await tester.prepare(req.body, scope(req));
    res.cookie(TESTER_COOKIE, token, { path: TESTER_API, httpOnly: true, sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production', maxAge: TESTER_MAX_AGE });
    return res.json({ status: 'ready' });
  } catch (error) {
    const messages = {
      sf_venue_required: [400, 'Choose a public San Francisco venue from the Google Places suggestions.'],
      coverage_busy: [503, 'Another venue is being checked. Wait a moment and try again.'],
      walk_budget: [429, 'The walking lookup limit has been reached. Try again later.']
    };
    const [status, message] = messages[error?.code] || [503, 'Couldn’t check transit for this venue right now. Try again.'];
    return res.status(status).json({ status: 'unavailable', message });
  }
});

async function testerPlan(req, res, next) {
  if (!rateAllowed(planLimiter, req, res)) return;
  try {
    const event = await tester.read(readCookie(req, TESTER_COOKIE), scope(req));
    if (!event) return res.status(404).json({ status: 'test-expired' });
    req.testVenue = event;
    next();
  } catch { return res.status(503).json({ status: 'schedule-unavailable' }); }
}

router.get(`${TESTER_API}/options`, testerPlan, async (req, res) => {
  const event = req.testVenue;
  const directions = new URL('https://www.google.com/maps/search/');
  directions.searchParams.set('api', '1');
  directions.searchParams.set('query', event.venue_address);
  const options = event.sfWalks?.length === 0 ? { status: 'empty' } : await home.getOptions(event);
  return res.json({ ...options, tester: true, venue: event.venue_name, directionsUrl: directions.href });
});

router.post(`${TESTER_API}/departure`, testerPlan, async (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ status: 'unsupported-selection' });
  if (!readTransitSelection(req.body)) return res.status(400).json({ status: 'unsupported-selection' });
  const { proposedReminderAt, ...response } = await home.getDeparture(req.testVenue, req.body, { includeUpcoming: true, leaveNow: true });
  return res.json(response);
});

// The shared planner checks these states when it loads. Test sessions never
// expose reminder, saved-route, RSVP, or measurement mutations.
router.get(`${TESTER_API}/reminder`, (_req, res) => res.json({ status: 'unavailable' }));
router.get(`${TESTER_API}/saved-route`, (_req, res) => res.json({ status: 'not-eligible' }));

function viewRollout(result) {
  return {
    enabled: result?.enabled === true,
    allowed: result?.allowed === true,
    requested: result?.requested === true,
    reason: typeof result?.reason === 'string' ? result.reason : null,
    updatedAt: result?.updatedAt || null
  };
}

router.get(`${path}/rollout`, async (req, res) => {
  try {
    const rollout = await readSfRollout({ db: pool });
    return res.json({ rollout: viewRollout(rollout), canManage: isDedicatedSuperAdmin(req) });
  } catch {
    return res.status(503).json({ error: 'transportation_rollout_unavailable', message: 'Citywide rollout status is unavailable.' });
  }
});

router.get(`${path}/analytics`, async (req, res) => {
  try {
    return res.json(await getTransportationAnalytics({ db: pool }));
  } catch {
    return res.status(503).json({ error: 'transportation_analytics_unavailable', message: 'Transportation analytics are unavailable.' });
  }
});

// requireAdmin already enforces same-origin for mutations. Only dedicated
// Super Admin actors may apply the setting; the rollout service enforces its
// safety gate and records the actor. This route can't change reminder flags.
router.patch(`${path}/rollout`, requireSuperAdmin, async (req, res) => {
  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'json_required', message: 'Use a JSON request.' });
  }
  if (!req.body || Object.keys(req.body).length !== 1 || typeof req.body.enabled !== 'boolean') {
    return res.status(400).json({ error: 'invalid_rollout_setting', message: 'Choose whether the citywide rollout should be on or off.' });
  }
  try {
    const rollout = await writeSfRollout({ db: pool, enabled: req.body.enabled, operatorId: actorIds(req).actorAdminOperatorId });
    return res.json({ rollout: viewRollout(rollout), canManage: true });
  } catch (error) {
    const status = error?.statusCode;
    if (status === 409 || status === 423) {
      return res.status(status).json({ error: 'transportation_rollout_blocked', message: 'Citywide rollout cannot be enabled right now. Refresh its status for details.' });
    }
    if (status === 401 || status === 403) {
      return res.status(status).json({ error: 'super_admin_required', message: 'Super Admin access is required.' });
    }
    return res.status(503).json({ error: 'transportation_rollout_unavailable', message: 'The rollout change could not be confirmed.' });
  }
});

module.exports = router;
