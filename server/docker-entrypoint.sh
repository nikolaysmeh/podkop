#!/bin/sh
set -e
chown -R node:node /data 2>/dev/null || true

if [ "${SSL_SUPPORTED}" = "true" ]; then
  ORIG_PORT=${SERVER_PORT:-3000}
  INTERNAL_PORT=$((ORIG_PORT + 1))

  cat > /tmp/Caddyfile <<EOF
{
  https_port ${ORIG_PORT}
}

${SSL_HOST} {
  tls {
    issuer acme {
      disable_http_challenge
    }
  }
  reverse_proxy localhost:${INTERNAL_PORT}
}
EOF

  # Start Caddy in background as root (TLS-ALPN-01 challenge runs on SERVER_PORT)
  caddy run --config /tmp/Caddyfile &

  # Override SERVER_PORT so Node.js binds to the internal port
  export SERVER_PORT=${INTERNAL_PORT}
  exec su-exec node "$@"
else
  exec su-exec node "$@"
fi
