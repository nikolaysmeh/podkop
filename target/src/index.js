'use strict';

/**
 * Target service — demo destination for forwarded webhooks.
 *
 * Receives POST /receive requests from the client and logs them.
 * In production you would replace this with your real application endpoint.
 */

const express = require('express');

const app  = express();
const PORT = parseInt(process.env.TARGET_PORT) || 4000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.text({ type: '*/*', limit: '10mb' }));

app.post('/receive', (req, res) => {
  const id         = req.headers['x-webhook-id']      || '?';
  const origMethod = req.headers['x-original-method'] || '?';
  const receivedAt = req.headers['x-received-at']     || '?';

  const body =
    typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body, null, 2);

  console.log(`\n┌─ Webhook #${id}`);
  console.log(`│  Original method : ${origMethod}`);
  console.log(`│  Originally at   : ${receivedAt}`);
  console.log(`│  Forwarded at    : ${new Date().toISOString()}`);
  console.log(`│  Body:`);
  body.split('\n').forEach((line) => console.log(`│    ${line}`));
  console.log(`└${'─'.repeat(40)}`);

  res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Target server listening on port ${PORT}`);
});
