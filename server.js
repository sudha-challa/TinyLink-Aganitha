// server.js
require('dotenv').config();
console.log("Loaded URL =", process.env.DATABASE_URL);
const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const { URL } = require('url');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("neon") ? { rejectUnauthorized: false } : false,
  // for Neon, you might need ssl options; configure if needed
});

app.use(bodyParser.json());
app.use(express.static('public')); // serves frontend files from public/

/* Helpers */
const CODE_REGEX = /^[A-Za-z0-9]{6,8}$/;

function isValidCode(code) {
  return CODE_REGEX.test(code);
}

function isValidUrl(url) {
  try {
    // require protocol
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function generateRandomCode(length = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < length; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/* Health endpoint */
app.get('/healthz', (req, res) => {
  res.json({ ok: true, version: '1.0' });
});

/* API: Create link
   POST /api/links
   body: { url: string, code?: string }
   Responses:
     201 { code, url, clicks, last_clicked, created_at }
     400 invalid input
     409 code exists
*/
app.post('/api/links', async (req, res) => {
  const { url, code: maybeCode } = req.body || {};
  if (!url || typeof url !== 'string' || !isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid or missing URL. Use http(s)://...' });
  }

  let code = maybeCode;
  if (code) {
    if (typeof code !== 'string' || !isValidCode(code)) {
      return res.status(400).json({ error: 'Custom code must match [A-Za-z0-9]{6,8}.' });
    }
  } else {
    // try generate unique code (try a few times)
    let tries = 0;
    do {
      code = generateRandomCode(6);
      const { rows } = await pool.query('SELECT 1 FROM links WHERE code = $1', [code]);
      if (rows.length === 0) break;
      tries++;
    } while (tries < 5);

    // If collision after attempts, increase to 7-char
    if (!code || (await pool.query('SELECT 1 FROM links WHERE code = $1', [code])).rows.length > 0) {
      do {
        code = generateRandomCode(7);
      } while ((await pool.query('SELECT 1 FROM links WHERE code = $1', [code])).rows.length > 0);
    }
  }

  try {
    const insertText = `INSERT INTO links (code, url) VALUES ($1, $2) RETURNING code, url, clicks, last_clicked, created_at`;
    const result = await pool.query(insertText, [code, url]);
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    // Duplicate code
    if (err.code === '23505' || (err.detail && err.detail.includes('already exists'))) {
      return res.status(409).json({ error: 'Code already exists' });
    }
    console.error('POST /api/links error', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/* API: List all links
   GET /api/links
   Response: array of objects
*/
app.get('/api/links', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT code, url, clicks, last_clicked, created_at FROM links ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    console.error('GET /api/links error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* API: Stats for one code
   GET /api/links/:code
*/
app.get('/api/links/:code', async (req, res) => {
  const { code } = req.params;
  if (!isValidCode(code)) {
    return res.status(400).json({ error: 'Invalid code format' });
  }
  try {
    const { rows } = await pool.query('SELECT code, url, clicks, last_clicked, created_at FROM links WHERE code = $1', [code]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/links/:code error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* API: Delete link
   DELETE /api/links/:code
*/
app.delete('/api/links/:code', async (req, res) => {
  const { code } = req.params;
  if (!isValidCode(code)) return res.status(400).json({ error: 'Invalid code format' });

  try {
    const { rowCount } = await pool.query('DELETE FROM links WHERE code = $1', [code]);
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
    return res.status(204).send();
  } catch (err) {
    console.error('DELETE /api/links/:code error', err);
    return res.status(500).json({ error: 'Server error' });
  }
});



// in server.js, before app.get('/:code', ...) add:
const path = require('path');
app.get('/code/:code', (req, res, next) => {
  // serve the static stats page; client JS will fetch /api/links/:code
  res.sendFile(path.join(__dirname, 'public', 'code.html'));
});


/* Redirect: GET /:code
   302 redirect, increments clicks and update last_clicked
*/
app.get('/:code', async (req, res) => {
  const { code } = req.params;
  if (!isValidCode(code)) {
    // Not a valid code → 404 (automated tests expect 404 after deletion)
    return res.status(404).send('Not found');
  }
  // Use a transaction to atomically read/update
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selectRes = await client.query('SELECT url, clicks FROM links WHERE code = $1 FOR UPDATE', [code]);
    if (selectRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).send('Not found');
    }
    const url = selectRes.rows[0].url;
    await client.query('UPDATE links SET clicks = clicks + 1, last_clicked = now() WHERE code = $1',[code]);
    await client.query('COMMIT');
    return res.redirect(302, url);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Redirect error', err);
    return res.status(500).send('Server error');
  } finally {
    client.release();
  }
});

/* Start server */
app.listen(port, () => {
  console.log(`TinyLink server listening on port ${port}`);
});
