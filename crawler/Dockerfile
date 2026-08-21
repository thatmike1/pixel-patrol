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

WORKDIR /app

# production dependencies only, resolved from the root lockfile. built in its
# own stage rather than pruned afterwards: `npm prune` reconciles every
# workspace, which would drag the agent's dependencies back in.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY crawler/package.json ./crawler/
RUN npm ci --omit=dev \
      --workspace pixel-patrol-crawler \
      --workspace @pixel-patrol/shared \
      --include-workspace-root


# ---------------------------------------------------------------------------
# Build stage — the same install with dev dependencies, plus the compilers
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.48.0-noble AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY crawler/package.json ./crawler/
RUN npm ci \
      --workspace pixel-patrol-crawler \
      --workspace @pixel-patrol/shared \
      --include-workspace-root

COPY shared ./shared
COPY crawler ./crawler

# shared first: the crawler compiles against its declaration files
RUN npm run build --workspace @pixel-patrol/shared \
 && npm run build --workspace pixel-patrol-crawler


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
COPY --from=builder --chown=crawler:crawler /app/package.json ./package.json
# node_modules/@pixel-patrol/shared is a symlink to ../../shared, so the package
# has to be here at the same relative path for the import to resolve
COPY --from=builder --chown=crawler:crawler /app/shared/package.json ./shared/package.json
COPY --from=builder --chown=crawler:crawler /app/shared/dist ./shared/dist
COPY --from=builder --chown=crawler:crawler /app/crawler/package.json ./crawler/package.json
COPY --from=builder --chown=crawler:crawler /app/crawler/dist ./crawler/dist
COPY --from=builder --chown=crawler:crawler /app/crawler/data ./crawler/data

# cap Node heap at 1.5 GB — leaves headroom inside the 2 GB container limit
ENV NODE_OPTIONS="--max-old-space-size=1536"
ENV NODE_ENV=production

USER crawler

# a Cloud Run Job — runs to completion and exits, no port to serve on
CMD ["node", "crawler/dist/job.js"]
