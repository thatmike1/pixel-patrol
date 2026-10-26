# Pixel Patrol crawler — Cloud Run Job
#
# Base image: Playwright's official Ubuntu Noble image with Chromium + all system deps
# already installed. Using the pinned Playwright version keeps the browser and the npm
# package in lockstep (avoids "Executable doesn't exist" mismatches).
#
# BUILD CONTEXT IS THE REPO ROOT, not this directory:
#
#     docker build -f crawler/Dockerfile .
#
# because the crawler imports @pixel-patrol/shared, which lives outside this
# folder. `infra/deploy-crawler.sh` submits the root with `--config` for the
# same reason.
FROM mcr.microsoft.com/playwright:v1.48.0-noble AS deps
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
RUN pnpm --filter pixel-patrol-crawler... install --frozen-lockfile --prod


# ---------------------------------------------------------------------------
# Build stage — the same install with dev dependencies, plus the compilers
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.48.0-noble AS builder
COPY --from=ghcr.io/pnpm/pnpm:12.15.0 /opt/pnpm /opt/pnpm
RUN ln -s /opt/pnpm/pnpm /usr/local/bin/pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json ./shared/
COPY crawler/package.json ./crawler/
COPY agent/package.json ./agent/
COPY demo-sites/package.json ./demo-sites/
RUN pnpm --filter pixel-patrol-crawler... install --frozen-lockfile

COPY shared ./shared
COPY crawler ./crawler

# shared first: the crawler compiles against its declaration files
RUN pnpm --filter @pixel-patrol/shared run build \
 && pnpm --filter pixel-patrol-crawler run build


# ---------------------------------------------------------------------------
# Runtime stage — slim image with only what's needed to run the compiled JS
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.48.0-noble

WORKDIR /app

# run as non-root user — the playwright image already ships with a 'pwuser'
# but we create our own for clarity and least privilege
RUN groupadd -r crawler && useradd -r -g crawler -m -d /home/crawler crawler

# copy only what's needed to run
COPY --from=deps --chown=crawler:crawler /app/node_modules ./node_modules
COPY --from=deps --chown=crawler:crawler /app/crawler/node_modules ./crawler/node_modules
COPY --from=builder --chown=crawler:crawler /app/package.json ./package.json
# crawler/node_modules/@pixel-patrol/shared links to ../../../shared, so the package
# has to be here at the same relative path for the import to resolve
COPY --from=builder --chown=crawler:crawler /app/shared/package.json ./shared/package.json
COPY --from=builder --chown=crawler:crawler /app/shared/dist ./shared/dist
# the vendor tables are read at runtime from ../data relative to the compiled
# lookups, so they ship next to dist rather than being bundled into it
COPY --from=builder --chown=crawler:crawler /app/shared/data ./shared/data
COPY --from=builder --chown=crawler:crawler /app/crawler/package.json ./crawler/package.json
COPY --from=builder --chown=crawler:crawler /app/crawler/dist ./crawler/dist

# cap Node heap at 1.5 GB — leaves headroom inside the 2 GB container limit
ENV NODE_OPTIONS="--max-old-space-size=1536"
ENV NODE_ENV=production

USER crawler

# a Cloud Run Job — runs to completion and exits, no port to serve on
CMD ["node", "crawler/dist/job.js"]
