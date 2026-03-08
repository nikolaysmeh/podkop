FROM node:20-alpine AS base

WORKDIR /app

# No external dependencies — uses Node 20 built-in fetch
COPY package.json .
COPY . .

# ── Test stage ───────────────────────────────────────────────────────────────
FROM base AS test
CMD ["npm", "test"]

# ── Production stage ─────────────────────────────────────────────────────────
FROM base AS production
CMD ["node", "src/index.js"]
