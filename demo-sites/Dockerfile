# Pixel Patrol demo sites — Cloud Run service
#
# BUILD CONTEXT IS THE REPO ROOT, not this directory:
#
#     docker build -f demo-sites/Dockerfile .
#
# not because this service imports anything from outside — it imports nothing at
# all — but because the TypeScript compiler comes from the root lockfile, and
# `gcloud builds submit demo-sites` would upload only demo-sites/ and find no
# node_modules to compile with. `infra/deploy-demo-sites.sh` submits the root
# with `--config` for that reason.
#
# there are no runtime dependencies. the final image is node:22-slim, the
# compiled server and the pages, and nothing else — which is the point: the
# fingerprints this service exists to produce should have nothing in them that
# the HTML did not ask for.
FROM node:22-slim AS builder
COPY --from=ghcr.io/pnpm/pnpm:12.15.0 /opt/pnpm /opt/pnpm
RUN ln -s /opt/pnpm/pnpm /usr/local/bin/pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json ./shared/
COPY crawler/package.json ./crawler/
COPY agent/package.json ./agent/
COPY demo-sites/package.json ./demo-sites/
RUN pnpm --filter pixel-patrol-demo-sites install --frozen-lockfile

COPY demo-sites ./demo-sites
RUN pnpm --filter pixel-patrol-demo-sites run build


# ---------------------------------------------------------------------------
# Runtime stage — the compiled server and the pages it serves
# ---------------------------------------------------------------------------
FROM node:22-slim

WORKDIR /app

COPY --from=builder --chown=node:node /app/demo-sites/package.json ./package.json
COPY --from=builder --chown=node:node /app/demo-sites/dist ./dist
COPY --from=builder --chown=node:node /app/demo-sites/public ./public

ENV NODE_ENV=production
ENV PORT=8080

USER node

EXPOSE 8080

CMD ["node", "dist/server.js"]
