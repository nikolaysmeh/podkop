#!/usr/bin/env node
'use strict';

/**
 * CLI for managing webhook endpoints on the server.
 *
 * Usage (inside the container):
 *   node src/cli.js create-webhook <name>
 *   node src/cli.js create-webhook <name> <username> <password>
 *   node src/cli.js set-credentials <name> <username> <password>
 *   node src/cli.js disable-auth <name>
 *   node src/cli.js purge-webhooks <name>
 *   node src/cli.js list-webhooks
 *   node src/cli.js stats
 *   node src/cli.js delete-webhook <name>
 *   node src/cli.js delete-message <name> <id>
 *
 * Via docker-compose:
 *   docker-compose exec server node src/cli.js create-webhook mywebhook
 *   docker-compose exec server node src/cli.js set-credentials mywebhook alice newpass
 *   docker-compose exec server node src/cli.js disable-auth mywebhook
 *   docker-compose exec server node src/cli.js purge-webhooks mywebhook
 *   docker-compose exec server node src/cli.js list-webhooks
 *   docker-compose exec server node src/cli.js stats
 *   docker-compose exec server node src/cli.js delete-webhook mywebhook
 *   docker-compose exec server node src/cli.js delete-message mywebhook 42
 */

require('dotenv').config();

const http = require('http');

const SERVER_URL   = `http://${process.env.CLI_SERVER_HOST || 'localhost'}:${process.env.SERVER_PORT || 3000}`;
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function request(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const parsed  = new URL(url);

    const req = http.request(
      {
        hostname: parsed.hostname,
        port:     parsed.port || 80,
        path:     parsed.pathname,
        method,
        headers:  {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      }
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const postJSON   = (url, body, headers) => request('POST',   url, body, headers);
const patchJSON  = (url, body, headers) => request('PATCH',  url, body, headers);
const getJSON    = (url, headers)       => request('GET',    url, undefined, headers);
const deleteJSON = (url, headers)       => request('DELETE', url, undefined, headers);

// ── Commands ──────────────────────────────────────────────────────────────────

async function createWebhook(name, username, password) {
  const result = await postJSON(
    `${SERVER_URL}/api/admin/create-webhook`,
    { name, username, password },
    { 'X-Admin-Secret': ADMIN_SECRET }
  );

  if (result.status === 201) {
    const { webhookUrl, secretKey, auth } = result.body;
    console.log(`Webhook "${name}" created.`);
    console.log(`  URL        : ${SERVER_URL}${webhookUrl}`);
    console.log(`  Secret key : ${secretKey}`);
    console.log(`  Auth       : ${auth === 'basic' ? `basic (user: ${username})` : 'none'}`);
  } else {
    console.error(`Error ${result.status}: ${JSON.stringify(result.body)}`);
    process.exit(1);
  }
}

async function listWebhooks() {
  const result = await getJSON(
    `${SERVER_URL}/api/admin/webhooks`,
    { 'X-Admin-Secret': ADMIN_SECRET }
  );

  if (result.status === 200) {
    const { endpoints } = result.body;
    if (endpoints.length === 0) {
      console.log('No webhooks configured.');
      return;
    }
    for (const ep of endpoints) {
      console.log(`/${ep.name}`);
      console.log(`  Secret key : ${ep.secret_key}`);
      if (ep.username) {
        console.log(`  Auth       : basic`);
        console.log(`  Username   : ${ep.username}`);
      } else {
        console.log(`  Auth       : none`);
      }
      console.log(`  Created    : ${ep.created_at}`);
    }
  } else {
    console.error(`Error ${result.status}: ${JSON.stringify(result.body)}`);
    process.exit(1);
  }
}

async function stats() {
  const result = await getJSON(
    `${SERVER_URL}/api/admin/stats`,
    { 'X-Admin-Secret': ADMIN_SECRET }
  );

  if (result.status === 200) {
    const { total_pending, endpoints } = result.body;
    if (endpoints.length === 0) {
      console.log('No webhooks configured.');
      return;
    }
    for (const ep of endpoints) {
      console.log(`/${ep.name}`);
      console.log(`  Pending    : ${ep.pending}`);
      console.log(`  Deliveries : ${ep.deliveries}`);
    }
    console.log('');
    console.log(`Total pending: ${total_pending}`);
  } else {
    console.error(`Error ${result.status}: ${JSON.stringify(result.body)}`);
    process.exit(1);
  }
}

async function setCredentials(name, username, password) {
  const result = await patchJSON(
    `${SERVER_URL}/api/admin/webhooks/${encodeURIComponent(name)}/credentials`,
    { username, password },
    { 'X-Admin-Secret': ADMIN_SECRET }
  );

  if (result.status === 200) {
    console.log(`Credentials updated for "${name}". Auth: ${result.body.auth}`);
  } else {
    console.error(`Error ${result.status}: ${JSON.stringify(result.body)}`);
    process.exit(1);
  }
}

async function disableAuth(name) {
  const result = await patchJSON(
    `${SERVER_URL}/api/admin/webhooks/${encodeURIComponent(name)}/credentials`,
    {},
    { 'X-Admin-Secret': ADMIN_SECRET }
  );

  if (result.status === 200) {
    console.log(`Auth disabled for "${name}".`);
  } else {
    console.error(`Error ${result.status}: ${JSON.stringify(result.body)}`);
    process.exit(1);
  }
}

async function purgeWebhooks(name) {
  const result = await postJSON(
    `${SERVER_URL}/api/admin/webhooks/${encodeURIComponent(name)}/purge`,
    {},
    { 'X-Admin-Secret': ADMIN_SECRET }
  );

  if (result.status === 200) {
    console.log(`Purged ${result.body.deleted} webhook(s) from "${name}".`);
  } else {
    console.error(`Error ${result.status}: ${JSON.stringify(result.body)}`);
    process.exit(1);
  }
}

async function deleteMessage(name, id) {
  const result = await deleteJSON(
    `${SERVER_URL}/api/admin/webhooks/${encodeURIComponent(name)}/messages/${encodeURIComponent(id)}`,
    { 'X-Admin-Secret': ADMIN_SECRET }
  );

  if (result.status === 200) {
    console.log(`Message ${id} deleted from "${name}".`);
  } else {
    console.error(`Error ${result.status}: ${JSON.stringify(result.body)}`);
    process.exit(1);
  }
}

async function deleteWebhook(name) {
  const result = await deleteJSON(
    `${SERVER_URL}/api/admin/webhooks/${encodeURIComponent(name)}`,
    { 'X-Admin-Secret': ADMIN_SECRET }
  );

  if (result.status === 200) {
    console.log(`Webhook "${name}" deleted.`);
  } else {
    console.error(`Error ${result.status}: ${JSON.stringify(result.body)}`);
    process.exit(1);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [, , command, ...args] = process.argv;

  if (command === 'create-webhook') {
    const [name, username, password] = args;
    if (!name) {
      console.error('Usage: node src/cli.js create-webhook <name> [<username> <password>]');
      process.exit(1);
    }
    if ((username && !password) || (!username && password)) {
      console.error('Provide both username and password, or neither.');
      process.exit(1);
    }
    try {
      await createWebhook(name, username, password);
    } catch (err) {
      console.error(`Cannot reach server at ${SERVER_URL}: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (command === 'set-credentials') {
    const [name, username, password] = args;
    if (!name || !username || !password) {
      console.error('Usage: node src/cli.js set-credentials <name> <username> <password>');
      process.exit(1);
    }
    try {
      await setCredentials(name, username, password);
    } catch (err) {
      console.error(`Cannot reach server at ${SERVER_URL}: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (command === 'disable-auth') {
    const [name] = args;
    if (!name) {
      console.error('Usage: node src/cli.js disable-auth <name>');
      process.exit(1);
    }
    try {
      await disableAuth(name);
    } catch (err) {
      console.error(`Cannot reach server at ${SERVER_URL}: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (command === 'list-webhooks') {
    try {
      await listWebhooks();
    } catch (err) {
      console.error(`Cannot reach server at ${SERVER_URL}: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (command === 'stats') {
    try {
      await stats();
    } catch (err) {
      console.error(`Cannot reach server at ${SERVER_URL}: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (command === 'purge-webhooks') {
    const [name] = args;
    if (!name) {
      console.error('Usage: node src/cli.js purge-webhooks <name>');
      process.exit(1);
    }
    try {
      await purgeWebhooks(name);
    } catch (err) {
      console.error(`Cannot reach server at ${SERVER_URL}: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (command === 'delete-message') {
    const [name, id] = args;
    if (!name || !id) {
      console.error('Usage: node src/cli.js delete-message <name> <id>');
      process.exit(1);
    }
    try {
      await deleteMessage(name, id);
    } catch (err) {
      console.error(`Cannot reach server at ${SERVER_URL}: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (command === 'delete-webhook') {
    const [name] = args;
    if (!name) {
      console.error('Usage: node src/cli.js delete-webhook <name>');
      process.exit(1);
    }
    try {
      await deleteWebhook(name);
    } catch (err) {
      console.error(`Cannot reach server at ${SERVER_URL}: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  console.log('Commands:');
  console.log('  node src/cli.js create-webhook <name> [<username> <password>]');
  console.log('  node src/cli.js set-credentials <name> <username> <password>');
  console.log('  node src/cli.js disable-auth <name>');
  console.log('  node src/cli.js purge-webhooks <name>');
  console.log('  node src/cli.js list-webhooks');
  console.log('  node src/cli.js stats');
  console.log('  node src/cli.js delete-webhook <name>');
  console.log('  node src/cli.js delete-message <name> <id>');
}

main();
