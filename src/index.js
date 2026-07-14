require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const express = require('express');
const migrate = require('./db/migrate');
const pool = require('./config/db');
const errorHandler = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 3100;

const VIEWS = path.join(__dirname, 'views');
const view = name => (req, res) => res.sendFile(path.join(VIEWS, name));

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Routes
app.use(require('./routes/auth'));
app.use(require('./routes/events'));
app.use(require('./routes/uploads'));
app.use(require('./routes/photos'));
app.use(require('./routes/feedback'));
app.use(require('./routes/public'));
app.use(require('./routes/admin'));

// Auth guards for app pages (server-side redirect to /login when signed out)
const requireOrganizer = require('./middleware/requireOrganizer');
const requireAdmin = require('./middleware/requireAdmin');
const { parseSession, readSessionCookie } = require('./lib/session');

// Public pages
app.get('/', view('index.html'));
// Skip the email screen if there's already a valid session
app.get('/login', (req, res) => {
  if (parseSession(readSessionCookie(req))) return res.redirect('/dashboard');
  res.sendFile(path.join(VIEWS, 'login.html'));
});

// Protected app pages — logged-out users are redirected to /login before the page loads
app.get('/dashboard', requireOrganizer, view('dashboard.html'));
app.get('/events', requireOrganizer, view('events.html'));
app.get('/events/new', requireOrganizer, view('event-form.html'));
app.get('/events/:id/edit', requireOrganizer, (req, res) => res.redirect(`/events/new?id=${req.params.id}`));
app.get('/events/:id/manage', requireOrganizer, view('event-manage.html'));
app.get('/settings', requireOrganizer, view('settings.html'));
app.get('/admin/line', requireAdmin, view('admin-line.html'));
app.get('/admin/feedback', requireAdmin, view('admin-feedback.html'));

app.get('/health', async (req, res) => {
  let sha = 'unknown';
  try { sha = fs.readFileSync(path.join(__dirname, '..', '.git-sha'), 'utf8').trim(); } catch (_) {}
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', sha });
  } catch (err) {
    res.status(500).json({ status: 'db_error', sha });
  }
});

app.use(errorHandler);

migrate()
  .then(() => {
    app.listen(PORT, () => console.log(`Silver Glider Events on :${PORT}`));
    require('./jobs/reminders').startReminderCron();
  })
  .catch(err => {
    console.error('[startup] migration failed:', err.message);
    process.exit(1);
  });
