FROM node:20-alpine

# better-sqlite3 requires native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY . .

CMD ["node", "src/index.js"]
