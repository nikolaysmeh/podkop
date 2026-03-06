# Webhook Relay

Three services that receive webhooks, buffer them, and forward them to your application.

```
External Service
      │  POST /{name}  (optional Basic Auth)
      ▼
   [server]  ──── SQLite (./data/webhooks.db)
      │  POST /api/poll  { secret_key }
      ▼
   [client]
      │  POST /receive
      ▼
   [target]  (your app)
```

## Services

| Service | Role |
|---------|------|
| **server** | Receives webhooks, stores them in SQLite, exposes a polling API |
| **client** | Polls the server, forwards webhooks to the target, sends ACK on success |
| **target** | Demo destination that logs received webhooks (replace with your app) |

## Quick Start

```bash
# 1. Edit .env (set SERVER_PORT, ADMIN_SECRET, forward destination)

# 2. Start everything
docker-compose up --build -d

# 3. Create a webhook endpoint
docker-compose exec server node src/cli.js create-webhook mywebhook
```

Output:
```
Webhook "mywebhook" created.
  URL        : http://localhost:3033/mywebhook
  Secret key : a3f9c2d1e8b5...
  Auth       : none

Set in client .env:
  CLIENT_POLL_SECRET_KEY=a3f9c2d1e8b5...
```

```bash
# 4. Paste the secret key into .env, then restart the client
docker-compose up -d client
```

## Creating Webhook Endpoints

```bash
# Open endpoint — anyone can POST to it
docker-compose exec server node src/cli.js create-webhook <name>

# Protected endpoint — requires Basic Auth on incoming webhooks
docker-compose exec server node src/cli.js create-webhook <name> <username> <password>
```

- Name may only contain letters, digits, `-` and `_`
- Reserved names: `api`, `admin`, `health`
- Each endpoint gets a unique `secret_key` used for polling

## Sending a Webhook

```bash
# Open endpoint
curl -X POST http://localhost:3033/mywebhook \
  -H "Content-Type: application/json" \
  -d '{"event": "order.paid", "id": 42}'

# Protected endpoint
curl -u alice:secret123 -X POST http://localhost:3033/secured \
  -H "Content-Type: application/json" \
  -d '{"event": "order.paid", "id": 42}'
```

Requests to unknown endpoint names return `404`.
Requests to protected endpoints without valid credentials return `401`.

## Polling API (used by client internally)

**Get webhooks (batched):**
```
POST /api/poll
{ "secret_key": "<key>" }
```

**Acknowledge delivery (deletes from server):**
```
POST /api/ack
{ "secret_key": "<key>", "ids": [1, 2, 3] }
```

Webhooks are deleted only after a successful ACK. If the client fails to forward a webhook, it stays on the server and is retried on the next poll cycle.

## Key Configuration (.env)

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_PORT` | `3000` | Server HTTP port |
| `DB_PATH` | `/data/webhooks.db` | SQLite file path inside container |
| `ADMIN_SECRET` | — | Protects the create-webhook endpoint — **change this** |
| `POLL_BATCH_SIZE` | `10` | Webhooks returned per poll request |
| `CLEANUP_INTERVAL_MINUTES` | `5` | How often the cleanup job runs |
| `WEBHOOK_MAX_AGE_MINUTES` | `60` | Delete undelivered webhooks older than this |
| `CLIENT_POLL_SECRET_KEY` | — | Secret key from `create-webhook` output |
| `CLIENT_POLL_INTERVAL_SECONDS` | `10` | How often the client polls |
| `CLIENT_FORWARD_HOST/PORT/PATH` | `target/4000/receive` | Where to forward webhooks |

## Replacing the Target

Point `CLIENT_FORWARD_*` at your own service:

```env
CLIENT_FORWARD_HOST=myapp.internal
CLIENT_FORWARD_PORT=8080
CLIENT_FORWARD_PATH=/webhooks/inbound
```

Or remove the `target` service from `docker-compose.yml` entirely.
