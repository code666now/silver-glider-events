const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const requireOrganizer = require('../middleware/requireOrganizer');
const { esc } = require('../lib/public-html');
const { clearSessionCookie } = require('../lib/session');
const { clearGuestSessionCookie, revokeGuestSession } = require('../lib/guest-session');
const { clearPhotoAccessCookie } = require('../lib/photo-access');
const { clearSignInRequestCookie } = require('../lib/sign-in-challenges');
const { clearPhoneAuthCookie, cancelPhoneChallenge } = require('../lib/phone-auth');
const { clearIdentityStepUpCookie } = require('../lib/identity-step-up');
const {
  CURRENT_LEGAL_VERSIONS, requestLegalAcceptanceState, safeLegalNext,
  acceptanceRedirect, issueReviewToken, verifyReviewToken, recordLegalAcceptance
} = require('../lib/legal-acceptance');

const router = express.Router();

function privateResponse(req, res, next) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
}

function reviewSession(req, res, next) {
  if (!req.sessionAccount) {
    clearSessionCookie(res);
    const destination = safeLegalNext(req.method === 'GET' ? req.query.next : req.body?.next);
    return res.redirect(303, `/login?next=${encodeURIComponent(destination)}`);
  }
  return requireOrganizer.authenticationOnly(req, res, next);
}

function renderReview(req, res, { status = 200, next, error = '' } = {}) {
  const destination = safeLegalNext(next);
  const token = issueReviewToken(req, req.organizer, destination);
  const template = fs.readFileSync(path.join(__dirname, '..', 'views', 'legal-acceptance.html'), 'utf8');
  const values = {
    TERMS_URL: `/terms?version=${encodeURIComponent(CURRENT_LEGAL_VERSIONS.terms)}`,
    PRIVACY_URL: `/privacy?version=${encodeURIComponent(CURRENT_LEGAL_VERSIONS.privacy)}`,
    CSRF_TOKEN: token, LOGOUT_TOKEN: token,
    TERMS_VERSION: CURRENT_LEGAL_VERSIONS.terms,
    PRIVACY_VERSION: CURRENT_LEGAL_VERSIONS.privacy,
    WORDING_VERSION: CURRENT_LEGAL_VERSIONS.wording,
    NEXT_URL: destination, ERROR_MESSAGE: error, ERROR_HIDDEN: error ? '' : 'hidden'
  };
  res.status(status).type('html').send(template.replace(/{{([A-Z_]+)}}/g, (_, key) => esc(values[key] || '')));
}

router.get('/account/review', privateResponse, reviewSession, async (req, res, next) => {
  try {
    const destination = safeLegalNext(req.query.next);
    const state = await requestLegalAcceptanceState(req, req.organizer);
    if (!state.required) return res.redirect(303, destination);
    return renderReview(req, res, { next: destination });
  } catch (error) { next(error); }
});

router.get('/api/legal-acceptance', privateResponse, requireOrganizer.authenticationOnly, async (req, res, next) => {
  try {
    const state = await requestLegalAcceptanceState(req, req.organizer);
    res.json({ ...state, redirect: state.required ? acceptanceRedirect(req.query.next) : null });
  } catch (error) { next(error); }
});

function respondError(req, res, status, error, message) {
  if (req.is('application/json')) return res.status(status).json({ error, message });
  return renderReview(req, res, { status, next: req.body?.next, error: message });
}

router.post('/legal/accept', privateResponse, reviewSession, async (req, res) => {
  if (!verifyReviewToken(req, req.organizer, req.body)) {
    return respondError(req, res, 403, 'review_expired', 'This review expired. Please review and try again.');
  }
  if (req.body?.termsVersion !== CURRENT_LEGAL_VERSIONS.terms ||
      req.body?.privacyVersion !== CURRENT_LEGAL_VERSIONS.privacy ||
      req.body?.wordingVersion !== CURRENT_LEGAL_VERSIONS.wording) {
    return respondError(req, res, 409, 'legal_versions_changed', 'Our documents changed. Please review the current versions before continuing.');
  }
  if (req.body?.accepted !== 'true' && req.body?.accepted !== true) {
    return respondError(req, res, 400, 'acceptance_required', 'Select the checkbox to agree and continue.');
  }
  try {
    const receipt = await recordLegalAcceptance(pool, req.organizer);
    const destination = safeLegalNext(req.body.next);
    if (req.is('application/json')) return res.json({ ok: true, acceptedAt: receipt.acceptedAt, redirect: destination });
    return res.redirect(303, destination);
  } catch (_) {
    // Deliberately do not expose database errors or falsely advance the user.
    return respondError(req, res, 503, 'acceptance_save_failed', 'We could not save your agreement. Please try again.');
  }
});

router.post('/legal/logout', privateResponse, reviewSession, async (req, res, next) => {
  if (!verifyReviewToken(req, req.organizer, req.body)) {
    return respondError(req, res, 403, 'review_expired', 'This review expired. Please try signing out again.');
  }
  try {
    await revokeGuestSession(pool, req);
    await cancelPhoneChallenge(pool, req);
    clearSessionCookie(res);
    clearGuestSessionCookie(res);
    clearPhotoAccessCookie(res);
    clearSignInRequestCookie(res);
    clearPhoneAuthCookie(res);
    clearIdentityStepUpCookie(res);
    return res.redirect(303, '/');
  } catch (error) { next(error); }
});

module.exports = router;
