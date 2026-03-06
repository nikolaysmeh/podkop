FROM node:20-alpine

WORKDIR /app

# No external dependencies — uses Node 20 built-in fetch
COPY package.json .

COPY . .

CMD ["node", "src/index.js"]
