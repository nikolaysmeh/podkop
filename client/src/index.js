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
const os = require('os');
const { pollAndForward } = require('./poll');

// ── Instance ID ───────────────────────────────────────────────────────────────

let machineId;
try {
  machineId = fs.readFileSync('/etc/machine-id', 'utf8').trim();
} catch {
  machineId = 'unknown';
}
const INSTANCE_ID = `${machineId}-${os.hostname()}`;

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
console.log(`[client] Instance ID: ${INSTANCE_ID}`);
webhookConfigs.forEach((e) =>
  console.log(`[client]   secret …${e.secret_key.slice(-8)}  →  ${e.forward_url}`)
);

// ── Start — one independent loop per config entry ─────────────────────────────

setTimeout(() => {
  for (const entry of webhookConfigs) {
    const opts = { ...entry, serverUrl: SERVER_URL, instanceId: INSTANCE_ID };
    pollAndForward(opts);
    setInterval(() => pollAndForward(opts), POLL_INTERVAL_MS);
  }
}, 3000);
