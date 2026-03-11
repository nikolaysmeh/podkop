'use strict';

// Set env vars before any module is required
process.env.DB_PATH                   = ':memory:';
process.env.ADMIN_SECRET              = 'test-secret';
process.env.MULTI_CLIENT_ENABLED      = 'false';
process.env.MAX_DELIVERIES_PER_WEBHOOK = '1';
process.env.POLL_BATCH_SIZE           = '5';
process.env.ACK_MAX_IDS               = '10';

const { test, describe, beforeEach } = require('node:test');
const assert  = require('node:assert/strict');
const request = require('supertest');
const db      = require('../src/db');
const app     = require('../src/app');

const ADMIN = 'test-secret';

// ── DB reset between tests ────────────────────────────────────────────────────

beforeEach(() => {
  db.prepare('DELETE FROM webhook_deliveries').run();
  db.prepare('DELETE FROM webhooks').run();
  db.prepare('DELETE FROM endpoints').run();
  app.rateLimitMap.clear();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function createEndpoint(name, extra = {}) {
  return request(app)
    .post('/api/admin/create-webhook')
    .set('x-admin-secret', ADMIN)
    .send({ name, ...extra });
}

function receiveWebhook(name, payload = { test: true }, opts = {}) {
  let req = request(app).post(`/${name}`).send(payload);
  if (opts.auth) req = req.auth(opts.auth.user, opts.auth.pass);
  return req;
}

function poll(secretKey, extraHeaders = {}) {
  return request(app)
    .post('/api/poll')
    .set(extraHeaders)
    .send({ secret_key: secretKey });
}

function ack(secretKey, ids, extraHeaders = {}) {
  return request(app)
    .post('/api/ack')
    .set(extraHeaders)
    .send({ secret_key: secretKey, ids });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  test('returns { ok: true }', async () => {
    const res = await request(app).get('/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });
});

describe('POST /api/admin/create-webhook', () => {
  test('creates an open endpoint', async () => {
    const res = await createEndpoint('mywebhook');
    assert.equal(res.status, 201);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.webhookUrl, '/mywebhook');
    assert.equal(typeof res.body.secretKey, 'string');
    assert.ok(res.body.secretKey.length > 0);
    assert.equal(res.body.auth, 'none');
  });

  test('creates a basic-auth protected endpoint', async () => {
    const res = await createEndpoint('secured', { username: 'alice', password: 'pass123' });
    assert.equal(res.status, 201);
    assert.equal(res.body.auth, 'basic');
  });

  test('response does not contain plaintext password', async () => {
    const res = await createEndpoint('secured', { username: 'alice', password: 'pass123' });
    assert.equal(res.status, 201);
    assert.equal(res.body.password, undefined);
    assert.equal(JSON.stringify(res.body).includes('pass123'), false);
  });

  test('400 — missing name', async () => {
    const res = await request(app)
      .post('/api/admin/create-webhook')
      .set('x-admin-secret', ADMIN)
      .send({});
    assert.equal(res.status, 400);
  });

  test('400 — reserved name "api"', async () => {
    const res = await createEndpoint('api');
    assert.equal(res.status, 400);
  });

  test('400 — reserved name "health"', async () => {
    const res = await createEndpoint('health');
    assert.equal(res.status, 400);
  });

  test('400 — reserved name "admin"', async () => {
    const res = await createEndpoint('admin');
    assert.equal(res.status, 400);
  });

  test('400 — invalid chars in name', async () => {
    const res = await createEndpoint('my webhook!');
    assert.equal(res.status, 400);
  });

  test('409 — duplicate name', async () => {
    await createEndpoint('dup');
    const res = await createEndpoint('dup');
    assert.equal(res.status, 409);
  });

  test('400 — username without password', async () => {
    const res = await createEndpoint('partial', { username: 'alice' });
    assert.equal(res.status, 400);
  });

  test('400 — password without username', async () => {
    const res = await createEndpoint('partial', { password: 'secret' });
    assert.equal(res.status, 400);
  });

  test('403 — wrong admin secret', async () => {
    const res = await request(app)
      .post('/api/admin/create-webhook')
      .set('x-admin-secret', 'wrong')
      .send({ name: 'test' });
    assert.equal(res.status, 403);
  });

  test('403 — no admin secret header', async () => {
    const res = await request(app)
      .post('/api/admin/create-webhook')
      .send({ name: 'test' });
    assert.equal(res.status, 403);
  });
});

describe('GET /api/admin/webhooks', () => {
  test('returns empty list', async () => {
    const res = await request(app).get('/api/admin/webhooks').set('x-admin-secret', ADMIN);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.endpoints, []);
  });

  test('returns list of created endpoints', async () => {
    await createEndpoint('ep1');
    await createEndpoint('ep2');
    const res = await request(app).get('/api/admin/webhooks').set('x-admin-secret', ADMIN);
    assert.equal(res.status, 200);
    assert.equal(res.body.endpoints.length, 2);
    assert.equal(res.body.endpoints[0].name, 'ep1');
    assert.equal(res.body.endpoints[1].name, 'ep2');
    assert.ok(res.body.endpoints[0].secret_key);
  });

  test('does not return plaintext password for protected endpoint', async () => {
    await createEndpoint('prot', { username: 'alice', password: 'pass123' });
    const res = await request(app).get('/api/admin/webhooks').set('x-admin-secret', ADMIN);
    assert.equal(res.status, 200);
    assert.equal(res.body.endpoints[0].username, 'alice');
    assert.equal(res.body.endpoints[0].password, undefined);
    assert.equal(JSON.stringify(res.body).includes('pass123'), false);
  });

  test('403 — wrong admin secret', async () => {
    const res = await request(app).get('/api/admin/webhooks').set('x-admin-secret', 'wrong');
    assert.equal(res.status, 403);
  });
});

describe('PATCH /api/admin/webhooks/:name/credentials', () => {
  test('updates credentials on a protected endpoint', async () => {
    await createEndpoint('ep', { username: 'alice', password: 'old' });

    const res = await request(app)
      .patch('/api/admin/webhooks/ep/credentials')
      .set('x-admin-secret', ADMIN)
      .send({ username: 'bob', password: 'newpass' });
    assert.equal(res.status, 200);
    assert.equal(res.body.auth, 'basic');

    // New credentials work
    const ok = await receiveWebhook('ep', { x: 1 }, { auth: { user: 'bob', pass: 'newpass' } });
    assert.equal(ok.status, 200);

    // Old credentials rejected
    const fail = await receiveWebhook('ep', { x: 1 }, { auth: { user: 'alice', pass: 'old' } });
    assert.equal(fail.status, 401);
  });

  test('disables auth when called with empty body', async () => {
    await createEndpoint('ep', { username: 'alice', password: 'secret' });

    const res = await request(app)
      .patch('/api/admin/webhooks/ep/credentials')
      .set('x-admin-secret', ADMIN)
      .send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.auth, 'none');

    // Now reachable without credentials
    const open = await receiveWebhook('ep');
    assert.equal(open.status, 200);
  });

  test('response does not contain plaintext password', async () => {
    await createEndpoint('ep');
    const res = await request(app)
      .patch('/api/admin/webhooks/ep/credentials')
      .set('x-admin-secret', ADMIN)
      .send({ username: 'u', password: 'supersecret' });
    assert.equal(res.status, 200);
    assert.equal(JSON.stringify(res.body).includes('supersecret'), false);
  });

  test('400 — username without password', async () => {
    await createEndpoint('ep');
    const res = await request(app)
      .patch('/api/admin/webhooks/ep/credentials')
      .set('x-admin-secret', ADMIN)
      .send({ username: 'alice' });
    assert.equal(res.status, 400);
  });

  test('404 — non-existent endpoint', async () => {
    const res = await request(app)
      .patch('/api/admin/webhooks/ghost/credentials')
      .set('x-admin-secret', ADMIN)
      .send({ username: 'u', password: 'p' });
    assert.equal(res.status, 404);
  });

  test('403 — wrong admin secret', async () => {
    await createEndpoint('ep');
    const res = await request(app)
      .patch('/api/admin/webhooks/ep/credentials')
      .set('x-admin-secret', 'wrong')
      .send({ username: 'u', password: 'p' });
    assert.equal(res.status, 403);
  });
});

describe('POST /api/admin/webhooks/:name/purge', () => {
  test('deletes all buffered webhooks and returns count', async () => {
    const { body: { secretKey } } = await createEndpoint('ep');
    await receiveWebhook('ep', { n: 1 });
    await receiveWebhook('ep', { n: 2 });
    await receiveWebhook('ep', { n: 3 });

    const res = await request(app)
      .post('/api/admin/webhooks/ep/purge')
      .set('x-admin-secret', ADMIN);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.deleted, 3);

    // endpoint still exists; queue is now empty
    const { body: { webhooks } } = await poll(secretKey);
    assert.deepEqual(webhooks, []);
  });

  test('returns 0 when queue is already empty', async () => {
    await createEndpoint('ep');
    const res = await request(app)
      .post('/api/admin/webhooks/ep/purge')
      .set('x-admin-secret', ADMIN);
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 0);
  });

  test('endpoint survives purge — new webhooks can be received', async () => {
    const { body: { secretKey } } = await createEndpoint('ep');
    await receiveWebhook('ep');
    await request(app).post('/api/admin/webhooks/ep/purge').set('x-admin-secret', ADMIN);

    await receiveWebhook('ep', { n: 'new' });
    const { body: { webhooks } } = await poll(secretKey);
    assert.equal(webhooks.length, 1);
    assert.equal(JSON.parse(webhooks[0].payload).n, 'new');
  });

  test('404 — non-existent endpoint', async () => {
    const res = await request(app)
      .post('/api/admin/webhooks/ghost/purge')
      .set('x-admin-secret', ADMIN);
    assert.equal(res.status, 404);
  });

  test('403 — wrong admin secret', async () => {
    await createEndpoint('ep');
    const res = await request(app)
      .post('/api/admin/webhooks/ep/purge')
      .set('x-admin-secret', 'wrong');
    assert.equal(res.status, 403);
  });
});

describe('DELETE /api/admin/webhooks/:name', () => {
  test('deletes existing endpoint', async () => {
    await createEndpoint('todel');
    const res = await request(app).delete('/api/admin/webhooks/todel').set('x-admin-secret', ADMIN);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    const list = await request(app).get('/api/admin/webhooks').set('x-admin-secret', ADMIN);
    assert.equal(list.body.endpoints.length, 0);
  });

  test('404 — non-existent endpoint', async () => {
    const res = await request(app).delete('/api/admin/webhooks/ghost').set('x-admin-secret', ADMIN);
    assert.equal(res.status, 404);
  });

  test('also deletes associated webhooks', async () => {
    const { body: { secretKey } } = await createEndpoint('ep');
    await receiveWebhook('ep');
    await receiveWebhook('ep');

    const { body: { webhooks } } = await poll(secretKey);
    assert.equal(webhooks.length, 2);

    await request(app).delete('/api/admin/webhooks/ep').set('x-admin-secret', ADMIN);

    const row = db.prepare('SELECT COUNT(*) AS cnt FROM webhooks WHERE endpoint_name = ?').get('ep');
    assert.equal(row.cnt, 0);
  });

  test('403 — wrong admin secret', async () => {
    await createEndpoint('ep');
    const res = await request(app).delete('/api/admin/webhooks/ep').set('x-admin-secret', 'wrong');
    assert.equal(res.status, 403);
  });
});

describe('GET /api/admin/webhooks/:name/messages', () => {
  test('returns empty array when no messages', async () => {
    await createEndpoint('ep');
    const res = await request(app).get('/api/admin/webhooks/ep/messages').set('x-admin-secret', ADMIN);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.messages, []);
  });

  test('returns buffered messages with payload', async () => {
    await createEndpoint('ep');
    await receiveWebhook('ep', { x: 1 });
    await receiveWebhook('ep', { x: 2 });

    const res = await request(app).get('/api/admin/webhooks/ep/messages').set('x-admin-secret', ADMIN);
    assert.equal(res.status, 200);
    assert.equal(res.body.messages.length, 2);
    assert.ok(res.body.messages[0].id);
    assert.ok(res.body.messages[0].method);
    assert.ok(res.body.messages[0].received_at);
  });

  test('404 — non-existent endpoint', async () => {
    const res = await request(app).get('/api/admin/webhooks/ghost/messages').set('x-admin-secret', ADMIN);
    assert.equal(res.status, 404);
  });

  test('403 — wrong admin secret', async () => {
    await createEndpoint('ep');
    const res = await request(app).get('/api/admin/webhooks/ep/messages').set('x-admin-secret', 'wrong');
    assert.equal(res.status, 403);
  });
});

describe('DELETE /api/admin/webhooks/:name/messages/:id', () => {
  test('deletes specific message by id', async () => {
    const { body: { secretKey } } = await createEndpoint('ep');
    await receiveWebhook('ep', { n: 1 });
    await receiveWebhook('ep', { n: 2 });

    const listRes = await request(app).get('/api/admin/webhooks/ep/messages').set('x-admin-secret', ADMIN);
    const id = listRes.body.messages[0].id;

    const delRes = await request(app)
      .delete(`/api/admin/webhooks/ep/messages/${id}`)
      .set('x-admin-secret', ADMIN);
    assert.equal(delRes.status, 200);
    assert.equal(delRes.body.ok, true);

    const { body: { webhooks } } = await poll(secretKey);
    assert.equal(webhooks.length, 1);
  });

  test('404 — message not found', async () => {
    await createEndpoint('ep');
    const res = await request(app)
      .delete('/api/admin/webhooks/ep/messages/99999')
      .set('x-admin-secret', ADMIN);
    assert.equal(res.status, 404);
  });

  test('404 — endpoint not found', async () => {
    const res = await request(app)
      .delete('/api/admin/webhooks/ghost/messages/1')
      .set('x-admin-secret', ADMIN);
    assert.equal(res.status, 404);
  });

  test('403 — wrong admin secret', async () => {
    await createEndpoint('ep');
    const res = await request(app)
      .delete('/api/admin/webhooks/ep/messages/1')
      .set('x-admin-secret', 'wrong');
    assert.equal(res.status, 403);
  });
});

describe('GET /api/admin/stats', () => {
  test('returns empty stats when no endpoints', async () => {
    const res = await request(app).get('/api/admin/stats').set('x-admin-secret', ADMIN);
    assert.equal(res.status, 200);
    assert.equal(res.body.total_pending, 0);
    assert.deepEqual(res.body.endpoints, []);
  });

  test('returns pending counts per endpoint', async () => {
    await createEndpoint('ep1');
    await createEndpoint('ep2');
    await receiveWebhook('ep1');
    await receiveWebhook('ep1');
    await receiveWebhook('ep2');

    const res = await request(app).get('/api/admin/stats').set('x-admin-secret', ADMIN);
    assert.equal(res.status, 200);
    assert.equal(res.body.total_pending, 3);

    const ep1 = res.body.endpoints.find(e => e.name === 'ep1');
    const ep2 = res.body.endpoints.find(e => e.name === 'ep2');
    assert.equal(ep1.pending, 2);
    assert.equal(ep2.pending, 1);
  });

  test('403 — wrong admin secret', async () => {
    const res = await request(app).get('/api/admin/stats').set('x-admin-secret', 'wrong');
    assert.equal(res.status, 403);
  });
});

describe('POST /:name (webhook receiver)', () => {
  test('stores webhook and returns { ok: true }', async () => {
    await createEndpoint('ep');
    const res = await receiveWebhook('ep', { event: 'order.paid', id: 1 });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    const row = db.prepare('SELECT * FROM webhooks WHERE endpoint_name = ?').get('ep');
    assert.ok(row);
    assert.equal(row.method, 'POST');
    assert.equal(row.payload, JSON.stringify({ event: 'order.paid', id: 1 }));
  });

  test('404 — unknown endpoint', async () => {
    const res = await request(app).post('/unknown').send({ test: true });
    assert.equal(res.status, 404);
  });

  test('stores GET request with correct method', async () => {
    await createEndpoint('ep');
    const res = await request(app).get('/ep');
    assert.equal(res.status, 200);
    const row = db.prepare('SELECT * FROM webhooks WHERE endpoint_name = ?').get('ep');
    assert.equal(row.method, 'GET');
  });

  test('stores text/plain body', async () => {
    await createEndpoint('ep');
    const res = await request(app).post('/ep').set('Content-Type', 'text/plain').send('hello world');
    assert.equal(res.status, 200);
    const row = db.prepare('SELECT * FROM webhooks WHERE endpoint_name = ?').get('ep');
    assert.equal(row.payload, 'hello world');
  });

  test('stores original request headers', async () => {
    await createEndpoint('ep');
    await request(app).post('/ep').set('x-custom-header', 'my-value').send({ x: 1 });
    const row = db.prepare('SELECT * FROM webhooks WHERE endpoint_name = ?').get('ep');
    const headers = JSON.parse(row.headers);
    assert.equal(headers['x-custom-header'], 'my-value');
  });

  test('stores headers as JSON string (empty object when no custom headers)', async () => {
    await createEndpoint('ep');
    await request(app).post('/ep').send({ x: 1 });
    const row = db.prepare('SELECT * FROM webhooks WHERE endpoint_name = ?').get('ep');
    assert.ok(row.headers);
    const headers = JSON.parse(row.headers);
    assert.equal(typeof headers, 'object');
  });

  test('401 — protected endpoint with no credentials', async () => {
    await createEndpoint('prot', { username: 'alice', password: 'pass123' });
    const res = await request(app).post('/prot').send({ test: true });
    assert.equal(res.status, 401);
    assert.equal(res.headers['www-authenticate'], 'Basic realm="webhook"');
  });

  test('200 — protected endpoint with valid credentials', async () => {
    await createEndpoint('prot', { username: 'alice', password: 'pass123' });
    const res = await receiveWebhook('prot', { test: true }, { auth: { user: 'alice', pass: 'pass123' } });
    assert.equal(res.status, 200);
  });

  test('401 — protected endpoint with wrong password', async () => {
    await createEndpoint('prot', { username: 'alice', password: 'pass123' });
    const res = await receiveWebhook('prot', { test: true }, { auth: { user: 'alice', pass: 'wrong' } });
    assert.equal(res.status, 401);
  });

  test('401 — protected endpoint with wrong username', async () => {
    await createEndpoint('prot', { username: 'alice', password: 'pass123' });
    const res = await receiveWebhook('prot', { test: true }, { auth: { user: 'bob', pass: 'pass123' } });
    assert.equal(res.status, 401);
  });

  test('429 — rate limit exceeded', async () => {
    await createEndpoint('rl');
    const origLimit = app.config.rateLimitRpm;
    app.config.rateLimitRpm = 2;
    try {
      assert.equal((await receiveWebhook('rl')).status, 200);
      assert.equal((await receiveWebhook('rl')).status, 200);
      assert.equal((await receiveWebhook('rl')).status, 429);
    } finally {
      app.config.rateLimitRpm = origLimit;
    }
  });

  test('rate limit is per endpoint name (independent counters)', async () => {
    await createEndpoint('ep-a');
    await createEndpoint('ep-b');
    const origLimit = app.config.rateLimitRpm;
    app.config.rateLimitRpm = 1;
    try {
      assert.equal((await receiveWebhook('ep-a')).status, 200);
      assert.equal((await receiveWebhook('ep-a')).status, 429); // ep-a exhausted
      assert.equal((await receiveWebhook('ep-b')).status, 200); // ep-b unaffected
    } finally {
      app.config.rateLimitRpm = origLimit;
    }
  });
});

describe('POST /api/poll', () => {
  test('400 — missing secret_key', async () => {
    const res = await request(app).post('/api/poll').send({});
    assert.equal(res.status, 400);
  });

  test('401 — invalid secret_key', async () => {
    const res = await request(app).post('/api/poll').send({ secret_key: 'invalid' });
    assert.equal(res.status, 401);
  });

  test('returns empty array when no webhooks pending', async () => {
    const { body: { secretKey } } = await createEndpoint('ep');
    const res = await poll(secretKey);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.webhooks, []);
  });

  test('returns stored webhooks with correct fields', async () => {
    const { body: { secretKey } } = await createEndpoint('ep');
    await receiveWebhook('ep', { event: 'test' });

    const res = await poll(secretKey);
    assert.equal(res.status, 200);
    assert.equal(res.body.webhooks.length, 1);
    const wh = res.body.webhooks[0];
    assert.ok(wh.id);
    assert.equal(wh.method, 'POST');
    assert.ok(wh.payload);
    assert.ok(wh.headers);
    assert.ok(wh.received_at);
  });

  test('poll response includes original request headers with correct values', async () => {
    const { body: { secretKey } } = await createEndpoint('ep');
    await request(app)
      .post('/ep')
      .set('x-custom-header', 'my-value')
      .set('x-event-type', 'order.paid')
      .send({ x: 1 });

    const res = await poll(secretKey);
    assert.equal(res.status, 200);
    const wh = res.body.webhooks[0];
    const headers = JSON.parse(wh.headers);
    assert.equal(headers['x-custom-header'], 'my-value');
    assert.equal(headers['x-event-type'],    'order.paid');
    assert.ok(headers['content-type']); // content-type is always present
  });

  test('returns webhooks in received_at order (oldest first)', async () => {
    const { body: { secretKey } } = await createEndpoint('ep');
    await receiveWebhook('ep', { n: 1 });
    await receiveWebhook('ep', { n: 2 });
    await receiveWebhook('ep', { n: 3 });

    const res = await poll(secretKey);
    const payloads = res.body.webhooks.map(w => JSON.parse(w.payload));
    assert.equal(payloads[0].n, 1);
    assert.equal(payloads[1].n, 2);
    assert.equal(payloads[2].n, 3);
  });

  test('respects POLL_BATCH_SIZE (set to 5 in test env)', async () => {
    const { body: { secretKey } } = await createEndpoint('ep');
    for (let i = 0; i < 10; i++) await receiveWebhook('ep', { n: i });

    const res = await poll(secretKey);
    assert.equal(res.body.webhooks.length, 5);
  });
});

describe('POST /api/ack', () => {
  test('400 — missing secret_key', async () => {
    const res = await request(app).post('/api/ack').send({ ids: [1] });
    assert.equal(res.status, 400);
  });

  test('400 — empty ids array', async () => {
    const { body: { secretKey } } = await createEndpoint('ep');
    const res = await ack(secretKey, []);
    assert.equal(res.status, 400);
  });

  test('400 — ids is not an array', async () => {
    const { body: { secretKey } } = await createEndpoint('ep');
    const res = await request(app).post('/api/ack').send({ secret_key: secretKey, ids: 'bad' });
    assert.equal(res.status, 400);
  });

  test('400 — ids exceeds ACK_MAX_IDS limit', async () => {
    const { body: { secretKey } } = await createEndpoint('ep');
    const tooMany = Array.from({ length: 11 }, (_, i) => i + 1);
    const res = await ack(secretKey, tooMany);
    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes('10'));
  });

  test('accepts ids up to ACK_MAX_IDS limit', async () => {
    const { body: { secretKey } } = await createEndpoint('ep');
    // Insert 10 webhooks directly to avoid rate limiting
    for (let i = 0; i < 10; i++) {
      db.prepare('INSERT INTO webhooks (endpoint_name, method, payload) VALUES (?, ?, ?)').run('ep', 'POST', '{}');
    }
    const { body: { webhooks } } = await poll(secretKey); // returns up to POLL_BATCH_SIZE=5
    const ids = webhooks.map(w => w.id);
    const res = await ack(secretKey, ids);
    assert.equal(res.status, 200);
  });

  test('401 — invalid secret_key', async () => {
    const res = await ack('invalid-key', [1]);
    assert.equal(res.status, 401);
  });

  test('deletes specified webhooks and returns deleted count', async () => {
    const { body: { secretKey } } = await createEndpoint('ep');
    await receiveWebhook('ep', { n: 1 });
    await receiveWebhook('ep', { n: 2 });

    const { body: { webhooks } } = await poll(secretKey);
    const ids = webhooks.map(w => w.id);

    const res = await ack(secretKey, ids);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.deleted, 2);

    const { body: { webhooks: remaining } } = await poll(secretKey);
    assert.deepEqual(remaining, []);
  });

  test('ignores IDs that belong to a different endpoint', async () => {
    const { body: { secretKey: sk1 } } = await createEndpoint('ep1');
    const { body: { secretKey: sk2 } } = await createEndpoint('ep2');
    await receiveWebhook('ep1', { n: 1 });

    const { body: { webhooks } } = await poll(sk1);
    const ids = webhooks.map(w => w.id);

    const res = await ack(sk2, ids);
    assert.equal(res.body.deleted, 0);

    const { body: { webhooks: ep1Remaining } } = await poll(sk1);
    assert.equal(ep1Remaining.length, 1);
  });
});

describe('Full end-to-end flow', () => {
  test('create → receive × 2 → poll → ack → empty', async () => {
    const { body: { secretKey } } = await createEndpoint('flow');

    await receiveWebhook('flow', { event: 'order.paid', id: 1 });
    await receiveWebhook('flow', { event: 'order.paid', id: 2 });

    const { body: { webhooks } } = await poll(secretKey);
    assert.equal(webhooks.length, 2);

    const ids = webhooks.map(w => w.id);
    const { body: { deleted } } = await ack(secretKey, ids);
    assert.equal(deleted, 2);

    const { body: { webhooks: empty } } = await poll(secretKey);
    assert.deepEqual(empty, []);
  });

  test('unacked webhook stays on server and is returned on next poll', async () => {
    const { body: { secretKey } } = await createEndpoint('retry');

    await receiveWebhook('retry', { n: 1 });

    // Poll without acking
    const poll1 = await poll(secretKey);
    assert.equal(poll1.body.webhooks.length, 1);

    // Poll again — still there
    const poll2 = await poll(secretKey);
    assert.equal(poll2.body.webhooks.length, 1);
    assert.equal(poll2.body.webhooks[0].id, poll1.body.webhooks[0].id);
  });
});
