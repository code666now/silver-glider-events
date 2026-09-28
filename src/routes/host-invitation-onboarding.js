const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const requireOrganizer = require('../middleware/requireOrganizer');

const router = express.Router();
const onboardingView = fs.readFileSync(
  path.join(__dirname, '..', 'views', 'host-invitation.html'),
  'utf8'
);

const TOKEN_RE = /^[a-z0-9-]{12,220}$/;

function invitationHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
}

function cleanToken(value) {
  const token = String(value || '').trim();
  return TOKEN_RE.test(token) ? token : '';
}

function sameOriginMutation(req) {
  const site = req.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.get('origin');
  if (!origin || origin === 'null') return true;
  let originHost;
  try { originHost = new URL(origin).host; } catch (_) { return false; }
  const allowed = [req.get('host'), req.get('x-forwarded-host')];
  try { allowed.push(new URL(process.env.APP_URL).host); } catch (_) {}
  return allowed.filter(Boolean).includes(originHost);
}

async function invitationByToken(db, token, { lock = false } = {}) {
  const { rows } = await db.query(
    `SELECT id,host_name,joined_organizer_id,joined_at,revoked_at
       FROM host_invitations
      WHERE token=$1
      ${lock ? 'FOR UPDATE' : ''}`,
    [token]
  );
  return rows[0] || null;
}

function invitationUnavailable(res, invitation) {
  invitationHeaders(res);
  if (!invitation) {
    res.status(404).json({
      error: 'invitation_not_found',
      message: 'This invitation could not be found.'
    });
    return true;
  }
  if (invitation.revoked_at) {
    res.status(410).json({
      error: 'invitation_unavailable',
      message: 'This invitation is no longer available.'
    });
    return true;
  }
  return false;
}

function organizerState(organizer) {
  return {
    name: organizer.name || '',
    orgName: organizer.org_name || '',
    publicSlug: organizer.public_slug || null,
    logoUrl: organizer.logo_url || null,
    bio: organizer.bio || '',
    instagramHandle: organizer.instagram_handle || '',
    websiteUrl: organizer.website_url || ''
  };
}

function hasResolvableHostPage(host) {
  return Boolean(
    String(host.publicSlug || '').trim() &&
    String(host.orgName || '').trim()
  );
}

function onboardingState(invitation, organizer) {
  const organizerId = Number(organizer.id);
  const joinedOrganizerId = invitation.joined_organizer_id == null
    ? null
    : Number(invitation.joined_organizer_id);
  const joinedByCurrent = joinedOrganizerId === organizerId;
  const host = organizerState(organizer);
  const existingHostPage = hasResolvableHostPage(host);
  const screen = joinedByCurrent
    ? (existingHostPage ? 'ready' : 'setup')
    : 'welcome';
  return {
    invitation: {
      hostName: invitation.host_name,
      accepted: joinedByCurrent,
      acceptedAt: joinedByCurrent ? invitation.joined_at : null
    },
    organizer: host,
    suggestedHostName: (
      String(host.orgName || '').trim() ||
      String(invitation.host_name || '').trim()
    ).slice(0, 100),
    existingHostPage,
    screen
  };
}

function invitationConflict(res) {
  invitationHeaders(res);
  return res.status(409).json({
    error: 'invitation_already_accepted',
    message: 'This invitation has already been accepted by another account.'
  });
}

// The login screen can use this read-only endpoint to keep the invitation
// contextual without exposing its private note, recipient state, or owner.
router.get('/api/public/host-invitations/:token', async (req, res, next) => {
  try {
    const token = cleanToken(req.params.token);
    const invitation = token ? await invitationByToken(pool, token) : null;
    if (invitationUnavailable(res, invitation)) return;
    invitationHeaders(res);
    res.json({ invitation: { hostName: invitation.host_name } });
  } catch (error) { next(error); }
});

// The page is protected, but preserves its full path through the existing
// authentication flow. Loading it never accepts or changes the invitation.
router.get('/host-invitation/:token', async (req, res, next) => {
  try {
    const token = cleanToken(req.params.token);
    const invitation = token ? await invitationByToken(pool, token) : null;
    invitationHeaders(res);
    if (!invitation) {
      return res.status(404).type('text').send('Invitation not found');
    }
    if (invitation.revoked_at) {
      return res.status(410).type('text').send('This invitation is no longer available');
    }
    if (!req.sessionAccount) {
      const nextPath = `/host-invitation/${encodeURIComponent(token)}`;
      return res.redirect(302, `/login?next=${encodeURIComponent(nextPath)}`);
    }
    res.type('html').send(onboardingView);
  } catch (error) { next(error); }
});

router.get('/api/host-invitations/:token', requireOrganizer, async (req, res, next) => {
  try {
    const token = cleanToken(req.params.token);
    const invitation = token ? await invitationByToken(pool, token) : null;
    if (invitationUnavailable(res, invitation)) return;
    if (invitation.joined_organizer_id != null &&
        Number(invitation.joined_organizer_id) !== Number(req.organizer.id)) {
      return invitationConflict(res);
    }
    invitationHeaders(res);
    res.json(onboardingState(invitation, req.organizer));
  } catch (error) { next(error); }
});

// Acceptance is the only invitation mutation. The row lock makes two accounts
// racing the same bearer link deterministic; a returning owner is idempotent.
router.post('/api/host-invitations/:token/accept', requireOrganizer, async (req, res, next) => {
  if (!sameOriginMutation(req)) {
    invitationHeaders(res);
    return res.status(403).json({ error: 'forbidden', message: 'Refresh this page and try again.' });
  }

  const token = cleanToken(req.params.token);
  if (!token) {
    invitationHeaders(res);
    return res.status(404).json({
      error: 'invitation_not_found',
      message: 'This invitation could not be found.'
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let invitation = await invitationByToken(client, token, { lock: true });
    if (!invitation) {
      await client.query('ROLLBACK');
      return invitationUnavailable(res, null);
    }
    if (invitation.revoked_at) {
      await client.query('ROLLBACK');
      return invitationUnavailable(res, invitation);
    }

    const organizerId = Number(req.organizer.id);
    if (invitation.joined_organizer_id != null &&
        Number(invitation.joined_organizer_id) !== organizerId) {
      await client.query('ROLLBACK');
      return invitationConflict(res);
    }

    if (invitation.joined_organizer_id == null) {
      const { rows } = await client.query(
        `UPDATE host_invitations
            SET joined_organizer_id=$2,joined_at=NOW(),updated_at=NOW()
          WHERE id=$1
          RETURNING id,host_name,joined_organizer_id,joined_at,revoked_at`,
        [invitation.id, organizerId]
      );
      invitation = rows[0];
    }

    await client.query('COMMIT');
    invitationHeaders(res);
    res.json(onboardingState(invitation, req.organizer));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
