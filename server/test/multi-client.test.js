'use strict';

// Set env vars before any module is required
process.env.DB_PATH                    = ':memory:';
process.env.ADMIN_SECRET               = 'test-secret';
process.env.MULTI_CLIENT_ENABLED       = 'true';
process.env.MAX_DELIVERIES_PER_WEBHOOK = '2';
process.env.POLL_BATCH_SIZE            = '10';

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
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setup() {
  const res = await request(app)
    .post('/api/admin/create-webhook')
    .set('x-admin-secret', ADMIN)
    .send({ name: 'mc' });
  return res.body.secretKey;
}

function pollAs(secretKey, clientId) {
  return request(app)
    .post('/api/poll')
    .set('x-podkop-client-id', clientId)
    .send({ secret_key: secretKey });
}

function ackAs(secretKey, ids, clientId) {
  return request(app)
    .post('/api/ack')
    .set('x-podkop-client-id', clientId)
    .send({ secret_key: secretKey, ids });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Multi-client: poll isolation', () => {
  test('different clients can poll the same webhook independently', async () => {
    const sk = await setup();
    await request(app).post('/mc').send({ event: 'test' });

    const pollA = await pollAs(sk, 'client-A');
    const pollB = await pollAs(sk, 'client-B');

    assert.equal(pollA.body.webhooks.length, 1);
    assert.equal(pollB.body.webhooks.length, 1);
    assert.equal(pollA.body.webhooks[0].id, pollB.body.webhooks[0].id);
  });

  test('client does not see a webhook it already acked', async () => {
    const sk = await setup();
    await request(app).post('/mc').send({ n: 1 });

    const poll1 = await pollAs(sk, 'client-A');
    const ids = poll1.body.webhooks.map(w => w.id);

    await ackAs(sk, ids, 'client-A');

    const poll2 = await pollAs(sk, 'client-A');
    assert.deepEqual(poll2.body.webhooks, []);
  });

  test('unacked client still sees webhook after other client acks', async () => {
    const sk = await setup();
    await request(app).post('/mc').send({ n: 1 });

    const pollA = await pollAs(sk, 'client-A');
    await ackAs(sk, pollA.body.webhooks.map(w => w.id), 'client-A');

    // client-B has not acked — should still see it (MAX_DELIVERIES=2, only 1 acked)
    const pollB = await pollAs(sk, 'client-B');
    assert.equal(pollB.body.webhooks.length, 1);
  });
});

describe('Multi-client: ACK and deletion', () => {
  test('webhook deleted after MAX_DELIVERIES acks', async () => {
    const sk = await setup();
    await request(app).post('/mc').send({ n: 1 });

    const pollA = await pollAs(sk, 'client-A');
    const webhookId = pollA.body.webhooks[0].id;

    await ackAs(sk, [webhookId], 'client-A');
    // Webhook still exists (only 1 of 2 required deliveries)
    assert.ok(db.prepare('SELECT id FROM webhooks WHERE id = ?').get(webhookId));

    const ackB = await ackAs(sk, [webhookId], 'client-B');
    assert.equal(ackB.body.deleted, 1);

    // Webhook and its deliveries should be gone
    assert.equal(db.prepare('SELECT id FROM webhooks WHERE id = ?').get(webhookId), undefined);
    const deliveries = db.prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ?').all(webhookId);
    assert.equal(deliveries.length, 0);
  });

  test('ack is idempotent — duplicate acks from same client do not inflate delivery count', async () => {
    const sk = await setup();
    await request(app).post('/mc').send({ n: 1 });

    const pollA = await pollAs(sk, 'client-A');
    const ids = pollA.body.webhooks.map(w => w.id);

    // Ack twice from the same client
    await ackAs(sk, ids, 'client-A');
    await ackAs(sk, ids, 'client-A');

    // Delivery count must be 1, not 2
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM webhook_deliveries WHERE webhook_id = ?').get(ids[0]);
    assert.equal(row.cnt, 1);

    // Webhook should still exist (1 unique ack out of MAX_DELIVERIES=2)
    assert.ok(db.prepare('SELECT id FROM webhooks WHERE id = ?').get(ids[0]));
  });

  test('400 — ack requires X-Podkop-Client-Id header', async () => {
    const sk = await setup();
    await request(app).post('/mc').send({ n: 1 });

    const pollA = await pollAs(sk, 'client-A');
    const ids = pollA.body.webhooks.map(w => w.id);

    const res = await request(app)
      .post('/api/ack')
      .send({ secret_key: sk, ids }); // no X-Podkop-Client-Id

    assert.equal(res.status, 400);
  });
});

describe('Multi-client: stats show delivery counts', () => {
  test('deliveries count reflects active delivery records', async () => {
    const sk = await setup();
    await request(app).post('/mc').send({ n: 1 });

    const pollA = await pollAs(sk, 'client-A');
    await ackAs(sk, pollA.body.webhooks.map(w => w.id), 'client-A');

    // After 1 ack (MAX_DELIVERIES=2), webhook still exists with 1 delivery record
    const stats = await request(app).get('/api/admin/stats').set('x-admin-secret', ADMIN);
    assert.equal(stats.body.endpoints[0].pending, 1);
    assert.equal(stats.body.endpoints[0].deliveries, 1);
  });
});
