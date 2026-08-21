# Pixel Patrol crawler — Cloud Run Job
#
# Base image: Playwright's official Ubuntu Noble image with Chromium + all system deps
# already installed. Using the pinned Playwright version keeps the browser and the npm
# package in lockstep (avoids "Executable doesn't exist" mismatches).
FROM mcr.microsoft.com/playwright:v1.48.0-noble AS builder

WORKDIR /app

# install dependencies first for layer caching
COPY package.json package-lock.json* ./
RUN npm install --include=dev

# compile TypeScript
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY data ./data
RUN npm run build

# prune to production-only deps for the final image
RUN npm prune --omit=dev


# ---------------------------------------------------------------------------
# Runtime stage — slim image with only what's needed to run the compiled JS
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.48.0-noble

WORKDIR /app

# run as non-root user — the playwright image already ships with a 'pwuser'
# but we create our own for clarity and least privilege
RUN groupadd -r crawler && useradd -r -g crawler -m -d /home/crawler crawler

# copy only what's needed to run
COPY --from=builder --chown=crawler:crawler /app/node_modules ./node_modules
COPY --from=builder --chown=crawler:crawler /app/dist ./dist
COPY --from=builder --chown=crawler:crawler /app/package.json ./package.json
COPY --from=builder --chown=crawler:crawler /app/data ./data

# cap Node heap at 1.5 GB — leaves headroom inside the 2 GB container limit
ENV NODE_OPTIONS="--max-old-space-size=1536"
ENV NODE_ENV=production

USER crawler

# a Cloud Run Job — runs to completion and exits, no port to serve on
CMD ["node", "dist/job.js"]
