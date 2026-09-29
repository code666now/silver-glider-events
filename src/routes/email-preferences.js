const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const { esc } = require('../lib/public-html');
const { verifyOptout } = require('../lib/followers');
const {
  EMAIL_PREFERENCE_SCOPES,
  verifyEmailPreference,
  emailOptedOut,
  setEmailPreference
} = require('../lib/email-preferences');

const router = express.Router();
const settingsTemplate = fs.readFileSync(path.join(__dirname, '..', 'views', 'email-settings.html'), 'utf8');

function privateEmailResponse(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
}

function invalidLinkPage() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email settings — Silver Glider Events</title><link rel="stylesheet" href="/css/brand.css"><script src="/js/legal-footer.js" defer></script></head><body><main style="max-width:440px;margin:0 auto;padding:18vh 24px;text-align:center"><p class="sg-label" style="margin-bottom:20px">Silver Glider Events</p><h1 style="font-size:28px;margin-bottom:12px">Link problem</h1><p style="color:var(--sg-text-dim);font-size:15px;line-height:1.7">That email-settings link is invalid.</p></main></body></html>`;
}

function statusPage({ title, message, manageUrl = '' }) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Silver Glider Events</title><link rel="stylesheet" href="/css/brand.css"><script src="/js/legal-footer.js" defer></script></head><body><main style="max-width:440px;margin:0 auto;padding:18vh 24px;text-align:center"><p class="sg-label" style="margin-bottom:20px">Silver Glider Events</p><h1 style="font-size:28px;margin-bottom:12px">${esc(title)}</h1><p style="color:var(--sg-text-dim);font-size:15px;line-height:1.7">${esc(message)}</p>${manageUrl ? `<p style="margin-top:24px"><a class="sg-btn sg-btn-ghost" href="${esc(manageUrl)}">Manage email settings</a></p>` : ''}</main></body></html>`;
}

function renderSettings({ token, enabled, label, description, saveUrl }) {
  return settingsTemplate
    .replace(/{{CHECKED}}/g, enabled ? 'checked' : '')
    .replace(/{{SETTING_LABEL}}/g, esc(label))
    .replace(/{{SETTING_DESCRIPTION}}/g, esc(description))
    .replace(/{{SAVE_URL}}/g, esc(saveUrl))
    .replace(/{{TOKEN}}/g, esc(token));
}

router.get('/email-settings', async (req, res, next) => {
  try {
    privateEmailResponse(res);
    const data = verifyEmailPreference(req.query.token);
    if (!data) return res.status(400).send(invalidLinkPage());
    const preference = EMAIL_PREFERENCE_SCOPES[data.scope];
    const enabled = !await emailOptedOut(pool, data.email, data.scope);
    res.send(renderSettings({
      token: req.query.token,
      enabled,
      label: preference.label,
      description: preference.description,
      saveUrl: '/api/email-settings'
    }));
  } catch (error) { next(error); }
});

router.post('/api/email-settings', async (req, res, next) => {
  try {
    const data = verifyEmailPreference(req.body?.token);
    if (!data || typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: 'That email-settings link is invalid.' });
    }
    await setEmailPreference(pool, data.email, data.scope, req.body.enabled);
    res.json({ ok: true, enabled: req.body.enabled });
  } catch (error) { next(error); }
});

async function unsubscribeOptionalEmail(req, res, next) {
  try {
    privateEmailResponse(res);
    const data = verifyEmailPreference(req.query.token);
    if (!data) {
      if (req.method === 'POST') return res.status(400).end();
      return res.status(400).send(invalidLinkPage());
    }
    await setEmailPreference(pool, data.email, data.scope, false);
    if (req.method === 'POST') return res.status(204).end();
    const baseUrl = String(process.env.APP_URL || 'https://silvergliderevents.com').replace(/\/$/, '');
    return res.send(statusPage({
      title: 'Unsubscribed',
      message: `You won’t receive ${EMAIL_PREFERENCE_SCOPES[data.scope].label.toLowerCase()}.`,
      manageUrl: `${baseUrl}/email-settings?token=${encodeURIComponent(req.query.token)}`
    }));
  } catch (error) { next(error); }
}

router.get('/unsubscribe-email', unsubscribeOptionalEmail);
router.post('/unsubscribe-email', unsubscribeOptionalEmail);

router.get('/email-settings/host', async (req, res, next) => {
  try {
    privateEmailResponse(res);
    const data = verifyOptout(req.query.token);
    if (!data) return res.status(400).send(invalidLinkPage());
    const { rows } = await pool.query('SELECT org_name,name FROM organizers WHERE id=$1', [data.organizerId]);
    if (!rows.length) return res.status(404).send(invalidLinkPage());
    const hostName = rows[0].org_name || rows[0].name || 'this host';
    const { rows: optedOut } = await pool.query(
      'SELECT 1 FROM follower_optouts WHERE organizer_id=$1 AND LOWER(email)=LOWER($2)',
      [data.organizerId, data.email]
    );
    res.send(renderSettings({
      token: req.query.token,
      enabled: !optedOut.length,
      label: `Invitations and announcements from ${hostName}`,
      description: `Control optional future-event emails from ${hostName}. Essential RSVP and event notices are unaffected.`,
      saveUrl: '/api/email-settings/host'
    }));
  } catch (error) { next(error); }
});

router.post('/api/email-settings/host', async (req, res, next) => {
  try {
    const data = verifyOptout(req.body?.token);
    if (!data || typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: 'That email-settings link is invalid.' });
    }
    if (req.body.enabled) {
      await pool.query(
        'DELETE FROM follower_optouts WHERE organizer_id=$1 AND LOWER(email)=LOWER($2)',
        [data.organizerId, data.email]
      );
    } else {
      await pool.query(
        `INSERT INTO follower_optouts (organizer_id,email)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [data.organizerId, data.email]
      );
    }
    res.json({ ok: true, enabled: req.body.enabled });
  } catch (error) { next(error); }
});

module.exports = router;
