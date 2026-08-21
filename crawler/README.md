# crawler

The Pixel Patrol crawler. One Cloud Run Job execution = one sweep of one site.

It drives headless Chromium over a site, records every third-party host the pages
contact and every cookie they set, and writes that as a **fingerprint**: a
deterministic, diffable snapshot. The product is the diff between two of these,
so determinism is the contract, not a nicety.

```
env -> crawl -> fingerprint -> Firestore -> Pub/Sub -> exit
```

The crawler, classifier, consent bypass, cookie/tracker databases and the SSRF
URL validator are lifted from the `gdpr-toolkit` scanner. Only the logger type
changed (Fastify's logger became pino's). The SSRF validator is a security
boundary; its parity block must not be edited without mirroring the sibling copy
in that repo.

## What a fingerprint contains

Stored at `sites/{siteId}/fingerprints/{sweepId}`:

| field | notes |
| --- | --- |
| `siteId`, `sweepId`, `siteUrl`, `scannedAt` | sweep identity |
| `pagesScanned` | pages actually visited, which can be fewer than requested |
| `hosts[]` | third-party hosts, deduped and sorted: `host`, `vendor`, `category`, `type` |
| `cookies[]` | sorted by name, domain, path: `name`, `domain`, `path`, `category`, `isFirstParty`, `durationSeconds` |
| `preConsentNonNecessaryCount` | non-necessary cookies set before any consent was given |
| `complianceScore` | 0-100, scanner-observable signals only |
| `hash` | sha256 over host names plus cookie name+domain, and nothing else |

**Cookie values are never captured or stored.** Only cookie identity and
metadata. The hash deliberately ignores durations, categories and ordering, so a
cookie whose max-age ticks down between sweeps does not read as drift.

The job also merges `{url, lastSweepId, lastSweepAt}` into `sites/{siteId}` and
publishes one message to the sweep-done topic:

```json
{"siteId":"...","sweepId":"...","status":"ok","hostsCount":35,"cookiesCount":17,"hash":"..."}
```

On failure it publishes `{"siteId":"...","sweepId":"...","status":"failed","error":"..."}`
and exits 1. It always publishes exactly one message, so nothing downstream
waits forever on a sweep that died.

## Environment

Required: `SITE_ID`, `SITE_URL`, `SWEEP_ID`, `GOOGLE_CLOUD_PROJECT`.
Optional: `PAGES_TO_SCAN` (default 5), `SWEEP_DONE_TOPIC` (default `sweep-done`),
`LOG_LEVEL` (default `info`).

See `.env.example`. Auth is Application Default Credentials throughout, no key
files.

## Running locally

```bash
npm install
npx playwright install chromium     # only if you have no Playwright browsers yet
gcloud auth application-default login

GOOGLE_CLOUD_PROJECT=pixel-patrol-mp \
SITE_ID=test \
SITE_URL=https://example.com \
SWEEP_ID=local-1 \
npm run dev
```

This writes to real Firestore and publishes to the real topic. Use a throwaway
`SITE_ID` so you do not overwrite a tracked site's history.

Other scripts: `npm run typecheck`, `npm test`, `npm run build`, `npm start`.

## Building the image

```bash
docker build -t pixel-patrol-crawler .
```

Base image is `mcr.microsoft.com/playwright:v1.48.0-noble`, matching the pinned
Playwright version so the browser and the npm package never drift apart. Runs as
a non-root user with the Node heap capped at 1.5 GB, which assumes a 2 GB
container. Deployment is owned outside this directory.

## Limits worth knowing

- The crawl gets a hard 8 minute budget. When it expires the abort signal fires
  and the crawler stops between pages, so the fingerprint reflects the pages it
  reached rather than failing outright.
- Sites that shard third-party requests across numbered hostnames (`d15-a.sdn.cz`,
  `d21-a.sdn.cz`, and so on) produce a different host set on every sweep, which
  means a different hash and false drift. Normalizing hosts to their registrable
  domain would fix it and is not implemented.
- Google Consent Mode v2 state is not captured. A site can load gtag with denied
  consent defaults and look identical to one that loads it with consent granted.
