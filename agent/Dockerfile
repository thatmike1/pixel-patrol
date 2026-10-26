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
# reason. The pnpm workspace install is filtered to this service and the shared
# package, so the crawler's Playwright never lands in this image.
FROM node:22-slim AS deps
COPY --from=ghcr.io/pnpm/pnpm:12.15.0 /opt/pnpm /opt/pnpm
RUN ln -s /opt/pnpm/pnpm /usr/local/bin/pnpm

WORKDIR /app

# production dependencies only, resolved from the root lockfile. built in its
# own stage with a filtered install, so unrelated workspace dependencies stay out.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json ./shared/
COPY crawler/package.json ./crawler/
COPY agent/package.json ./agent/
COPY demo-sites/package.json ./demo-sites/
RUN pnpm --filter pixel-patrol-agent... install --frozen-lockfile --prod


# ---------------------------------------------------------------------------
# Build stage — the same install with dev dependencies, plus the compilers
# ---------------------------------------------------------------------------
FROM node:22-slim AS builder
COPY --from=ghcr.io/pnpm/pnpm:12.15.0 /opt/pnpm /opt/pnpm
RUN ln -s /opt/pnpm/pnpm /usr/local/bin/pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json ./shared/
COPY crawler/package.json ./crawler/
COPY agent/package.json ./agent/
COPY demo-sites/package.json ./demo-sites/
RUN pnpm --filter pixel-patrol-agent... install --frozen-lockfile

COPY shared ./shared
COPY agent ./agent

# shared first: the agent compiles against its declaration files
RUN pnpm --filter @pixel-patrol/shared run build \
 && pnpm --filter pixel-patrol-agent run build


# ---------------------------------------------------------------------------
# Runtime stage — only the compiled JS and its production dependencies
# ---------------------------------------------------------------------------
FROM node:22-slim

WORKDIR /app

# the node image ships a non-root 'node' user; use it rather than running as root
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/agent/node_modules ./agent/node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
# agent/node_modules/@pixel-patrol/shared links to ../../../shared, so the package
# has to be here at the same relative path for the import to resolve
COPY --from=builder --chown=node:node /app/shared/package.json ./shared/package.json
COPY --from=builder --chown=node:node /app/shared/dist ./shared/dist
# the vendor tables are read at runtime from ../data relative to the compiled
# lookups, so they ship next to dist rather than being bundled into it
COPY --from=builder --chown=node:node /app/shared/data ./shared/data
COPY --from=builder --chown=node:node /app/agent/package.json ./agent/package.json
COPY --from=builder --chown=node:node /app/agent/dist ./agent/dist

ENV NODE_ENV=production
ENV PORT=8080

USER node

EXPOSE 8080

CMD ["node", "agent/dist/server.js"]
