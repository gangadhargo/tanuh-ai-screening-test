# Build context is the app/ directory (see compose.yaml).
FROM node:24-bookworm-slim
WORKDIR /app

COPY package.json package-lock.json ./
COPY api/package.json api/
COPY engine/package.json engine/
COPY web/package.json web/
RUN npm ci --workspace api --include-workspace-root

COPY engine engine
COPY api api

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "api/src/server.js"]
