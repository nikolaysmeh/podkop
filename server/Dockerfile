FROM node:20-alpine AS base

# better-sqlite3 requires native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json .

# ── Test stage (includes devDependencies) ────────────────────────────────────
FROM base AS test
RUN npm install
COPY . .
CMD ["npm", "test"]

# ── Production stage ─────────────────────────────────────────────────────────
FROM base AS production
RUN npm install --omit=dev
COPY . .
CMD ["node", "src/index.js"]
