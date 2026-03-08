'use strict';

/**
 * Core poll-forward-ack logic, extracted for testability.
 *
 * @param {object} opts
 * @param {string} opts.secret_key   - Endpoint secret key
 * @param {string} opts.forward_url  - URL to forward webhooks to
 * @param {string} opts.serverUrl    - Podkop server base URL
 * @param {string} opts.instanceId   - Client instance identifier
 */
async function pollAndForward({ secret_key, forward_url, serverUrl, instanceId }) {
  const tag = `…${secret_key.slice(-8)}`;

  // ── Step 1: poll ──────────────────────────────────────────────────────────

  let webhooks;
  try {
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
          'Content-Type':       contentType,
          'X-Original-Method':  wh.method,
          'X-Webhook-Id':       String(wh.id),
          'X-Received-At':      wh.received_at,
          'X-Podkop-Client-Id': instanceId,
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

module.exports = { pollAndForward };
