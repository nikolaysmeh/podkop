#!/usr/bin/env node
'use strict';

/**
 * CLI for managing webhook endpoints on the server.
 *
 * Usage (inside the container):
 *   node src/cli.js create-webhook <name>
 *   node src/cli.js create-webhook <name> <username> <password>
 *
 * Via docker-compose:
 *   docker-compose exec server node src/cli.js create-webhook mywebhook
 *   docker-compose exec server node src/cli.js create-webhook mywebhook alice secret123
 */

require('dotenv').config();

const http = require('http');

const SERVER_URL   = process.env.CLI_SERVER_URL
                  || `http://localhost:${process.env.SERVER_PORT || 3000}`;
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

// ── HTTP helper ───────────────────────────────────────────────────────────────

function postJSON(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed  = new URL(url);

    const req = http.request(
      {
        hostname: parsed.hostname,
        port:     parsed.port || 80,
        path:     parsed.pathname,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
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
    req.write(payload);
    req.end();
  });
}

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
    console.log('');
    console.log(`Set in client .env:`);
    console.log(`  CLIENT_POLL_SECRET_KEY=${secretKey}`);
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

  console.log('Commands:');
  console.log('  node src/cli.js create-webhook <name>');
  console.log('  node src/cli.js create-webhook <name> <username> <password>');
}

main();
