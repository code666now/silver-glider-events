require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const migrate = require('./db/migrate');
const pool = require('./config/db');
const errorHandler = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 3100;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

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
