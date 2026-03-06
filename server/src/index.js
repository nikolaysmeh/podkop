'use strict';

require('dotenv').config();

const crypto  = require('crypto');
const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('./db');

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.text({ type: 'text/*', limit: '10mb' }));

const PORT                     = parseInt(process.env.SERVER_PORT)             || 3000;
const ADMIN_SECRET             = process.env.ADMIN_SECRET                      || '';
const CLEANUP_INTERVAL_MINUTES = parseInt(process.env.CLEANUP_INTERVAL_MINUTES) || 5;
const WEBHOOK_MAX_AGE_MINUTES  = parseInt(process.env.WEBHOOK_MAX_AGE_MINUTES)  || 60;
const POLL_BATCH_SIZE          = parseInt(process.env.POLL_BATCH_SIZE)          || 10;

const RESERVED = new Set(['api', 'health', 'admin']);

// ── Helpers ───────────────────────────────────────────────────────────────────

function findBySecret(secret_key) {
  return db.prepare('SELECT * FROM endpoints WHERE secret_key = ?').get(secret_key);
}

function serializeBody(body) {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string')           return body;
  if (Buffer.isBuffer(body))              return body.toString('utf8');
  return JSON.stringify(body);
}

// Parse "Authorization: Basic <base64>" → { username, password } or null
function parseBasicAuth(req) {
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const colon   = decoded.indexOf(':');
    if (colon === -1) return null;
    return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Admin: create webhook endpoint ───────────────────────────────────────────

app.post('/api/admin/create-webhook', (req, res) => {
  if (!ADMIN_SECRET || req.headers['x-admin-secret'] !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { name, username, password } = req.body || {};

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (RESERVED.has(name.toLowerCase())) {
    return res.status(400).json({ error: `"${name}" is a reserved name` });
  }
  if (!/^[a-z0-9_-]+$/i.test(name)) {
    return res.status(400).json({ error: 'Name may only contain letters, digits, _ and -' });
  }
  if ((username && !password) || (!username && password)) {
    return res.status(400).json({ error: 'Provide both username and password, or neither' });
  }

  const existing = db.prepare('SELECT id FROM endpoints WHERE name = ?').get(name);
  if (existing) {
    return res.status(409).json({ error: `Endpoint "${name}" already exists` });
  }

  const secret_key    = crypto.randomBytes(32).toString('hex');
  const password_hash = password ? bcrypt.hashSync(password, 10) : null;

  db.prepare(
    'INSERT INTO endpoints (name, secret_key, username, password, password_hash) VALUES (?, ?, ?, ?, ?)'
  ).run(name, secret_key, username || null, password || null, password_hash);

  console.log(`[admin] Webhook created: /${name} (auth: ${username ? 'basic' : 'none'})`);

  res.status(201).json({
    ok:         true,
    webhookUrl: `/${name}`,
    secretKey:  secret_key,
    auth:       username ? 'basic' : 'none',
  });
});

// ── Admin: list webhook endpoints ────────────────────────────────────────────

app.get('/api/admin/webhooks', (req, res) => {
  if (!ADMIN_SECRET || req.headers['x-admin-secret'] !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const endpoints = db.prepare(
    'SELECT name, secret_key, username, password, created_at FROM endpoints ORDER BY created_at ASC'
  ).all();

  res.json({ endpoints });
});

// ── Admin: delete webhook endpoint ───────────────────────────────────────────

app.delete('/api/admin/webhooks/:name', (req, res) => {
  if (!ADMIN_SECRET || req.headers['x-admin-secret'] !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { name } = req.params;
  const endpoint = db.prepare('SELECT id FROM endpoints WHERE name = ?').get(name);
  if (!endpoint) {
    return res.status(404).json({ error: `Endpoint "${name}" not found` });
  }

  db.prepare('DELETE FROM webhooks WHERE endpoint_name = ?').run(name);
  db.prepare('DELETE FROM endpoints WHERE name = ?').run(name);

  console.log(`[admin] Webhook deleted: /${name}`);
  res.json({ ok: true });
});

// ── Poll: return undelivered webhooks ─────────────────────────────────────────

app.post('/api/poll', (req, res) => {
  const { secret_key } = req.body || {};

  if (!secret_key) {
    return res.status(400).json({ error: 'secret_key is required' });
  }

  const endpoint = findBySecret(secret_key);
  if (!endpoint) {
    return res.status(401).json({ error: 'Invalid secret key' });
  }

  const webhooks = db.prepare(`
    SELECT id, method, payload, headers, received_at
    FROM   webhooks
    WHERE  endpoint_name = ?
    ORDER  BY received_at ASC
    LIMIT  ?
  `).all(endpoint.name, POLL_BATCH_SIZE);

  res.json({ webhooks });
});

// ── ACK: delete delivered webhooks ────────────────────────────────────────────

app.post('/api/ack', (req, res) => {
  const { secret_key, ids } = req.body || {};

  if (!secret_key) {
    return res.status(400).json({ error: 'secret_key is required' });
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }

  const endpoint = findBySecret(secret_key);
  if (!endpoint) {
    return res.status(401).json({ error: 'Invalid secret key' });
  }

  const placeholders = ids.map(() => '?').join(', ');
  const result = db.prepare(
    `DELETE FROM webhooks WHERE id IN (${placeholders}) AND endpoint_name = ?`
  ).run(...ids, endpoint.name);

  console.log(`[ack] Deleted ${result.changes} webhook(s) for "/${endpoint.name}"`);
  res.json({ ok: true, deleted: result.changes });
});

// ── Webhook receiver — catch-all /{name} ──────────────────────────────────────

app.all('/:name', (req, res) => {
  const { name } = req.params;

  const endpoint = db.prepare('SELECT * FROM endpoints WHERE name = ?').get(name);
  if (!endpoint) {
    return res.status(404).json({ error: 'Not found' });
  }

  // Basic auth check (only if endpoint was created with credentials)
  if (endpoint.username) {
    const creds = parseBasicAuth(req);
    if (!creds || creds.username !== endpoint.username || !bcrypt.compareSync(creds.password, endpoint.password_hash)) {
      res.set('WWW-Authenticate', 'Basic realm="webhook"');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  db.prepare(
    'INSERT INTO webhooks (endpoint_name, method, payload, headers) VALUES (?, ?, ?, ?)'
  ).run(name, req.method, serializeBody(req.body), JSON.stringify(req.headers));

  console.log(`[webhook] Stored for "/${name}" [${req.method}]`);
  res.status(200).json({ ok: true });
});

// ── Cleanup job ───────────────────────────────────────────────────────────────

setInterval(() => {
  const result = db.prepare(`
    DELETE FROM webhooks
    WHERE datetime(received_at) < datetime('now', ?)
  `).run(`-${WEBHOOK_MAX_AGE_MINUTES} minutes`);

  if (result.changes > 0) {
    console.log(`[cleanup] Removed ${result.changes} expired webhook(s)`);
  }
}, CLEANUP_INTERVAL_MINUTES * 60 * 1000);

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Webhook server on port ${PORT}`);
  console.log(`  cleanup every ${CLEANUP_INTERVAL_MINUTES} min | max age ${WEBHOOK_MAX_AGE_MINUTES} min | batch ${POLL_BATCH_SIZE}`);
});
