'use strict';

const DEBUG = process.env.CLIENT_DEBUG?.toLowerCase() === 'true';
function debug(...args) { if (DEBUG) console.log(...args); }

// Headers that must not be forwarded to the target (hop-by-hop / connection-specific)
const HOP_BY_HOP = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection',
  'keep-alive', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'te',
]);

// Our own metadata header names (lowercase); excluded from original headers copy
// so they don't appear twice with mixed casing.
const OUR_HEADERS = new Set([
  'x-original-method', 'x-webhook-id', 'x-received-at', 'x-podkop-client-id',
]);

// Tracks consecutive delivery failures per webhook ID across poll cycles.
// webhookId (number) → failure count (number)
const failureMap = new Map();

/**
 * Core poll-forward-ack logic, extracted for testability.
 *
 * @param {object} opts
 * @param {string} opts.secret_key           - Endpoint secret key
 * @param {string} opts.forward_url          - URL to forward webhooks to
 * @param {string} opts.serverUrl            - Podkop server base URL
 * @param {string}  opts.instanceId           - Client instance identifier
 * @param {boolean} opts.giveUpEnabled        - Enable give-up after max failures
 * @param {number}  opts.maxDeliveryAttempts  - Give up after this many failures (only when giveUpEnabled=true)
 */
async function pollAndForward({ secret_key, forward_url, serverUrl, instanceId, strip_headers = [], add_headers = {}, giveUpEnabled = false, maxDeliveryAttempts = 0 }) {
  const tag = `…${secret_key.slice(-8)}`;

  // ── Step 1: poll ──────────────────────────────────────────────────────────

  let webhooks;
  try {
    debug(`[poll][${tag}][debug] → ${serverUrl}/api/poll`);
    const res = await fetch(`${serverUrl}/api/poll`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Podkop-Client-Id': instanceId },
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
  debug(`[poll][${tag}][debug] ids=[${webhooks.map(w => w.id).join(', ')}]`);

  // ── Step 2: forward each webhook ─────────────────────────────────────────

  const ackedIds = [];

  for (const wh of webhooks) {
    // Build forward headers: copy original headers minus hop-by-hop and our metadata keys,
    // then overlay our metadata so they are always authoritative.
    let originalHeaders = {};
    try {
      originalHeaders = JSON.parse(wh.headers || '{}');
    } catch { /* ignore */ }

    const fwdHeaders = {};
    for (const [key, val] of Object.entries(originalHeaders)) {
      const lk = key.toLowerCase();
      if (!HOP_BY_HOP.has(lk) && !OUR_HEADERS.has(lk)) {
        fwdHeaders[key] = val;
      }
    }

    if (!fwdHeaders['content-type']) {
      fwdHeaders['content-type'] = 'application/json';
    }

    for (const name of strip_headers) {
      delete fwdHeaders[name.toLowerCase()];
    }

    for (const [name, val] of Object.entries(add_headers)) {
      fwdHeaders[name] = val;
    }

    fwdHeaders['X-Original-Method'] = wh.method;

    debug(`[forward][${tag}][debug] #${wh.id} → POST ${forward_url}  (original method: ${wh.method})`);
    debug(`[forward][${tag}][debug] #${wh.id} headers: ${JSON.stringify(fwdHeaders)}`);
    debug(`[forward][${tag}][debug] #${wh.id} payload: ${wh.payload}`);

    try {
      const res = await fetch(forward_url, {
        method:  'POST',
        headers: fwdHeaders,
        body: wh.payload,
      });

      if (res.ok) {
        ackedIds.push(wh.id);
        failureMap.delete(wh.id);
        console.log(`[forward][${tag}] #${wh.id} → ${forward_url}  OK (${res.status})`);
        if (DEBUG) {
          const body = await res.text().catch(() => '');
          if (body) debug(`[forward][${tag}][debug] #${wh.id} response: ${body}`);
        }
      } else {
        const text = await res.text().catch(() => '');
        const failures = (failureMap.get(wh.id) || 0) + 1;
        const limitStr = giveUpEnabled && maxDeliveryAttempts > 0 ? `/${maxDeliveryAttempts}` : '';
        console.error(`[forward][${tag}] #${wh.id} → ${forward_url}  FAILED (${res.status}): ${text} — attempt ${failures}${limitStr}`);
        if (giveUpEnabled && maxDeliveryAttempts > 0 && failures >= maxDeliveryAttempts) {
          console.warn(`[forward][${tag}] #${wh.id} giving up after ${failures} failure(s) — ACK-ing to drop from server`);
          ackedIds.push(wh.id);
          failureMap.delete(wh.id);
        } else {
          failureMap.set(wh.id, failures);
        }
      }
    } catch (err) {
      const failures = (failureMap.get(wh.id) || 0) + 1;
      const limitStr = giveUpEnabled && maxDeliveryAttempts > 0 ? `/${maxDeliveryAttempts}` : '';
      console.error(`[forward][${tag}] #${wh.id} → ${forward_url}  ERROR: ${err.message} — attempt ${failures}${limitStr}`);
      if (giveUpEnabled && maxDeliveryAttempts > 0 && failures >= maxDeliveryAttempts) {
        console.warn(`[forward][${tag}] #${wh.id} giving up after ${failures} failure(s) — ACK-ing to drop from server`);
        ackedIds.push(wh.id);
        failureMap.delete(wh.id);
      } else {
        failureMap.set(wh.id, failures);
      }
    }
  }

  // ── Step 3: ack successfully forwarded webhooks ───────────────────────────

  if (ackedIds.length === 0) return;

  try {
    debug(`[ack][${tag}][debug] → ${serverUrl}/api/ack ids=[${ackedIds.join(', ')}]`);
    const res = await fetch(`${serverUrl}/api/ack`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Podkop-Client-Id': instanceId },
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

module.exports = { pollAndForward, failureMap };
