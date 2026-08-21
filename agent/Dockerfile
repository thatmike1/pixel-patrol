# Pixel Patrol agent — Cloud Run service
#
# No browser here, unlike the crawler: this container only talks to Firestore,
# Pub/Sub, the Cloud Run Admin API and Vertex, so it runs on plain node:22-slim.
#
# BUILD CONTEXT IS THE REPO ROOT, not this directory:
#
#     docker build -f agent/Dockerfile .
#
# because the agent imports @pixel-patrol/shared, which lives outside this
# folder. `infra/deploy-agent.sh` submits the root with `--config` for the same
# reason. The npm workspace install is filtered to this service and the shared
# package, so the crawler's Playwright never lands in this image.
FROM node:22-slim AS deps

WORKDIR /app

# production dependencies only, resolved from the root lockfile. built in its
# own stage rather than pruned afterwards: `npm prune` reconciles every
# workspace, which would drag the crawler's dependencies back in.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY agent/package.json ./agent/
RUN npm ci --omit=dev \
      --workspace pixel-patrol-agent \
      --workspace @pixel-patrol/shared \
      --include-workspace-root


# ---------------------------------------------------------------------------
# Build stage — the same install with dev dependencies, plus the compilers
# ---------------------------------------------------------------------------
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY agent/package.json ./agent/
RUN npm ci \
      --workspace pixel-patrol-agent \
      --workspace @pixel-patrol/shared \
      --include-workspace-root

COPY shared ./shared
COPY agent ./agent

# shared first: the agent compiles against its declaration files
RUN npm run build --workspace @pixel-patrol/shared \
 && npm run build --workspace pixel-patrol-agent


# ---------------------------------------------------------------------------
# Runtime stage — only the compiled JS and its production dependencies
# ---------------------------------------------------------------------------
FROM node:22-slim

WORKDIR /app

# the node image ships a non-root 'node' user; use it rather than running as root
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
# node_modules/@pixel-patrol/shared is a symlink to ../../shared, so the package
# has to be here at the same relative path for the import to resolve
COPY --from=builder --chown=node:node /app/shared/package.json ./shared/package.json
COPY --from=builder --chown=node:node /app/shared/dist ./shared/dist
COPY --from=builder --chown=node:node /app/agent/package.json ./agent/package.json
COPY --from=builder --chown=node:node /app/agent/dist ./agent/dist

ENV NODE_ENV=production
ENV PORT=8080

USER node

EXPOSE 8080

CMD ["node", "agent/dist/server.js"]
