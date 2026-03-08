FROM node:20-alpine AS base

WORKDIR /app

# No external dependencies — uses Node 20 built-in fetch
COPY package.json .
COPY src ./src

# ── Test stage ───────────────────────────────────────────────────────────────
FROM base AS test
COPY test ./test
USER node
CMD ["npm", "test"]

# ── Production stage ─────────────────────────────────────────────────────────
FROM base AS production
USER node
CMD ["node", "src/index.js"]
