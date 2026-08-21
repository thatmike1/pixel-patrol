# Pixel Patrol agent — Cloud Run service
#
# No browser here, unlike the crawler: this container only talks to Firestore,
# Pub/Sub, the Cloud Run Admin API and Vertex, so it runs on plain node:22-slim.
FROM node:22-slim AS builder

WORKDIR /app

# install dependencies first for layer caching
COPY package.json package-lock.json* ./
RUN npm ci --include=dev

# compile TypeScript
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# prune to production-only deps for the final image
RUN npm prune --omit=dev


# ---------------------------------------------------------------------------
# Runtime stage — only the compiled JS and its production dependencies
# ---------------------------------------------------------------------------
FROM node:22-slim

WORKDIR /app

# the node image ships a non-root 'node' user; use it rather than running as root
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./package.json

ENV NODE_ENV=production
ENV PORT=8080

USER node

EXPOSE 8080

CMD ["node", "dist/server.js"]
