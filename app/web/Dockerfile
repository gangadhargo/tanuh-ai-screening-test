# Build context is the app/ directory (see compose.yaml).
FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY api/package.json api/
COPY web/package.json web/
COPY engine/package.json engine/
RUN npm ci --workspace web --include-workspace-root

COPY engine engine
COPY web web
RUN npm run build -w web

FROM nginx:alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
