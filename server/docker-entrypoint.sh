#!/bin/sh
set -e
chown -R node:node /data 2>/dev/null || true

if [ "${SSL_SUPPORTED}" = "true" ]; then
  ORIG_PORT=${SERVER_PORT:-3000}
  INTERNAL_PORT=$((ORIG_PORT + 1))

  cat > /tmp/Caddyfile <<EOF
${SSL_HOST}:${ORIG_PORT} {
  reverse_proxy localhost:${INTERNAL_PORT}
}
EOF

  # Start Caddy in background as root (needs port 80 for ACME HTTP-01 challenge)
  caddy run --config /tmp/Caddyfile &

  # Override SERVER_PORT so Node.js binds to the internal port
  export SERVER_PORT=${INTERNAL_PORT}
  exec su-exec node "$@"
else
  exec su-exec node "$@"
fi
