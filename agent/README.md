# patrol-agent

The orchestrator. A Cloud Run service that fans scheduled ticks out into one crawl per
site, starts those crawls, and — when one finishes — runs the ADK drift analyst over the
fingerprint it produced.

Three of its endpoints are Pub/Sub push targets. Nothing polls, nothing blocks, and
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
                                                     drift analyst + 5 tools
                                                                 |
                                                                 v
                                                sites/{id}/decisions/{sweepId}
                                                                 |  only on drift
                                                                 v
                                                      compliance scribe + 2 tools
                                                                 |
                                                                 v
                                                sites/{id}/redlines/{sweepId}
                                                                 |
                                                                 v
                                                    notifier (plain code)
                                                        |             |
                                                   GitHub issue   owner email
                                                        |             |
                                                        v             v
                                              sites/{id}/notifications/{sweepId}
```

## The analyst

One `LlmAgent` on `gemini-3.5-flash`, five `FunctionTool`s, one decision per sweep.

| tool | what it does |
| --- | --- |
| `get_sweep_context` | site, this sweep's fingerprint summary, the approved baseline and the previous sweep |
| `diff_against_baseline` | the deterministic set difference, split into `alerts` and `noise` by the stability window |
| `lookup_host_knowledge` | what the vendor tables know about a domain that appeared: exact entry, near matches, naming heuristic, and the closed category set |
| `approve_baseline` | points the site at this sweep and clears pending, for a site's first sweep only |
| `record_decision` | writes the verdict — `noop`, `drift` or `baseline-created` — and parks what it alerted on |

The split is deliberate. Everything that must be exactly right is a tool: reading
fingerprints, computing the difference, writing the verdict. The model decides what a
difference *means* — first sweep, harmless churn, or a tracker that appeared without
anyone deciding to add it — and how to say so to the person who has to answer for it. An
LLM asked to eyeball two host lists will occasionally miss one, and a missed marketing
pixel is the exact failure this product exists to prevent.

### What counts as a change

Hosts are compared by **registrable domain** (eTLD+1), not by hostname. Sharded CDN hosts
rotate between sweeps — `d15-a.sdn.cz` one day, `d21-a.sdn.cz` the next — and comparing
hostnames would report drift on every sweep of every site using one, which trains the
owner to ignore the alerts. The rotation is noise; a new registrable domain is the signal.
Each delta carries the `registrableDomain` and one example full `host`, and the recorded
decision stores the domains, so downstream ticket de-duplication sees a stable string.

Cookies keep `(name, domain)` identity — cookie domains do not rotate that way.

### The stability window

Keying on the registrable domain killed CDN shard churn. It did not kill the other
kind: on a commercial site the domain *set* moves between sweeps by itself, because
a programmatic ad slot fills with a different vendor on every pageview. novinky.cz
showed `alza.cz` on one sweep and different ad tech on the next, with nothing about
the site having changed. An agent that alerts on that gets muted in a week, and a
muted watchdog is worse than none.

So a set difference is not an alert. Every domain and cookie in
(current ∪ baseline ∪ the last N sweeps) is classified against the site's own recent
history, in `@pixel-patrol/shared`, deterministically:

| class | meaning | alerts |
| --- | --- | --- |
| `stable` | in the baseline and in this sweep | no |
| `new` | in this sweep, not in the baseline, in none of the last N — never seen before | **yes** |
| `returning` | in this sweep, not in the baseline, in *all* of the last N — a persistent addition nobody approved | **yes** |
| `flapping` | in and out across the window; or a cookie whose name carries a generated identifier | no |
| `gone` | in the baseline, absent here and from the last M sweeps | **yes** |
| `missing-once` | in the baseline, absent here, but present within the last M | no |
| `pending` | would have alerted, but was already reported and is waiting on a human | no |

`N` is `STABILITY_WINDOW` (default 5), `M` is `GONE_AFTER` (default 3). Each entry
carries its `presenceRatio`, the fraction of the window that contained it. The
reference snapshot is excluded from its own window: it is already the other side of
the comparison, and counting it again would hold a genuine addition's ratio below 1
for the next N sweeps and file it as rotation.

`diff_against_baseline` returns `{comparedTo, windowSize, alerts, noise, noiseCount,
hashChanged}`. The model may only read the split, never redraw it: alerts non-empty
is `drift`, alerts empty is `noop`, and the noop summary may say how many rotating
domains were ignored.

### Reporting a finding once

An alert parks its keys in the site's `pendingDomains` and `pendingCookies`. The next
sweep sees them as `pending` — reported, not alerted — so an hourly schedule does not
re-file the same finding every hour until somebody acts. Approving a baseline clears
them, because approving *is* the decision they were waiting for.

The keys are recomputed inside `record_decision` rather than taken from the model's
arguments: the dedupe key has to be exactly the key the classifier alerted on, and a
model that renames `facebook.net` to `connect.facebook.net` would silently break it.
The sweep that wrote the pending entries is exempt from its own suppression, so a
Pub/Sub redelivery re-reports drift instead of overwriting the verdict with a noop.

### The tuning tool

```bash
PROJECT_ID=pixel-patrol-mp ./infra/stability-report.sh smoke-trackers 5
```

prints every registrable domain with its presence ratio, whether the baseline has it
and which class it landed in, then the decisions the analyst recorded. Read-only.
The thresholds are guesses until they are checked against overnight data from a site
with real ad tech on it, and this is what that check looks like.

Fingerprints carry a `schemaVersion`. If the two sides differ, or either is missing one
(generation 1, written before the crawler stamped it and before `registrableDomain`
existed), the diff returns `{comparedTo: "incompatible", reason}` rather than a result:
comparing across generations would report the site's entire tracker set as removed and
re-added. The agent's recovery is to approve the current sweep as a fresh baseline and
record `baseline-created`.

## The scribe

A drift decision on its own is a notification. The work it creates — rewriting the cookie
policy, filing the RoPA row — is the part that never happens, so a second `LlmAgent` does
it in the same request, immediately after the analyst records `action: "drift"`.

| tool | what it does |
| --- | --- |
| `get_drift_context` | the decision, the alerting half of the diff, and the vendor table entries for every domain and cookie in it |
| `write_redline` | writes `sites/{id}/redlines/{sweepId}`: `policyRedline` and `ropaRow` |

`policyRedline` is Czech `Přidat:` / `Odstranit:` edit instructions naming each tracker,
its operator, purpose, consent category, and the cookie names and durations the tables
know. `ropaRow` is one record-of-processing row in the field shape the gdpr-toolkit
exports. Both are keyed by `sweepId`, so a Pub/Sub redelivery rewrites the same document.

It is a separate agent rather than four more paragraphs in the analyst's instruction for
two reasons: it only runs on drift, so the hourly noop path does not pay for a prompt
about document drafting; and its job pulls the other way — the analyst writes one careful
sentence for a log, the scribe writes a page of regulated prose.

Both agents are held to the same rule: state only what a tool returned. A domain the
tables have never seen is recorded as `unclassified`, `vendor: null`, confidence `low`,
with a `basis` saying so, and the redline tells the owner to establish who runs it before
publishing. An invented vendor in a document filed with a regulator is worse than a gap.

A scribe failure is logged and swallowed rather than retried. The decision is already
written and it is what the alerting is built on; a nack here would re-run the expensive
analyst to retry the cheap half.

## The notifier

Everything above this point is a document in Firestore that nobody is looking at.
A drift decision and its redline are worth exactly as much as the odds someone opens
the console, which on a watchdog running every ten minutes is zero. So once the scribe
has written the paperwork, the finding leaves the system twice: a GitHub issue on
`thatmike1/pixel-patrol-tickets`, where the work gets tracked, and an email to the
site's owner, where it gets noticed. Both carry the same content — the analyst's
summary and classification table, the Czech `policyRedline`, the RoPA row, and the
Firestore paths behind them.

This one is **not** an `LlmAgent`. The analyst and the scribe exist because judgement
was needed: what a difference means, and how to write it up for a regulator. Nothing
here needs judgement. The words already exist in two documents, and what is left —
file this, send that, exactly once — is mechanics, where a model can only add a way
for it to go wrong.

### Exactly once

Pub/Sub redelivers. A redelivered `sweep-done` rewrites the same decision and the same
redline, both keyed by `sweepId`, so a replay costs money and changes nothing. Neither
escapes the system. A ticket and an email do, and a second copy of each is what teaches
an owner to stop reading them.

So the outcome is recorded at `sites/{id}/notifications/{sweepId}` and read before
anything is sent. The two halves are stored separately — filing can succeed while the
mail fails — and a replay then sends only the missing half. Re-filing the ticket to get
the mail out would leave two tickets for one finding, which is the thing being prevented.

A notifier failure is logged and swallowed, like the scribe's, and for the same reason:
a nack here would re-run the analyst and the scribe to retry an HTTP call. What it
leaves behind is a notification document with the missing half still `null` and the
reason on it.

### The Resend constraint

The account sends from Resend's shared `onboarding@resend.dev`, which delivers **only**
to the address that owns the account. Every other recipient is accepted with a `200`
and an id, then dropped. A `200` therefore proves the request was well formed, not that
anyone received anything. Until a domain is verified, the deliverable address is
`DEFAULT_OWNER_EMAIL`, which is what a site with no `ownerEmail` falls back to —
including every site registered before the field existed.

### Planting a drift for a demo

The honest way to show this working is to wait for a real site to add a tracker, which
happens on nobody's schedule. `scripts/seed-drift.ts` does the equivalent from the other
end: it deletes a domain the site genuinely loads out of the *approved baseline*, so the
next sweep finds that domain present and unaccounted for.

```bash
npm --prefix agent run seed-drift -- demo-shop                              # list the baseline
npm --prefix agent run seed-drift -- demo-shop doubleclick.net facebook.net # plant
```

The signal is real: the differ, the stability classification, the analyst and the scribe
all run over actual crawl data and none of them knows anything was arranged. The only
fabricated part is the approval history, which is the one thing a demo cannot wait for.

`demo-shop` is registered against a Czech e-shop that loads around forty third-party
hosts, so a planted drift on `doubleclick.net`, `facebook.net` and `clarity.ms` produces
three high-confidence table hits and a redline naming every cookie each one sets.

## Endpoints

| method | path | auth | returns |
| --- | --- | --- | --- |
| `GET` | `/healthz` | none | `200` |
| `POST` | `/trigger/tick` | push OIDC | `204`, after publishing one `site-sweep` per site |
| `POST` | `/trigger/site-sweep` | push OIDC | `204`, once the crawl execution is accepted |
| `POST` | `/trigger/sweep-done` | push OIDC | `204`, once a decision is recorded |
| `POST` | `/sites` | `x-admin-key` | `201` — body `{siteId, url, ownerEmail?}` |
| `POST` | `/sites/:siteId/sweep` | `x-admin-key` | `202 {siteId, sweepId}` — forces a re-check |
| `POST` | `/sites/:siteId/baseline` | `x-admin-key` | `200` — body `{sweepId}`; approves it and clears pending |
| `GET` | `/sites/:siteId/decisions?limit=10` | `x-admin-key` | `200 {siteId, decisions}` |
| `GET` | `/sites/:siteId/redlines?limit=10` | `x-admin-key` | `200 {siteId, redlines}` |
| `GET` | `/sites/:siteId/redlines/:sweepId` | `x-admin-key` | `200` the redline, `404` when the sweep produced none |

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
| `STABILITY_WINDOW` | no, `5` | N: sweeps of history the drift classification reasons over |
| `GONE_AFTER` | no, `3` | M: consecutive absences before a baseline entry counts as removed |
| `SITE_SWEEP_TOPIC` | no, `site-sweep` | |
| `GITHUB_TICKETS_TOKEN` | no | PAT with `issues: write`; from Secret Manager. Unset means no tickets |
| `GITHUB_TICKETS_REPO` | no, `thatmike1/pixel-patrol-tickets` | `owner/repo` the tickets are filed against |
| `RESEND_API_KEY` | no | from Secret Manager. Unset means no owner mail |
| `RESEND_FROM` | no, `Pixel Patrol <onboarding@resend.dev>` | must be a sender Resend accepts |
| `DEFAULT_OWNER_EMAIL` | no, `thatmike.dev@gmail.com` | where a site with no `ownerEmail` is mailed |
| `SELF_URL` | for triggers | this service's base URL, the expected OIDC audience |
| `PORT` | no, `8080` | Cloud Run injects it |
| `LOG_LEVEL` | no, `info` | |

`SELF_URL` cannot be required at boot: a Cloud Run URL only exists after the first deploy.
The service starts without it, logs a warning, and answers `503` on `/trigger/*` until it
is set. `infra/deploy-agent.sh` sets it in a second pass immediately after deploying.

## Local

This is an npm workspace. Install from the repo root, not from here:

```bash
cd .. && npm install                    # one lockfile, shared symlinked into node_modules
gcloud auth application-default login   # ADC for Firestore, Pub/Sub and Vertex
cd agent && cp .env.example .env        # then export the variables you need
npm run typecheck && npm test
npm run dev
```

`@pixel-patrol/shared` ships compiled JS, so every script here builds it first through
a `pre` hook. `npm test` covers the store-backed drift pipeline, the classification and redline
machinery around the two agents, and the push-envelope decoder, and needs no credentials
or emulator; the pure classification is tested in
`shared`. The rest is verified against the real project.

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

The image is built with the **repo root** as the Docker context
(`infra/cloudbuild-agent.yaml`), because this service imports `@pixel-patrol/shared`
from outside this directory and `gcloud builds submit agent` would upload only
`agent/`. The npm install inside the Dockerfile is filtered to this workspace and
`shared`, so the crawler's Playwright never lands in this image.

Both are idempotent. `deploy-agent.sh` prints a generated `ADMIN_KEY` once on the first
run and reuses the deployed one afterwards, so a redeploy does not invalidate it.
