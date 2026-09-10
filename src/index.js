require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const express = require('express');
const migrate = require('./db/migrate');
const pool = require('./config/db');
const errorHandler = require('./middleware/errorHandler');
const { renderLegalPage } = require('./lib/legal-pages');
const { inspectCriticalPublicAssets } = require('./lib/critical-assets');
const { version: APP_VERSION } = require('../package.json');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3100;

const VIEWS = path.join(__dirname, 'views');
const view = name => (req, res) => res.sendFile(path.join(VIEWS, name));
const safeNext = value => {
  const next = String(value || '').trim();
  return next.startsWith('/') && !next.startsWith('//') ? next.slice(0, 700) : '';
};

// Payment signature verification needs the unmodified request bytes. Keep both
// listeners ahead of the global JSON parser and all authenticated app routes.
app.use(
  '/api/webhooks/paypal',
  express.raw({ type: 'application/json', limit: '256kb' }),
  require('./routes/paypal-webhook')
);
app.use(
  '/api/webhooks/stripe/sms',
  express.raw({ type: 'application/json', limit: '256kb' }),
  require('./routes/stripe-sms-webhook')
);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Routes
app.use(require('./routes/auth'));
app.use(require('./routes/events'));
app.use(require('./routes/uploads'));
app.use(require('./routes/event-photos'));
app.use(require('./routes/photos'));
app.use(require('./routes/feedback'));
app.use(require('./routes/invites'));
app.use(require('./routes/follows'));
app.use(require('./routes/commerce'));
app.use(require('./routes/sms-credits'));
app.use(require('./routes/sms-notifications'));
app.use(require('./routes/email-icons'));
app.use(require('./routes/public-hosts'));
app.use(require('./routes/public'));
app.use(require('./routes/admin'));

// Auth guards for app pages (server-side redirect to /login when signed out)
const requireOrganizer = require('./middleware/requireOrganizer');
const requireAdmin = require('./middleware/requireAdmin');
const { parseSession, readSessionCookie } = require('./lib/session');

// Public pages
app.get('/', view('index.html'));
app.get('/privacy', (req, res) => res.type('html').send(renderLegalPage('privacy')));
app.get('/terms', (req, res) => res.type('html').send(renderLegalPage('terms')));
app.get('/privacy-policy', (req, res) => res.redirect(301, '/privacy'));
app.get('/terms-and-conditions', (req, res) => res.redirect(301, '/terms'));
// Skip the email screen if there's already a valid session
app.get('/login', (req, res) => {
  if (parseSession(readSessionCookie(req))) return res.redirect(safeNext(req.query.next) || '/dashboard');
  res.sendFile(path.join(VIEWS, 'login.html'));
});

// Protected app pages — logged-out users are redirected to /login before the page loads
app.get('/dashboard', requireOrganizer, view('dashboard.html'));
app.get('/events', requireOrganizer, view('events.html'));
app.get('/following', requireOrganizer, view('following.html'));
app.get('/add-photo', requireOrganizer, view('add-photo.html'));
app.get('/events/new', requireOrganizer, async (req, res, next) => {
  const invitationToken = String(req.query.invite || '').trim();
  if (!invitationToken) return res.sendFile(path.join(VIEWS, 'event-form.html'));
  try {
    if (/^[a-z0-9-]{12,220}$/.test(invitationToken)) {
      await pool.query(
        `UPDATE host_invitations
            SET joined_organizer_id=COALESCE(joined_organizer_id,$2),
                joined_at=COALESCE(joined_at,NOW()),updated_at=NOW()
          WHERE token=$1 AND revoked_at IS NULL
            AND (joined_organizer_id IS NULL OR joined_organizer_id=$2)`,
        [invitationToken, req.organizer.id]
      );
    }
    res.redirect('/events/new');
  } catch (err) { next(err); }
});
app.get('/events/:id/edit', requireOrganizer, (req, res) => res.redirect(`/events/new?id=${req.params.id}`));
app.get('/events/:id/manage', requireOrganizer, view('event-manage.html'));
app.get([
  '/settings',
  '/settings/account',
  '/settings/messaging',
  '/settings/host-page'
], requireOrganizer, view('settings-v2.html'));
app.get('/admin/line', requireAdmin, view('admin-line.html'));
app.get('/admin/hosts', requireAdmin, view('admin-hosts.html'));
app.get('/admin/ticketing', requireAdmin, view('admin-ticketing.html'));
app.get('/admin/feedback', requireAdmin, view('admin-feedback.html'));
app.get('/admin/invitations', requireAdmin, view('admin-invitations.html'));

app.get('/health', async (req, res) => {
  let sha = 'unknown';
  try { sha = fs.readFileSync(path.join(__dirname, '..', '.git-sha'), 'utf8').trim(); } catch (_) {}
  const assets = inspectCriticalPublicAssets();
  if (!assets.ok) {
    return res.status(500).json({
      status: 'asset_error',
      version: APP_VERSION,
      sha,
      missingAssets: assets.missing,
      invalidAssets: assets.invalid
    });
  }
  try {
    await pool.query('SELECT 1');
    return res.json({ status: 'ok', version: APP_VERSION, sha });
  } catch (err) {
    return res.status(500).json({ status: 'db_error', version: APP_VERSION, sha });
  }
});

app.use(errorHandler);

async function start() {
  await migrate();
  const server = app.listen(PORT, () => console.log(`Silver Glider Events on :${PORT}`));
  require('./jobs/reminders').startReminderCron();
  require('./jobs/event-notifications').startEventNotificationCron();
  require('./jobs/previous-guest-invitations').startPreviousGuestInvitationCron();
  require('./jobs/sms-notifications').startSmsNotificationCron();
  return server;
}

if (require.main === module) {
  start().catch(err => {
    console.error('[startup] migration failed:', err.message);
    process.exit(1);
  });
}

module.exports = { app, start };
