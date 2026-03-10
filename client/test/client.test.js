'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { pollAndForward, failureMap } = require('../src/poll');

const SERVER_URL  = 'http://server:3000';
const FORWARD_URL = 'http://target:4000/receive';
const INSTANCE_ID = 'test-machine-abc123';
const SECRET_KEY  = 'aabbccddeeff00112233445566778899';

const DEFAULT_CONFIG = {
  secret_key:  SECRET_KEY,
  forward_url: FORWARD_URL,
  serverUrl:   SERVER_URL,
  instanceId:  INSTANCE_ID,
};

// ── Fetch mock ────────────────────────────────────────────────────────────────

let fetchCalls = [];

/**
 * Replace globalThis.fetch with a mock that returns the given responses in order.
 * Each response is either:
 *   { json, ok, status }  — successful response
 *   an Error instance     — causes fetch to reject
 */
function mockFetch(...responses) {
  let idx = 0;
  fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({
      url,
      method:  init?.method,
      headers: init?.headers,
      body:    init?.body,
    });
    const r = responses[idx++];
    if (r === undefined) throw new Error(`Unexpected extra fetch call #${idx} to ${url}`);
    if (r instanceof Error) throw r;
    const bodyStr = r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? '');
    return {
      ok:     r.ok !== false,
      status: r.status ?? 200,
      json:   async () => r.json,
      text:   async () => bodyStr,
    };
  };
}

beforeEach(() => { fetchCalls = []; failureMap.clear(); });

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeWebhook(overrides = {}) {
  return {
    id:          1,
    method:      'POST',
    payload:     '{"event":"test"}',
    headers:     '{"content-type":"application/json"}',
    received_at: '2024-01-01T00:00:00',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('pollAndForward — no webhooks', () => {
  test('makes only the poll request when server returns empty list', async () => {
    mockFetch({ json: { webhooks: [] } });
    await pollAndForward(DEFAULT_CONFIG);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, `${SERVER_URL}/api/poll`);
  });

  test('makes only the poll request when server returns null webhooks', async () => {
    mockFetch({ json: { webhooks: null } });
    await pollAndForward(DEFAULT_CONFIG);
    assert.equal(fetchCalls.length, 1);
  });
});

describe('pollAndForward — poll failures', () => {
  test('returns early when poll returns non-ok status', async () => {
    mockFetch({ ok: false, status: 401, json: { error: 'Unauthorized' } });
    await pollAndForward(DEFAULT_CONFIG);
    assert.equal(fetchCalls.length, 1);
  });

  test('returns early when poll throws a network error', async () => {
    mockFetch(new Error('ECONNREFUSED'));
    await pollAndForward(DEFAULT_CONFIG);
    assert.equal(fetchCalls.length, 1);
  });
});

describe('pollAndForward — successful full flow', () => {
  test('poll → forward → ack with correct payloads', async () => {
    const wh = makeWebhook({ id: 42 });
    mockFetch(
      { json: { webhooks: [wh] } },
      { ok: true, status: 200, json: { ok: true } },
      { json: { ok: true, deleted: 1 } },
    );

    await pollAndForward(DEFAULT_CONFIG);

    assert.equal(fetchCalls.length, 3);

    // Poll request
    const pollReq = fetchCalls[0];
    assert.equal(pollReq.url, `${SERVER_URL}/api/poll`);
    assert.equal(pollReq.method, 'POST');
    assert.equal(JSON.parse(pollReq.body).secret_key, SECRET_KEY);
    assert.equal(pollReq.headers['X-Podkop-Client-Id'], INSTANCE_ID);

    // Forward request
    const fwdReq = fetchCalls[1];
    assert.equal(fwdReq.url, FORWARD_URL);
    assert.equal(fwdReq.method, 'POST');
    assert.equal(fwdReq.body, wh.payload);
    assert.equal(fwdReq.headers['X-Original-Method'], 'POST');
    assert.equal(fwdReq.headers['X-Webhook-Id'],      undefined);
    assert.equal(fwdReq.headers['X-Received-At'],     undefined);
    assert.equal(fwdReq.headers['X-Podkop-Client-Id'], undefined);

    // Ack request
    const ackReq = fetchCalls[2];
    assert.equal(ackReq.url, `${SERVER_URL}/api/ack`);
    assert.equal(ackReq.method, 'POST');
    const ackBody = JSON.parse(ackReq.body);
    assert.deepEqual(ackBody.ids, [42]);
    assert.equal(ackBody.secret_key, SECRET_KEY);
    assert.equal(ackReq.headers['X-Podkop-Client-Id'], INSTANCE_ID);
  });
});

describe('pollAndForward — forward failures', () => {
  test('does not ack webhook when forward returns non-ok status', async () => {
    const wh = makeWebhook({ id: 7 });
    mockFetch(
      { json: { webhooks: [wh] } },
      { ok: false, status: 503, text: 'Service Unavailable' },
    );

    await pollAndForward(DEFAULT_CONFIG);
    assert.equal(fetchCalls.length, 2); // poll + forward only, no ack
  });

  test('does not ack webhook when forward throws', async () => {
    const wh = makeWebhook({ id: 7 });
    mockFetch(
      { json: { webhooks: [wh] } },
      new Error('Connection refused'),
    );

    await pollAndForward(DEFAULT_CONFIG);
    assert.equal(fetchCalls.length, 2); // poll + forward attempt (threw), no ack
  });
});

describe('pollAndForward — batch handling', () => {
  test('acks only the webhooks that were forwarded successfully', async () => {
    const wh1 = makeWebhook({ id: 1, payload: '{"n":1}' });
    const wh2 = makeWebhook({ id: 2, payload: '{"n":2}' });
    const wh3 = makeWebhook({ id: 3, payload: '{"n":3}' });

    mockFetch(
      { json: { webhooks: [wh1, wh2, wh3] } },
      { ok: true,  status: 200, json: {} }, // wh1 — success
      { ok: false, status: 503, text: '' }, // wh2 — fails
      { ok: true,  status: 200, json: {} }, // wh3 — success
      { json: { ok: true, deleted: 2 } },   // ack wh1 + wh3
    );

    await pollAndForward(DEFAULT_CONFIG);

    assert.equal(fetchCalls.length, 5);
    const ackBody = JSON.parse(fetchCalls[4].body);
    assert.deepEqual(ackBody.ids, [1, 3]);
  });
});

describe('pollAndForward — content-type handling', () => {
  test('forwards content-type from original webhook headers (including charset)', async () => {
    const wh = makeWebhook({ headers: '{"content-type":"application/x-www-form-urlencoded; charset=utf-8"}' });
    mockFetch(
      { json: { webhooks: [wh] } },
      { ok: true, status: 200, json: {} },
      { json: { ok: true } },
    );

    await pollAndForward(DEFAULT_CONFIG);
    assert.equal(fetchCalls[1].headers['content-type'], 'application/x-www-form-urlencoded; charset=utf-8');
  });

  test('forwards content-type as-is including charset suffix', async () => {
    const wh = makeWebhook({ headers: '{"content-type":"text/plain; charset=utf-8"}' });
    mockFetch(
      { json: { webhooks: [wh] } },
      { ok: true, status: 200, json: {} },
      { json: { ok: true } },
    );

    await pollAndForward(DEFAULT_CONFIG);
    assert.equal(fetchCalls[1].headers['content-type'], 'text/plain; charset=utf-8');
  });

  test('defaults to application/json when no content-type in original headers', async () => {
    const wh = makeWebhook({ headers: '{}' });
    mockFetch(
      { json: { webhooks: [wh] } },
      { ok: true, status: 200, json: {} },
      { json: { ok: true } },
    );

    await pollAndForward(DEFAULT_CONFIG);
    assert.equal(fetchCalls[1].headers['content-type'], 'application/json');
  });

  test('defaults to application/json when headers field is malformed JSON', async () => {
    const wh = makeWebhook({ headers: 'not-json' });
    mockFetch(
      { json: { webhooks: [wh] } },
      { ok: true, status: 200, json: {} },
      { json: { ok: true } },
    );

    await pollAndForward(DEFAULT_CONFIG);
    assert.equal(fetchCalls[1].headers['content-type'], 'application/json');
  });
});

describe('pollAndForward — original header forwarding', () => {
  test('forwards all non-hop-by-hop original headers to target', async () => {
    const wh = makeWebhook({
      headers: JSON.stringify({
        'content-type':  'application/json',
        'x-signature':   'sha256=abc123',
        'x-event-type':  'order.paid',
        'authorization': 'Bearer token',
      }),
    });
    mockFetch(
      { json: { webhooks: [wh] } },
      { ok: true, status: 200, json: {} },
      { json: { ok: true } },
    );

    await pollAndForward(DEFAULT_CONFIG);
    const fwdHeaders = fetchCalls[1].headers;
    assert.equal(fwdHeaders['x-signature'],   'sha256=abc123');
    assert.equal(fwdHeaders['x-event-type'],  'order.paid');
    assert.equal(fwdHeaders['authorization'], 'Bearer token');
  });

  test('does not forward hop-by-hop headers (host, content-length, connection, transfer-encoding, keep-alive)', async () => {
    const wh = makeWebhook({
      headers: JSON.stringify({
        'content-type':      'application/json',
        'host':              'example.com',
        'content-length':    '42',
        'connection':        'keep-alive',
        'transfer-encoding': 'chunked',
        'keep-alive':        'timeout=5',
      }),
    });
    mockFetch(
      { json: { webhooks: [wh] } },
      { ok: true, status: 200, json: {} },
      { json: { ok: true } },
    );

    await pollAndForward(DEFAULT_CONFIG);
    const fwdHeaders = fetchCalls[1].headers;
    assert.equal(fwdHeaders['host'],              undefined);
    assert.equal(fwdHeaders['content-length'],    undefined);
    assert.equal(fwdHeaders['connection'],        undefined);
    assert.equal(fwdHeaders['transfer-encoding'], undefined);
    assert.equal(fwdHeaders['keep-alive'],        undefined);
  });

  test('our X-* metadata headers override any matching originals', async () => {
    const wh = makeWebhook({
      headers: JSON.stringify({
        'content-type':       'application/json',
        'x-webhook-id':       '999',
        'x-original-method':  'DELETE',
        'x-podkop-client-id': 'spoofed-id',
      }),
    });
    mockFetch(
      { json: { webhooks: [wh] } },
      { ok: true, status: 200, json: {} },
      { json: { ok: true } },
    );

    await pollAndForward(DEFAULT_CONFIG);
    const fwdHeaders = fetchCalls[1].headers;
    // Only X-Original-Method reaches the target
    assert.equal(fwdHeaders['X-Original-Method'],  wh.method);
    assert.equal(fwdHeaders['X-Webhook-Id'],       undefined);
    assert.equal(fwdHeaders['X-Podkop-Client-Id'], undefined);
    // Lowercase spoofed versions must not be present either
    assert.equal(fwdHeaders['x-webhook-id'],       undefined);
    assert.equal(fwdHeaders['x-original-method'],  undefined);
    assert.equal(fwdHeaders['x-podkop-client-id'], undefined);
  });

  test('null headers field falls back to default content-type and metadata only', async () => {
    const wh = makeWebhook({ headers: null });
    mockFetch(
      { json: { webhooks: [wh] } },
      { ok: true, status: 200, json: {} },
      { json: { ok: true } },
    );

    await pollAndForward(DEFAULT_CONFIG);
    const fwdHeaders = fetchCalls[1].headers;
    assert.equal(fwdHeaders['content-type'],   'application/json');
    assert.equal(fwdHeaders['X-Original-Method'], wh.method);
  });
});

describe('pollAndForward — strip_headers', () => {
  test('removes specified headers before forwarding to target', async () => {
    const wh = makeWebhook({
      headers: JSON.stringify({
        'content-type':  'application/json',
        'authorization': 'Bearer secret',
        'x-signature':   'sha256=abc',
      }),
    });
    mockFetch(
      { json: { webhooks: [wh] } },
      { ok: true, status: 200, json: {} },
      { json: { ok: true } },
    );

    await pollAndForward({ ...DEFAULT_CONFIG, strip_headers: ['authorization'] });
    const fwdHeaders = fetchCalls[1].headers;
    assert.equal(fwdHeaders['authorization'], undefined);
    assert.equal(fwdHeaders['x-signature'],   'sha256=abc'); // untouched
  });

  test('strip_headers matching is case-insensitive', async () => {
    const wh = makeWebhook({
      headers: JSON.stringify({ 'x-signature': 'sha256=abc' }),
    });
    mockFetch(
      { json: { webhooks: [wh] } },
      { ok: true, status: 200, json: {} },
      { json: { ok: true } },
    );

    await pollAndForward({ ...DEFAULT_CONFIG, strip_headers: ['X-Signature'] });
    assert.equal(fetchCalls[1].headers['x-signature'], undefined);
  });

  test('strip_headers can remove content-type (falling back to no default)', async () => {
    const wh = makeWebhook({ headers: '{}' });
    mockFetch(
      { json: { webhooks: [wh] } },
      { ok: true, status: 200, json: {} },
      { json: { ok: true } },
    );

    await pollAndForward({ ...DEFAULT_CONFIG, strip_headers: ['content-type'] });
    assert.equal(fetchCalls[1].headers['content-type'], undefined);
  });
});

describe('pollAndForward — add_headers', () => {
  test('adds extra headers to forward request', async () => {
    const wh = makeWebhook();
    mockFetch(
      { json: { webhooks: [wh] } },
      { ok: true, status: 200, json: {} },
      { json: { ok: true } },
    );

    await pollAndForward({ ...DEFAULT_CONFIG, add_headers: { 'X-Custom': 'my-value' } });
    assert.equal(fetchCalls[1].headers['X-Custom'], 'my-value');
  });

  test('add_headers overrides original headers', async () => {
    const wh = makeWebhook({
      headers: JSON.stringify({ 'content-type': 'text/plain' }),
    });
    mockFetch(
      { json: { webhooks: [wh] } },
      { ok: true, status: 200, json: {} },
      { json: { ok: true } },
    );

    await pollAndForward({ ...DEFAULT_CONFIG, add_headers: { 'content-type': 'application/xml' } });
    assert.equal(fetchCalls[1].headers['content-type'], 'application/xml');
  });

  test('strip then add: strip removes original, add inserts replacement', async () => {
    const wh = makeWebhook({
      headers: JSON.stringify({ 'authorization': 'Bearer incoming-token' }),
    });
    mockFetch(
      { json: { webhooks: [wh] } },
      { ok: true, status: 200, json: {} },
      { json: { ok: true } },
    );

    await pollAndForward({
      ...DEFAULT_CONFIG,
      strip_headers: ['authorization'],
      add_headers:   { 'Authorization': 'Bearer internal-token' },
    });
    assert.equal(fetchCalls[1].headers['Authorization'], 'Bearer internal-token');
    assert.equal(fetchCalls[1].headers['authorization'], undefined);
  });
});

describe('pollAndForward — ack failures', () => {
  test('does not throw when ack returns non-ok status', async () => {
    const wh = makeWebhook({ id: 1 });
    mockFetch(
      { json: { webhooks: [wh] } },
      { ok: true,  status: 200, json: {} },
      { ok: false, status: 500, text: 'Server Error' },
    );

    await assert.doesNotReject(() => pollAndForward(DEFAULT_CONFIG));
  });

  test('does not throw when ack throws a network error', async () => {
    const wh = makeWebhook({ id: 1 });
    mockFetch(
      { json: { webhooks: [wh] } },
      { ok: true, status: 200, json: {} },
      new Error('Network error'),
    );

    await assert.doesNotReject(() => pollAndForward(DEFAULT_CONFIG));
  });
});

describe('pollAndForward — give-up after max failures', () => {
  const GIVE_UP_CONFIG = { ...DEFAULT_CONFIG, giveUpEnabled: true, maxDeliveryAttempts: 3 };

  test('disabled when giveUpEnabled is false (default) — never ACKs failed webhooks', async () => {
    const wh = makeWebhook({ id: 10 });

    for (let i = 0; i < 3; i++) {
      mockFetch(
        { json: { webhooks: [wh] } },
        { ok: false, status: 503, text: 'unavailable' },
      );
      await pollAndForward(DEFAULT_CONFIG); // giveUpEnabled defaults to false
      assert.equal(fetchCalls.length, 2);  // poll + forward only, no ACK
    }
  });

  test('disabled when giveUpEnabled=false even if maxDeliveryAttempts>0', async () => {
    const wh = makeWebhook({ id: 10 });

    for (let i = 0; i < 3; i++) {
      mockFetch(
        { json: { webhooks: [wh] } },
        { ok: false, status: 503, text: 'unavailable' },
      );
      await pollAndForward({ ...DEFAULT_CONFIG, giveUpEnabled: false, maxDeliveryAttempts: 1 });
      assert.equal(fetchCalls.length, 2);  // no ACK regardless
    }
  });

  test('disabled when maxDeliveryAttempts is 0 even if giveUpEnabled=true', async () => {
    const wh = makeWebhook({ id: 10 });

    for (let i = 0; i < 3; i++) {
      mockFetch(
        { json: { webhooks: [wh] } },
        { ok: false, status: 503, text: 'unavailable' },
      );
      await pollAndForward({ ...DEFAULT_CONFIG, giveUpEnabled: true, maxDeliveryAttempts: 0 });
      assert.equal(fetchCalls.length, 2);  // no ACK
    }
  });

  test('does not ACK before reaching maxDeliveryAttempts', async () => {
    const wh = makeWebhook({ id: 11 });

    for (let i = 1; i <= 2; i++) {
      mockFetch(
        { json: { webhooks: [wh] } },
        { ok: false, status: 503, text: 'unavailable' },
      );
      await pollAndForward(GIVE_UP_CONFIG);
      assert.equal(fetchCalls.length, 2);      // no ACK yet
      assert.equal(failureMap.get(wh.id), i);  // counter incremented
    }
  });

  test('ACKs webhook on the Nth failure and clears the counter', async () => {
    const wh = makeWebhook({ id: 12 });

    // Pre-load 2 failures
    for (let i = 0; i < 2; i++) {
      mockFetch(
        { json: { webhooks: [wh] } },
        { ok: false, status: 503, text: 'unavailable' },
      );
      await pollAndForward(GIVE_UP_CONFIG);
    }

    // 3rd failure — triggers give-up ACK
    mockFetch(
      { json: { webhooks: [wh] } },
      { ok: false, status: 503, text: 'unavailable' },
      { json: { ok: true } },
    );
    await pollAndForward(GIVE_UP_CONFIG);

    assert.equal(fetchCalls.length, 3); // poll + forward + ack
    const ackBody = JSON.parse(fetchCalls[2].body);
    assert.deepEqual(ackBody.ids, [wh.id]);
    assert.equal(failureMap.has(wh.id), false); // counter cleared
  });

  test('success resets the failure counter', async () => {
    const wh = makeWebhook({ id: 13 });

    // 2 failures
    for (let i = 0; i < 2; i++) {
      mockFetch(
        { json: { webhooks: [wh] } },
        { ok: false, status: 503, text: 'unavailable' },
      );
      await pollAndForward(GIVE_UP_CONFIG);
    }
    assert.equal(failureMap.get(wh.id), 2);

    // Success — counter should be cleared
    mockFetch(
      { json: { webhooks: [wh] } },
      { ok: true, status: 200, json: {} },
      { json: { ok: true } },
    );
    await pollAndForward(GIVE_UP_CONFIG);

    assert.equal(failureMap.has(wh.id), false);
    const ackBody = JSON.parse(fetchCalls[2].body);
    assert.deepEqual(ackBody.ids, [wh.id]); // normal ACK
  });

  test('network error counts as a failure and triggers give-up on Nth error', async () => {
    const wh = makeWebhook({ id: 14 });

    // 2 network errors
    for (let i = 0; i < 2; i++) {
      mockFetch(
        { json: { webhooks: [wh] } },
        new Error('ECONNREFUSED'),
      );
      await pollAndForward(GIVE_UP_CONFIG);
    }

    // 3rd error — triggers give-up
    mockFetch(
      { json: { webhooks: [wh] } },
      new Error('ECONNREFUSED'),
      { json: { ok: true } },
    );
    await pollAndForward(GIVE_UP_CONFIG);

    assert.equal(fetchCalls.length, 3); // poll + forward attempt (threw) + ack
    const ackBody = JSON.parse(fetchCalls[2].body);
    assert.deepEqual(ackBody.ids, [wh.id]);
    assert.equal(failureMap.has(wh.id), false);
  });

  test('mixed batch: given-up webhook and successful webhook are both ACKed together', async () => {
    const wh1 = makeWebhook({ id: 20, payload: '{"n":1}' });
    const wh2 = makeWebhook({ id: 21, payload: '{"n":2}' });

    // Pre-seed wh1 with 2 failures
    for (let i = 0; i < 2; i++) {
      mockFetch(
        { json: { webhooks: [wh1] } },
        { ok: false, status: 503, text: 'unavailable' },
      );
      await pollAndForward(GIVE_UP_CONFIG);
    }

    // Final poll: wh1 fails (3rd → give-up), wh2 succeeds
    mockFetch(
      { json: { webhooks: [wh1, wh2] } },
      { ok: false, status: 503, text: 'unavailable' }, // wh1 — 3rd failure
      { ok: true,  status: 200, json: {} },            // wh2 — success
      { json: { ok: true } },                          // ack both
    );
    await pollAndForward(GIVE_UP_CONFIG);

    assert.equal(fetchCalls.length, 4); // poll + fwd1 + fwd2 + ack
    const ackBody = JSON.parse(fetchCalls[3].body);
    assert.deepEqual(ackBody.ids, [wh1.id, wh2.id]);
  });
});
