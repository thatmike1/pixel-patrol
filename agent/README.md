# patrol-agent

The orchestrator. A Cloud Run service that fans scheduled ticks out into one crawl per
site, starts those crawls, and — when one finishes — runs the ADK drift analyst over the
fingerprint it produced.

Three of its four endpoints are Pub/Sub push targets. Nothing polls, nothing blocks, and
no request waits on a crawl.

```
Cloud Scheduler --> sweep-tick --> POST /trigger/tick
                                     |  one message per site
                                     v
                                  site-sweep --> POST /trigger/site-sweep
                                                   |  Cloud Run Job execution
                                                   v
                                              patrol-crawler
                                                   |  writes the fingerprint
                                                   v
                                                sweep-done --> POST /trigger/sweep-done
                                                                 |
                                                                 v
                                                        LlmAgent + 4 tools
                                                                 |
                                                                 v
                                                sites/{id}/decisions/{sweepId}
```

## The agent

One `LlmAgent` on `gemini-3.5-flash`, four `FunctionTool`s, one decision per sweep.

| tool | what it does |
| --- | --- |
| `get_sweep_context` | site, this sweep's fingerprint summary, the approved baseline and the previous sweep |
| `diff_against_baseline` | the deterministic set difference: hosts and cookies added and removed |
| `approve_baseline` | points the site at this sweep, for a site's first sweep only |
| `record_decision` | writes the verdict — `noop`, `drift` or `baseline-created` |

The split is deliberate. Everything that must be exactly right is a tool: reading
fingerprints, computing the difference, writing the verdict. The model decides what a
difference *means* — first sweep, harmless churn, or a tracker that appeared without
anyone deciding to add it — and how to say so to the person who has to answer for it. An
LLM asked to eyeball two host lists will occasionally miss one, and a missed marketing
pixel is the exact failure this product exists to prevent.

## Endpoints

| method | path | auth | returns |
| --- | --- | --- | --- |
| `GET` | `/healthz` | none | `200` |
| `POST` | `/trigger/tick` | push OIDC | `204`, after publishing one `site-sweep` per site |
| `POST` | `/trigger/site-sweep` | push OIDC | `204`, once the crawl execution is accepted |
| `POST` | `/trigger/sweep-done` | push OIDC | `204`, once a decision is recorded |
| `POST` | `/sites` | `x-admin-key` | `201` — body `{siteId, url, ownerEmail?}` |
| `POST` | `/sites/:siteId/sweep` | `x-admin-key` | `202 {siteId, sweepId}` — forces a re-check |
| `GET` | `/sites/:siteId/decisions?limit=10` | `x-admin-key` | `200 {siteId, decisions}` |

Any non-2xx on a trigger is a nack, so Pub/Sub retries and eventually dead-letters. That
is intentional: a `500` from `/trigger/sweep-done` means the fingerprint had not landed
yet or the model failed to record a decision, and both are worth another attempt. A `400`
means the message itself is malformed and will never succeed — it burns its five
attempts and parks in the DLQ.

## Auth

**Push triggers.** The service is deployed `--no-allow-unauthenticated`, so Cloud Run
already rejects unsigned callers at the edge. Each handler verifies the OIDC token again
with `google-auth-library`, against the exact endpoint URL as audience and
`patrol-agent@<project>.iam.gserviceaccount.com` as the expected caller. The edge check
proves the caller holds `run.invoker`; the app-level check proves it is *our* push
subscription with a token minted for *this* endpoint.

**Operator API.** A shared `x-admin-key` header, compared against `ADMIN_KEY` in constant
time. There is no human identity provider in this project; the operator API exists for the
demo and for forcing a re-check.

## Environment

| variable | required | notes |
| --- | --- | --- |
| `GOOGLE_CLOUD_PROJECT` | yes | Firestore, Pub/Sub, Cloud Run and Vertex all address this |
| `ADMIN_KEY` | yes | shared secret for `/sites` |
| `GOOGLE_GENAI_USE_ENTERPRISE` | yes, `true` | routes the ADK through Vertex and ADC rather than an API key |
| `GOOGLE_CLOUD_LOCATION` | no, `global` | Gemini 3.5 Flash is served only on `global` |
| `MODEL` | no, `gemini-3.5-flash` | |
| `REGION` | no, `europe-west1` | region of the crawler job and this service |
| `CRAWLER_JOB` | no, `patrol-crawler` | Cloud Run Job to execute |
| `SITE_SWEEP_TOPIC` | no, `site-sweep` | |
| `SELF_URL` | for triggers | this service's base URL, the expected OIDC audience |
| `PORT` | no, `8080` | Cloud Run injects it |
| `LOG_LEVEL` | no, `info` | |

`SELF_URL` cannot be required at boot: a Cloud Run URL only exists after the first deploy.
The service starts without it, logs a warning, and answers `503` on `/trigger/*` until it
is set. `infra/deploy-agent.sh` sets it in a second pass immediately after deploying.

## Local

```bash
npm install
gcloud auth application-default login   # ADC for Firestore, Pub/Sub and Vertex
cp .env.example .env                    # then export the variables you need
npm run typecheck && npm test
npm run dev
```

`npm test` covers the pure parts — the diff and the push-envelope decoder — and needs no
credentials or emulator. The rest is verified against the real project.

Pub/Sub push cannot reach `localhost`, so a local run is driven by hand:

```bash
curl -sS localhost:8080/sites -H "x-admin-key: $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"siteId":"smoke","url":"https://example.com"}'

# a push delivery, minus the OIDC token — only works with SELF_URL unset,
# where /trigger/* answers 503, so in practice test triggers against the
# deployed service with `gcloud auth print-identity-token`
```

## Deploy

```bash
PROJECT_ID=pixel-patrol-mp ./infra/deploy-agent.sh   # build, deploy, set SELF_URL, grant run.invoker
PROJECT_ID=pixel-patrol-mp ./infra/wire-pubsub.sh    # topics, push subscriptions, DLQ IAM, scheduler
```

Both are idempotent. `deploy-agent.sh` prints a generated `ADMIN_KEY` once on the first
run and reuses the deployed one afterwards, so a redeploy does not invalidate it.
