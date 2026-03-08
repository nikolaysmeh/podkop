'use strict';

const crypto  = require('crypto');
const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('./db');

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.text({ type: 'text/*', limit: '10mb' }));

const ADMIN_SECRET         = process.env.ADMIN_SECRET                       || '';
const POLL_BATCH_SIZE      = parseInt(process.env.POLL_BATCH_SIZE)           || 10;
const MULTI_CLIENT_ENABLED = process.env.MULTI_CLIENT_ENABLED === 'true';
const MAX_DELIVERIES       = parseInt(process.env.MAX_DELIVERIES_PER_WEBHOOK) || 1;

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

// ── Admin: stats ─────────────────────────────────────────────────────────────

app.get('/api/admin/stats', (req, res) => {
  if (!ADMIN_SECRET || req.headers['x-admin-secret'] !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

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

  let deleted = 0;

  if (MULTI_CLIENT_ENABLED) {
    const clientId = req.headers['x-podkop-client-id'] || null;
    if (!clientId) {
      return res.status(400).json({ error: 'X-Podkop-Client-Id header is required in multi-client mode' });
    }

    const insertDelivery  = db.prepare('INSERT OR IGNORE INTO webhook_deliveries (webhook_id, client_id) VALUES (?, ?)');
    const countDeliveries = db.prepare('SELECT COUNT(*) AS cnt FROM webhook_deliveries WHERE webhook_id = ?');
    const deleteDeliveries = db.prepare('DELETE FROM webhook_deliveries WHERE webhook_id = ?');
    const deleteWebhook   = db.prepare('DELETE FROM webhooks WHERE id = ? AND endpoint_name = ?');

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

    console.log(`[ack] multi-client: recorded ${ids.length} delivery(s) for "/${endpoint.name}", deleted ${deleted}`);
  } else {
    const placeholders = ids.map(() => '?').join(', ');
    const result = db.prepare(
      `DELETE FROM webhooks WHERE id IN (${placeholders}) AND endpoint_name = ?`
    ).run(...ids, endpoint.name);
    deleted = result.changes;
    console.log(`[ack] Deleted ${deleted} webhook(s) for "/${endpoint.name}"`);
  }

  res.json({ ok: true, deleted });
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

module.exports = app;
