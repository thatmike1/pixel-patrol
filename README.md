# Pixel Patrol

GDPR drift watchdog. A new tracker appears on a site you are responsible for; the agent
fingerprints the site, diffs it against the approved baseline, classifies the tracker,
rewrites the Czech cookie policy and RoPA row as a redline, opens a ticket and emails
the owner. No human step inside the run.

Built for the All Things Agentic hackathon (Taskmaster track) on Gemini 3.5 Flash,
Google ADK and Cloud Run.

## Spin up

1. `gcloud auth login` as an account that owns a billing account.
2. `PROJECT_ID=<id> BILLING_ACCOUNT=<id> ./infra/provision.sh`
3. `gcloud auth application-default login` for local development.

`infra/provision.sh` is idempotent and ends with a live Gemini 3.5 Flash call, so a
clean exit means the project is ready. Gemini 3.5 Flash is only served on the
`global` Vertex location; everything else lives in `europe-west1`.

## What it is pointed at

Five demo pages this project owns and serves itself, one per class of drift — a
tracker-free page that gains a Meta Pixel, a page whose approved tracker is
removed, one that gains a host the vendor tables have never heard of, one that
gains a cookie without gaining a domain, and one that loads four real trackers
and never changes. Drift is induced by editing the HTML and redeploying, so the
demo's claim is the literal sequence of events.

- `demo-sites/README.md` — the pages and the switches
- `docs/demo-runbook.md` — the sequence, copy-paste
- `docs/stability-tuning.md` — what N=5 / M=3 do against real ad-tech churn
