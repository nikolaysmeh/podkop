'use strict';

/**
 * Webhook client
 *
 * Reads a JSON config file listing one or more webhook endpoints to poll.
 * Each entry runs its own independent poll → forward → ack loop.
 *
 * Config file format (default: /app/webhooks.json):
 * [
 *   { "secret_key": "abc...", "forward_url": "http://myapp:8080/hook" },
 *   { "secret_key": "xyz...", "forward_url": "http://other:9090/events" }
 * ]
 *
 * Node 20 built-in fetch is used — no npm dependencies.
 */

const fs = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────

const SERVER_URL        = process.env.CLIENT_SERVER_URL;
const CONFIG_PATH       = process.env.CLIENT_WEBHOOKS_CONFIG || '/app/webhooks.json';
const POLL_INTERVAL_MS  = (parseInt(process.env.CLIENT_POLL_INTERVAL_SECONDS) || 10) * 1000;

if (!SERVER_URL) {
  console.error('[client] Missing required env var: CLIENT_SERVER_URL');
  process.exit(1);
}

let webhookConfigs;
try {
  webhookConfigs = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
  console.error(`[client] Cannot read config file ${CONFIG_PATH}: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(webhookConfigs) || webhookConfigs.length === 0) {
  console.error(`[client] ${CONFIG_PATH} must be a non-empty JSON array`);
  process.exit(1);
}

// Validate entries
for (const entry of webhookConfigs) {
  if (!entry.secret_key || !entry.forward_url) {
    console.error('[client] Each entry must have "secret_key" and "forward_url"');
    console.error(`  Got: ${JSON.stringify(entry)}`);
    process.exit(1);
  }
}

console.log(`[client] Started — polling ${SERVER_URL}  every ${POLL_INTERVAL_MS / 1000}s`);
webhookConfigs.forEach((e) =>
  console.log(`[client]   secret …${e.secret_key.slice(-8)}  →  ${e.forward_url}`)
);

// ── Core loop (one instance per config entry) ─────────────────────────────────

async function pollAndForward({ secret_key, forward_url }) {
  const tag = `…${secret_key.slice(-8)}`;

  // ── Step 1: poll ──────────────────────────────────────────────────────────

  let webhooks;
  try {
    const res = await fetch(`${SERVER_URL}/api/poll`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ secret_key }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[poll][${tag}] Server returned ${res.status}: ${text}`);
      return;
    }

    ({ webhooks } = await res.json());
  } catch (err) {
    console.error(`[poll][${tag}] Request failed: ${err.message}`);
    return;
  }

  if (!webhooks || webhooks.length === 0) return;

  console.log(`[poll][${tag}] Received ${webhooks.length} webhook(s)`);

  // ── Step 2: forward each webhook ─────────────────────────────────────────

  const ackedIds = [];

  for (const wh of webhooks) {
    let contentType = 'application/json';
    try {
      const originalHeaders = JSON.parse(wh.headers || '{}');
      if (originalHeaders['content-type']) {
        contentType = originalHeaders['content-type'].split(';')[0].trim();
      }
    } catch { /* ignore */ }

    try {
      const res = await fetch(forward_url, {
        method:  'POST',
        headers: {
          'Content-Type':      contentType,
          'X-Original-Method': wh.method,
          'X-Webhook-Id':      String(wh.id),
          'X-Received-At':     wh.received_at,
        },
        body: wh.payload,
      });

      if (res.ok) {
        ackedIds.push(wh.id);
        console.log(`[forward][${tag}] #${wh.id} → ${forward_url}  OK (${res.status})`);
      } else {
        const text = await res.text().catch(() => '');
        console.error(`[forward][${tag}] #${wh.id} → ${forward_url}  FAILED (${res.status}): ${text}`);
      }
    } catch (err) {
      console.error(`[forward][${tag}] #${wh.id} → ${forward_url}  ERROR: ${err.message}`);
    }
  }

  // ── Step 3: ack successfully forwarded webhooks ───────────────────────────

  if (ackedIds.length === 0) return;

  try {
    const res = await fetch(`${SERVER_URL}/api/ack`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ secret_key, ids: ackedIds }),
    });

    if (res.ok) {
      console.log(`[ack][${tag}] Acknowledged ${ackedIds.length} webhook(s): [${ackedIds.join(', ')}]`);
    } else {
      const text = await res.text().catch(() => '');
      console.error(`[ack][${tag}] Server returned ${res.status}: ${text}`);
    }
  } catch (err) {
    console.error(`[ack][${tag}] Request failed: ${err.message}`);
  }
}

// ── Start — one independent loop per config entry ─────────────────────────────

setTimeout(() => {
  for (const entry of webhookConfigs) {
    pollAndForward(entry);
    setInterval(() => pollAndForward(entry), POLL_INTERVAL_MS);
  }
}, 3000);
