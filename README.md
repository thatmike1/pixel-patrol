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
