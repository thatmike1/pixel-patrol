# Pre-existing code disclosure

The All Things Agentic rules require projects to be newly created during the submission
period and any pre-existing code incorporated to be disclosed. This file is the running
list; it is copied into the Devpost description at submission.

Everything under `agent/`, `infra/`, and the orchestration, diffing, baseline, redline,
ticketing and notification logic is new for this hackathon (21 to 31 August 2026).

## Lifted from gdpr-toolkit (Mike's own unreleased project, 2026)

Copied into `crawler/src/` with only import and logger-type changes:

- `crawler.ts` Playwright BFS crawler: pre-consent and post-consent cookie collection, third-party request capture
- `classifier.ts` tiered cookie and tracker classifier (known DB, regex heuristics)
- `tracker-db.ts`, `cookie-db.ts` lookups over `data/known-trackers.json` and `data/known-cookies.json`
- `consent-bypass.ts` clicks through common consent banners so post-consent state can be observed
- `url-validator.ts` SSRF validation for crawl targets (DNS resolution, private range and IPv4-mapped IPv6 checks)
- `types.ts` shared scan result types
- `Dockerfile` base (Playwright 1.48 Noble image, non-root user, heap cap)

New in `crawler/`: the Cloud Run Job entry (`job.ts`), the normalized fingerprint and its
hash (`fingerprint.ts`), and the Firestore and Pub/Sub sinks (`sinks.ts`).

## Third-party
Standard open-source dependencies as listed in each `package.json` (Playwright, pino,
Google Cloud client libraries, `@google/adk`, zod, TypeScript).
