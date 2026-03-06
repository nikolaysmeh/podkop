'use strict';

/**
 * Webhook client
 *
 * 1. Polls the server for undelivered webhooks (POST /api/poll)
 * 2. Forwards each webhook to the configured destination
 * 3. Sends ACK to the server for every successfully forwarded webhook (POST /api/ack)
 * 4. Logs errors when forwarding fails — does NOT ack failed deliveries
 *
 * Node 20 built-in fetch is used — no npm dependencies.
 */

// ── Config ────────────────────────────────────────────────────────────────────

const SERVER_URL       = process.env.CLIENT_SERVER_URL;
const SECRET_KEY       = process.env.CLIENT_POLL_SECRET_KEY;
const POLL_INTERVAL_MS = (parseInt(process.env.CLIENT_POLL_INTERVAL_SECONDS) || 10) * 1000;

const FORWARD_HOST = process.env.CLIENT_FORWARD_HOST || 'localhost';
const FORWARD_PORT = process.env.CLIENT_FORWARD_PORT || '4000';
const FORWARD_PATH = process.env.CLIENT_FORWARD_PATH || '/receive';

const FORWARD_URL = `http://${FORWARD_HOST}:${FORWARD_PORT}${FORWARD_PATH}`;

if (!SERVER_URL || !SECRET_KEY) {
  console.error('[client] Missing required env vars: CLIENT_SERVER_URL, CLIENT_POLL_SECRET_KEY');
  process.exit(1);
}

console.log('[client] Started');
console.log(`[client]   Poll   : POST ${SERVER_URL}/api/poll  every ${POLL_INTERVAL_MS / 1000}s`);
console.log(`[client]   Forward: ${FORWARD_URL}`);

// ── Core loop ─────────────────────────────────────────────────────────────────

async function pollAndForward() {
  // ── Step 1: poll ──────────────────────────────────────────────────────────

  let webhooks;
  try {
    const res = await fetch(`${SERVER_URL}/api/poll`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ secret_key: SECRET_KEY }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[poll] Server returned ${res.status}: ${text}`);
      return;
    }

    ({ webhooks } = await res.json());
  } catch (err) {
    console.error(`[poll] Request failed: ${err.message}`);
    return;
  }

  if (!webhooks || webhooks.length === 0) return;

  console.log(`[poll] Received ${webhooks.length} webhook(s)`);

  // ── Step 2: forward each webhook ─────────────────────────────────────────

  const ackedIds = [];

  for (const wh of webhooks) {
    // Preserve original Content-Type when possible
    let contentType = 'application/json';
    try {
      const originalHeaders = JSON.parse(wh.headers || '{}');
      if (originalHeaders['content-type']) {
        // Strip parameters like charset to avoid duplicate header issues
        contentType = originalHeaders['content-type'].split(';')[0].trim();
      }
    } catch { /* ignore */ }

    try {
      const res = await fetch(FORWARD_URL, {
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
        console.log(`[forward] Webhook ${wh.id} -> ${FORWARD_URL}  OK (${res.status})`);
      } else {
        const text = await res.text().catch(() => '');
        console.error(`[forward] Webhook ${wh.id} -> ${FORWARD_URL}  FAILED (${res.status}): ${text}`);
      }
    } catch (err) {
      console.error(`[forward] Webhook ${wh.id} -> ${FORWARD_URL}  ERROR: ${err.message}`);
    }
  }

  // ── Step 3: ack successfully forwarded webhooks ───────────────────────────

  if (ackedIds.length === 0) return;

  try {
    const res = await fetch(`${SERVER_URL}/api/ack`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ secret_key: SECRET_KEY, ids: ackedIds }),
    });

    if (res.ok) {
      console.log(`[ack] Acknowledged ${ackedIds.length} webhook(s): [${ackedIds.join(', ')}]`);
    } else {
      const text = await res.text().catch(() => '');
      console.error(`[ack] Server returned ${res.status}: ${text}`);
    }
  } catch (err) {
    console.error(`[ack] Request failed: ${err.message}`);
  }
}

// ── Start (small delay to let server become ready) ────────────────────────────

setTimeout(() => {
  pollAndForward();
  setInterval(pollAndForward, POLL_INTERVAL_MS);
}, 3000);
