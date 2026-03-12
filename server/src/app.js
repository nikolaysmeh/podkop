'use strict';

const crypto  = require('crypto');
const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('./db');
const { isAuthenticated, setupAdminRoutes } = require('./admin');

const ADMIN_SECRET         = process.env.ADMIN_SECRET                       || '';
const POLL_BATCH_SIZE      = parseInt(process.env.POLL_BATCH_SIZE)           || 10;
const MULTI_CLIENT_ENABLED = process.env.MULTI_CLIENT_ENABLED?.toLowerCase() === 'true';
const MAX_DELIVERIES       = parseInt(process.env.MAX_DELIVERIES_PER_WEBHOOK) || 1;
const ACK_MAX_IDS          = parseInt(process.env.ACK_MAX_IDS)               || 10;
const WEBHOOK_BODY_LIMIT   = process.env.WEBHOOK_BODY_LIMIT                  || '2mb';
const DEBUG                = process.env.SERVER_DEBUG?.toLowerCase()         === 'true';

function debug(...args) { if (DEBUG) console.log(...args); }

// Rate-limit config — mutable so tests can override at runtime
const config = {
  rateLimitRpm: parseInt(process.env.WEBHOOK_RATE_LIMIT_RPM) || 60,
};

// Allowed-hosts config — mutable so tests can override at runtime
const hostsConfig = {
  allowedHosts: process.env.WEBHOOK_ALLOWED_HOSTS
    ? new Set(process.env.WEBHOOK_ALLOWED_HOSTS.split(',').map(h => h.trim()).filter(Boolean))
    : null,
};

const RESERVED = new Set(['api', 'health', 'admin']);

// ── In-memory rate limiter (sliding 60-second window, per endpoint name) ─────

const rateLimitMap = new Map(); // name → { count, windowStart }

function checkRateLimit(name) {
  if (config.rateLimitRpm <= 0) return true; // 0 = disabled

  const now      = Date.now();
  const windowMs = 60 * 1000;
  const entry    = rateLimitMap.get(name) || { count: 0, windowStart: now };

  if (now - entry.windowStart > windowMs) {
    entry.count      = 1;
    entry.windowStart = now;
  } else {
    entry.count++;
  }

  rateLimitMap.set(name, entry);
  return entry.count <= config.rateLimitRpm;
}

// ── Express setup ─────────────────────────────────────────────────────────────

const app = express();

app.use(express.json({ limit: WEBHOOK_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: WEBHOOK_BODY_LIMIT }));
app.use(express.text({ type: 'text/*', limit: WEBHOOK_BODY_LIMIT }));

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

function checkAllowedHost(req, res) {
  if (!hostsConfig.allowedHosts) return true;
  if (hostsConfig.allowedHosts.has(req.hostname)) return true;
  res.status(403).json({ error: 'Forbidden' });
  return false;
}

function requireAdmin(req, res) {
  const hasSecret = ADMIN_SECRET && req.headers['x-admin-secret'] === ADMIN_SECRET;
  if (!hasSecret && !isAuthenticated(req)) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Admin: create webhook endpoint ───────────────────────────────────────────

app.post('/api/admin/create-webhook', (req, res) => {
  if (!requireAdmin(req, res)) return;

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
    'INSERT INTO endpoints (name, secret_key, username, password_hash) VALUES (?, ?, ?, ?)'
  ).run(name, secret_key, username || null, password_hash);

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
  if (!requireAdmin(req, res)) return;

  const endpoints = db.prepare(
    'SELECT name, secret_key, username, created_at FROM endpoints ORDER BY created_at ASC'
  ).all();

  res.json({ endpoints });
});

// ── Admin: update or disable credentials ─────────────────────────────────────

app.patch('/api/admin/webhooks/:name/credentials', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { name } = req.params;
  const endpoint = db.prepare('SELECT id FROM endpoints WHERE name = ?').get(name);
  if (!endpoint) {
    return res.status(404).json({ error: `Endpoint "${name}" not found` });
  }

  const { username, password } = req.body || {};

  // No body / empty body → disable auth
  if (!username && !password) {
    db.prepare('UPDATE endpoints SET username = NULL, password_hash = NULL WHERE name = ?').run(name);
    console.log(`[admin] Credentials disabled for /${name}`);
    return res.json({ ok: true, auth: 'none' });
  }

  if ((username && !password) || (!username && password)) {
    return res.status(400).json({ error: 'Provide both username and password, or neither' });
  }

  const password_hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE endpoints SET username = ?, password_hash = ? WHERE name = ?')
    .run(username, password_hash, name);

  console.log(`[admin] Credentials updated for /${name}`);
  return res.json({ ok: true, auth: 'basic' });
});

// ── Admin: purge buffered webhooks for an endpoint ───────────────────────────

app.post('/api/admin/webhooks/:name/purge', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { name } = req.params;
  const endpoint = db.prepare('SELECT id FROM endpoints WHERE name = ?').get(name);
  if (!endpoint) {
    return res.status(404).json({ error: `Endpoint "${name}" not found` });
  }

  const webhookIds = db.prepare('SELECT id FROM webhooks WHERE endpoint_name = ?').all(name).map(r => r.id);
  if (webhookIds.length > 0) {
    const ph = webhookIds.map(() => '?').join(', ');
    db.prepare(`DELETE FROM webhook_deliveries WHERE webhook_id IN (${ph})`).run(...webhookIds);
  }
  const { changes: deleted } = db.prepare('DELETE FROM webhooks WHERE endpoint_name = ?').run(name);

  console.log(`[admin] Purged ${deleted} webhook(s) for /${name}`);
  res.json({ ok: true, deleted });
});

// ── Admin: delete webhook endpoint ───────────────────────────────────────────

app.delete('/api/admin/webhooks/:name', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { name } = req.params;
  const endpoint = db.prepare('SELECT id FROM endpoints WHERE name = ?').get(name);
  if (!endpoint) {
    return res.status(404).json({ error: `Endpoint "${name}" not found` });
  }

  const webhookIds = db.prepare('SELECT id FROM webhooks WHERE endpoint_name = ?').all(name).map(r => r.id);
  if (webhookIds.length > 0) {
    const ph = webhookIds.map(() => '?').join(', ');
    db.prepare(`DELETE FROM webhook_deliveries WHERE webhook_id IN (${ph})`).run(...webhookIds);
  }
  db.prepare('DELETE FROM webhooks WHERE endpoint_name = ?').run(name);
  db.prepare('DELETE FROM endpoints WHERE name = ?').run(name);

  console.log(`[admin] Webhook deleted: /${name}`);
  res.json({ ok: true });
});

// ── Admin: list buffered messages for an endpoint ────────────────────────────

app.get('/api/admin/webhooks/:name/messages', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { name } = req.params;
  const endpoint = db.prepare('SELECT id FROM endpoints WHERE name = ?').get(name);
  if (!endpoint) {
    return res.status(404).json({ error: `Endpoint "${name}" not found` });
  }

  const messages = db.prepare(
    'SELECT id, method, payload, headers, received_at FROM webhooks WHERE endpoint_name = ? ORDER BY received_at DESC LIMIT 200'
  ).all(name);

  res.json({ messages });
});

// ── Admin: delete a specific buffered message ─────────────────────────────────

app.delete('/api/admin/webhooks/:name/messages/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { name, id } = req.params;
  const endpoint = db.prepare('SELECT id FROM endpoints WHERE name = ?').get(name);
  if (!endpoint) {
    return res.status(404).json({ error: `Endpoint "${name}" not found` });
  }

  db.prepare('DELETE FROM webhook_deliveries WHERE webhook_id = ?').run(id);
  const { changes } = db.prepare('DELETE FROM webhooks WHERE id = ? AND endpoint_name = ?').run(id, name);

  if (!changes) {
    return res.status(404).json({ error: `Message ${id} not found in "${name}"` });
  }

  console.log(`[admin] Deleted message ${id} from /${name}`);
  res.json({ ok: true });
});

// ── Admin: stats ─────────────────────────────────────────────────────────────

app.get('/api/admin/stats', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const endpoints = db.prepare(
    'SELECT name FROM endpoints ORDER BY created_at ASC'
  ).all();

  const rows = endpoints.map(({ name }) => {
    const { pending } = db.prepare(
      'SELECT COUNT(*) AS pending FROM webhooks WHERE endpoint_name = ?'
    ).get(name);
    const { deliveries } = db.prepare(
      `SELECT COUNT(*) AS deliveries FROM webhook_deliveries
       WHERE webhook_id IN (SELECT id FROM webhooks WHERE endpoint_name = ?)`
    ).get(name);
    return { name, pending, deliveries };
  });

  const totalPending = rows.reduce((s, r) => s + r.pending, 0);

  res.json({ total_pending: totalPending, endpoints: rows });
});

// ── Poll: return undelivered webhooks ─────────────────────────────────────────

app.post('/api/poll', (req, res) => {
  if (!checkAllowedHost(req, res)) return;
  const { secret_key } = req.body || {};

  if (!secret_key) {
    return res.status(400).json({ error: 'secret_key is required' });
  }

  const endpoint = findBySecret(secret_key);
  if (!endpoint) {
    return res.status(401).json({ error: 'Invalid secret key' });
  }

  let webhooks;
  if (MULTI_CLIENT_ENABLED) {
    const clientId = req.headers['x-podkop-client-id'] || null;
    if (clientId) {
      webhooks = db.prepare(`
        SELECT id, method, payload, headers, received_at
        FROM   webhooks
        WHERE  endpoint_name = ?
          AND  id NOT IN (
            SELECT webhook_id FROM webhook_deliveries WHERE client_id = ?
          )
        ORDER  BY received_at ASC
        LIMIT  ?
      `).all(endpoint.name, clientId, POLL_BATCH_SIZE);
    } else {
      webhooks = db.prepare(`
        SELECT id, method, payload, headers, received_at
        FROM   webhooks
        WHERE  endpoint_name = ?
        ORDER  BY received_at ASC
        LIMIT  ?
      `).all(endpoint.name, POLL_BATCH_SIZE);
    }
  } else {
    webhooks = db.prepare(`
      SELECT id, method, payload, headers, received_at
      FROM   webhooks
      WHERE  endpoint_name = ?
      ORDER  BY received_at ASC
      LIMIT  ?
    `).all(endpoint.name, POLL_BATCH_SIZE);
  }

  debug(`[poll][debug] "/${endpoint.name}" → returning ${webhooks.length} webhook(s) ids=[${webhooks.map(w => w.id).join(', ')}]`);
  res.json({ webhooks });
});

// ── ACK: delete delivered webhooks ────────────────────────────────────────────

app.post('/api/ack', (req, res) => {
  if (!checkAllowedHost(req, res)) return;
  const { secret_key, ids } = req.body || {};

  if (!secret_key) {
    return res.status(400).json({ error: 'secret_key is required' });
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  if (ids.length > ACK_MAX_IDS) {
    return res.status(400).json({ error: `ids must contain at most ${ACK_MAX_IDS} entries` });
  }

  const endpoint = findBySecret(secret_key);
  if (!endpoint) {
    return res.status(401).json({ error: 'Invalid secret key' });
  }

  let deleted = 0;

  if (MULTI_CLIENT_ENABLED) {
    const clientId = req.headers['x-podkop-client-id'] || null;
    if (!clientId) {
      return res.status(400).json({ error: 'X-Podkop-Client-Id header is required in multi-client mode' });
    }

    const insertDelivery   = db.prepare('INSERT OR IGNORE INTO webhook_deliveries (webhook_id, client_id) VALUES (?, ?)');
    const countDeliveries  = db.prepare('SELECT COUNT(*) AS cnt FROM webhook_deliveries WHERE webhook_id = ?');
    const deleteDeliveries = db.prepare('DELETE FROM webhook_deliveries WHERE webhook_id = ?');
    const deleteWebhook    = db.prepare('DELETE FROM webhooks WHERE id = ? AND endpoint_name = ?');

    const doAck = db.transaction(() => {
      for (const id of ids) {
        insertDelivery.run(id, clientId);
        const { cnt } = countDeliveries.get(id);
        if (cnt >= MAX_DELIVERIES) {
          deleteDeliveries.run(id);
          const r = deleteWebhook.run(id, endpoint.name);
          deleted += r.changes;
        }
      }
    });
    doAck();

    debug(`[ack][debug] multi-client ids=[${ids.join(', ')}] client=${clientId}`);
    console.log(`[ack] multi-client: recorded ${ids.length} delivery(s) for "/${endpoint.name}", deleted ${deleted}`);
  } else {
    const placeholders = ids.map(() => '?').join(', ');
    const result = db.prepare(
      `DELETE FROM webhooks WHERE id IN (${placeholders}) AND endpoint_name = ?`
    ).run(...ids, endpoint.name);
    deleted = result.changes;
    debug(`[ack][debug] ids=[${ids.join(', ')}]`);
    console.log(`[ack] Deleted ${deleted} webhook(s) for "/${endpoint.name}"`);
  }

  res.json({ ok: true, deleted });
});

// ── Admin panel ───────────────────────────────────────────────────────────────

setupAdminRoutes(app, ADMIN_SECRET);

// ── Webhook receiver — catch-all /{name} ──────────────────────────────────────

app.all('/:name', (req, res) => {
  if (!checkAllowedHost(req, res)) return;
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

  // Rate limiting
  if (!checkRateLimit(name)) {
    return res.status(429).json({ error: 'Too Many Requests' });
  }

  db.prepare(
    'INSERT INTO webhooks (endpoint_name, method, payload, headers) VALUES (?, ?, ?, ?)'
  ).run(name, req.method, serializeBody(req.body), JSON.stringify(req.headers));

  console.log(`[webhook] Stored for "/${name}" [${req.method}]`);
  debug(`[webhook][debug] Headers: ${JSON.stringify(req.headers)}`);
  debug(`[webhook][debug] Body: ${serializeBody(req.body)}`);
  res.status(200).json({ ok: true });
});

module.exports = app;
module.exports.config       = config;
module.exports.hostsConfig  = hostsConfig;
module.exports.rateLimitMap = rateLimitMap;
