const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const { readSessionCookie } = require('./session');

// A document edit/release alone must not prompt existing accounts again.
// Bump REQUIRED_LEGAL_REVIEW_VERSION only after an explicit reacceptance decision.
const REQUIRED_LEGAL_REVIEW_VERSION = 'account-review-v1';
const CURRENT_LEGAL_VERSIONS = Object.freeze({
  terms: '2026-11-11', privacy: '2026-11-10', wording: '2026-11-10'
});
const REVIEW_INTRO = 'Please review our Terms of Service and Privacy Policy to continue.';
const REVIEW_WORDING = 'I agree to the Terms of Service and acknowledge the Privacy Policy.';
const REVIEW_BUTTON = 'Agree and continue';
const EXPECTED_DOCUMENT_HASHES = Object.freeze({
  terms: 'ee858d05eaee1bb3fcee272f433a43c06e75d2590d75beed494fc089d711171b',
  privacy: 'bb1155ad1cb8120a26372b09f8f2b384a2b66d952853b15e2f257f708e5430ea'
});
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function legalDocumentSnapshots() {
  return Object.entries(CURRENT_LEGAL_VERSIONS).map(([kind, version]) => {
    const content = kind === 'wording'
      ? `${REVIEW_INTRO}\n\n${REVIEW_WORDING}\n\n${REVIEW_BUTTON}\n\nSign out\n`
      : fs.readFileSync(path.join(__dirname, '..', 'legal', `${kind}.txt`), 'utf8');
    const contentHash = sha256(content);
    if (EXPECTED_DOCUMENT_HASHES[kind] && contentHash !== EXPECTED_DOCUMENT_HASHES[kind]) {
      throw new Error('Legal document content changed without a reviewed version update');
    }
    return { kind, version, content, contentHash };
  });
}

async function registerLegalPolicyVersions(db) {
  for (const document of legalDocumentSnapshots()) {
    await db.query(
      `INSERT INTO legal_policy_versions (kind,version,content,content_sha256)
       VALUES ($1,$2,$3,$4) ON CONFLICT (kind,version) DO NOTHING`,
      [document.kind, document.version, document.content, document.contentHash]
    );
    const { rows } = await db.query(
      'SELECT content,content_sha256 FROM legal_policy_versions WHERE kind=$1 AND version=$2',
      [document.kind, document.version]
    );
    if (rows[0]?.content !== document.content || rows[0]?.content_sha256 !== document.contentHash) {
      throw new Error('Registered legal document does not match this release');
    }
  }
}

function canonicalUserId(account) {
  const value = Number(account?.user_id || account?.id);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('A canonical account is required');
  return value;
}

function safeLegalNext(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input || input.length > 1500 || !input.startsWith('/') || input.startsWith('//') ||
      /[\\\x00-\x20\x7f]/.test(input) || /%5c|%0[0-9a-f]|%1[0-9a-f]|%7f/i.test(input)) return '/dashboard';
  try {
    const parsed = new URL(input, 'https://silver-glider.invalid');
    const pathname = decodeURIComponent(parsed.pathname);
    if (parsed.origin !== 'https://silver-glider.invalid' || pathname.startsWith('//') ||
        pathname.includes('\\') || /[\x00-\x1f\x7f]/.test(pathname) ||
        /^\/(?:account\/review|legal(?:\/|$)|api(?:\/|$)|auth(?:\/|$)|login(?:\/|$)|admin(?:[-/]|$))/.test(pathname)) {
      return '/dashboard';
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch (_) { return '/dashboard'; }
}

function acceptanceRedirect(destination) {
  return `/account/review?next=${encodeURIComponent(safeLegalNext(destination))}`;
}

async function legalAcceptanceState(db, account) {
  const { rows } = await db.query(
    `SELECT accepted_at,terms_version,privacy_version,wording_version
       FROM user_legal_acceptances WHERE user_id=$1 AND review_version=$2`,
    [canonicalUserId(account), REQUIRED_LEGAL_REVIEW_VERSION]
  );
  return {
    required: !rows.length,
    acceptedAt: rows[0]?.accepted_at || null,
    acceptedVersions: rows[0] ? {
      terms: rows[0].terms_version, privacy: rows[0].privacy_version, wording: rows[0].wording_version
    } : null,
    reviewVersion: REQUIRED_LEGAL_REVIEW_VERSION,
    versions: CURRENT_LEGAL_VERSIONS,
    redirect: rows.length ? null : acceptanceRedirect('/dashboard')
  };
}

async function requestLegalAcceptanceState(req, account = req.sessionAccount || req.organizer) {
  const userId = canonicalUserId(account);
  if (req.legalAcceptanceUserId !== userId || !req.legalAcceptanceStatePromise) {
    req.legalAcceptanceUserId = userId;
    req.legalAcceptanceStatePromise = legalAcceptanceState(pool, account);
  }
  return req.legalAcceptanceStatePromise;
}

// True means the response was handled and the private operation must stop.
async function requireLegalAcceptance(req, res, account = req.sessionAccount || req.organizer) {
  const state = await requestLegalAcceptanceState(req, account);
  if (!state.required) return false;
  res.setHeader('Cache-Control', 'private, no-store');
  const api = req.path.startsWith('/api/') || (req.baseUrl || '').startsWith('/api/');
  const redirect = acceptanceRedirect(api ? '/dashboard' : req.originalUrl);
  if (api) {
    res.status(403).json({
      error: 'legal_acceptance_required',
      message: 'Please review our Terms of Service and Privacy Policy to continue.',
      redirect
    });
  } else {
    res.redirect(303, redirect);
  }
  return true;
}

// Access to sign-out, privacy choices, support and credential recovery cannot
// depend on first agreeing to a contract. Exempt only the exact required paths.
function legalGateExempt(req) {
  const pathname = String(req.originalUrl || req.path || '').split('?')[0].replace(/\/$/, '');
  const method = req.method.toUpperCase();
  if (method === 'GET' && ['/api/auth/me', '/api/me', '/settings/account', '/add-photo'].includes(pathname)) return true;
  if (method === 'POST' && ['/api/auth/logout-all', '/api/feedback', '/api/uploads/avatar'].includes(pathname)) return true;
  if (method === 'PATCH' && pathname === '/api/me/profile' && req.body?.avatarUrl === null &&
      Object.keys(req.body).every(key => key === 'avatarUrl')) return true;
  if (/^\/api\/me\/identities(?:\/|$)/.test(pathname)) return true;
  if (/^\/api\/hosts\/[^/]+\/follow$/.test(pathname)) {
    return method === 'GET' || method === 'DELETE' ||
      (method === 'PATCH' && req.body?.email !== true && req.body?.text !== true);
  }
  return method === 'DELETE' && /^\/api\/people\/[^/]+\/follow$/.test(pathname);
}

function sessionBinding(req) {
  return sha256(readSessionCookie(req) || '');
}

function tokenSignature(payload) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET)
    .update(`legal-review-v1:${payload}`).digest('base64url');
}

function issueReviewToken(req, account, next) {
  const payload = Buffer.from(JSON.stringify({
    userId: canonicalUserId(account), session: sessionBinding(req),
    review: REQUIRED_LEGAL_REVIEW_VERSION, versions: CURRENT_LEGAL_VERSIONS,
    next: safeLegalNext(next), expires: Date.now() + 2 * 60 * 60 * 1000
  })).toString('base64url');
  return `${payload}.${tokenSignature(payload)}`;
}

function verifyReviewToken(req, account, body) {
  const raw = typeof body?.csrfToken === 'string' ? body.csrfToken : '';
  if (raw.length > 6000) return false;
  const parts = raw.split('.');
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;
  if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload) ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature || '')) return false;
  const expected = tokenSignature(payload);
  if (signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return parsed.userId === canonicalUserId(account) && parsed.session === sessionBinding(req) &&
      parsed.review === REQUIRED_LEGAL_REVIEW_VERSION &&
      Object.entries(CURRENT_LEGAL_VERSIONS).every(([kind, version]) => parsed.versions?.[kind] === version) &&
      parsed.next === safeLegalNext(body.next) &&
      Number.isSafeInteger(parsed.expires) && parsed.expires > Date.now() &&
      parsed.expires <= Date.now() + 2 * 60 * 60 * 1000;
  } catch (_) { return false; }
}

async function recordLegalAcceptance(db, account) {
  const userId = canonicalUserId(account);
  const { rows } = await db.query(
    `INSERT INTO user_legal_acceptances
       (user_id,review_version,terms_version,privacy_version,wording_version)
     SELECT id,$2,$3,$4,$5 FROM users WHERE id=$1 AND account_status='active'
     ON CONFLICT (user_id,review_version) DO NOTHING RETURNING accepted_at`,
    [userId, REQUIRED_LEGAL_REVIEW_VERSION, CURRENT_LEGAL_VERSIONS.terms,
      CURRENT_LEGAL_VERSIONS.privacy, CURRENT_LEGAL_VERSIONS.wording]
  );
  if (rows.length) return { acceptedAt: rows[0].accepted_at, created: true };
  const state = await legalAcceptanceState(db, account);
  if (state.required) throw new Error('Account is no longer available for legal acceptance');
  return { acceptedAt: state.acceptedAt, created: false };
}

module.exports = {
  CURRENT_LEGAL_VERSIONS, REQUIRED_LEGAL_REVIEW_VERSION,
  REVIEW_INTRO, REVIEW_WORDING, REVIEW_BUTTON,
  legalDocumentSnapshots, registerLegalPolicyVersions, legalAcceptanceState,
  requestLegalAcceptanceState, requireLegalAcceptance, legalGateExempt,
  safeLegalNext, acceptanceRedirect, issueReviewToken, verifyReviewToken, recordLegalAcceptance
};
