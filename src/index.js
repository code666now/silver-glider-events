require('dotenv').config();
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
app.use(require('./routes/public'));

// Organizer pages (each page fetches /api/auth/me and bounces to /login on 401)
app.get('/login', view('login.html'));
app.get('/dashboard', view('dashboard.html'));
app.get('/events', view('events.html'));
app.get('/events/new', view('event-form.html'));
app.get('/events/:id/edit', (req, res) => res.redirect(`/events/new?id=${req.params.id}`));
app.get('/events/:id/manage', view('event-manage.html'));

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
  })
  .catch(err => {
    console.error('[startup] migration failed:', err.message);
    process.exit(1);
  });
