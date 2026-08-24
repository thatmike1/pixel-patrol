# IAM

Who is allowed to do what, and why. Audited 2026-08-24 against the live
`pixel-patrol-mp` project.

The rule the matrix follows: a grant is scoped to the narrowest resource that still
lets the component do its one job. Project-level roles are the exception here, not the
default, and each one that survives is justified below.

## Identities

| identity | runs | how it is created |
| --- | --- | --- |
| `patrol-agent@` | the `patrol-agent` Cloud Run service: fan-out, diff, both Gemini agents, notifier | `provision.sh` |
| `patrol-crawler@` | the `patrol-crawler` Cloud Run Job: Playwright, fingerprints | `provision.sh` |
| `patrol-demo-sites@` | the `demo-sites` Cloud Run service: five static pages | `provision.sh` |
| `<project-number>-compute@` | Cloud Build builds all three images | Google, per project |
| `service-<project-number>@gcp-sa-pubsub` | Pub/Sub's own service agent: mints push OIDC tokens, publishes dead letters | Google, on first use |

## The matrix

| identity | role | scope | why |
| --- | --- | --- | --- |
| `patrol-agent` | `roles/aiplatform.user` | project | calls `gemini-3.5-flash` on Vertex. Vertex has no per-model resource to bind to, so project is the narrowest scope that exists. |
| `patrol-agent` | `roles/datastore.user` | project | reads and writes every collection under `sites/`. Firestore IAM has no per-collection scope; the document-level rules that would give one are not reachable from a server SDK. |
| `patrol-agent` | `roles/logging.logWriter` | project | pino output. See the note below on whether this is needed at all. |
| `patrol-agent` | `roles/pubsub.publisher` | topic `site-sweep` | the only topic it publishes to. The fan-out is its whole publishing surface. |
| `patrol-agent` | `projects/…/roles/patrolCrawlerRunner` | job `patrol-crawler` | may start that one job, with overrides, and read the resulting operation. Nothing else. |
| `patrol-agent` | `roles/iam.serviceAccountUser` | SA `patrol-crawler` | starting a job means acting as the identity the job runs as. |
| `patrol-agent` | `roles/run.invoker` | service `patrol-agent` | the push subscriptions authenticate as this account, so it has to be allowed to call the service it is pushing into. |
| `patrol-agent` | `roles/secretmanager.secretAccessor` | secrets `github-tickets-token`, `resend-api-key` | reads exactly the two credentials it sends with, and no future secret added to the project. |
| `patrol-crawler` | `roles/datastore.user` | project | writes fingerprints. Same Firestore caveat as above. |
| `patrol-crawler` | `roles/logging.logWriter` | project | as above. |
| `patrol-crawler` | `roles/pubsub.publisher` | topic `sweep-done` | reports one crawl finished. It never publishes anywhere else. |
| `patrol-demo-sites` | none | | a static file server that reads its own disk needs nothing from the project. |
| `<n>-compute` | `roles/cloudbuild.builds.builder` | project | `gcloud builds submit` runs as this account: pull the source archive, write build logs, push to Artifact Registry. |
| Pub/Sub service agent | `roles/iam.serviceAccountTokenCreator` | project | minting an OIDC token as the push service account is an impersonation. |
| Pub/Sub service agent | `roles/pubsub.publisher` | topics `site-sweep-dlq`, `sweep-done-dlq` | without it the dead-letter policy is configured but inert and a poison message loops forever. |
| Pub/Sub service agent | `roles/pubsub.subscriber` | subscriptions `site-sweep-push`, `sweep-done-push` | the other half of the same dead-letter permission pair. |
| `allUsers` | `roles/run.invoker` | service `demo-sites` | deliberate. The crawler has to reach the watched pages the way a member of the public does. An authenticated demo target would be proving something easier than the real job. |

`patrol-agent` is deployed `--no-allow-unauthenticated`, so the only callers are its own
push subscriptions and an operator holding both a Google identity token and the admin
key.

### Two notes on scope

**Firestore and Vertex are project-scoped because nothing finer exists.** Firestore IAM
grants apply to a database, not a collection, and `roles/datastore.user` is already the
narrowest predefined role that can read and write documents. Vertex model access is
project-level by construction. Both are called out here so the reader can see they are a
platform limit rather than an oversight.

**`roles/logging.logWriter` may be unnecessary.** `patrol-demo-sites` holds no roles at
all and its container's stdout still arrives in
`run.googleapis.com%2Fstdout`, which means Cloud Run forwards container output itself
rather than writing it as the service identity. The grant is kept on the two working
accounts because it is the narrowest role in the catalogue and removing it on the
evidence of one service is not worth an outage during submission week. It is a
candidate for deletion after 31 August.

## What was removed, and what it cost

The audit found five over-broad grants. `provision.sh` no longer creates any of them,
so a fresh project gets the matrix above from the first run.

| grant | why it was wrong |
| --- | --- |
| `roles/editor` on `<n>-compute` | the widest binding in the policy. It came with the project, and it mattered because the `demo-sites` service was running as that account: a static file server with permission to delete the Firestore it is being watched against. Replaced by `roles/cloudbuild.builds.builder` for the build role, and a dedicated zero-role identity for the service. |
| `roles/cloudtasks.enqueuer` on `patrol-agent` | Cloud Tasks is not used anywhere in the system. It was enabled and granted on day one for a queueing design that push subscriptions replaced. `provision.sh` no longer enables the API. |
| `roles/secretmanager.secretAccessor` on `patrol-agent`, project-wide | redundant. Both secrets already carry the same binding on the secret itself, so the project-level grant only widened it to every secret the project will ever hold. |
| `roles/pubsub.subscriber` on `patrol-agent`, project-wide | the architecture is push-only. Nothing in the agent constructs a subscriber; the subscriptions deliver to it over HTTP and Pub/Sub's own service agent holds the subscriber role. |
| `roles/run.developer` on `patrol-agent`, project-wide | it was there for one call: `runJob` with per-sweep env overrides. That needs `run.jobs.run` and `run.jobs.runWithOverrides`, and the smallest predefined role carrying both also grants create, update and delete on every Cloud Run service and job in the project, including the agent's own deployment. Replaced by the two-permission custom role `patrolCrawlerRunner`, bound on the job. |
| `roles/pubsub.publisher` on both accounts, project-wide | each account publishes to exactly one topic. The grant is now on that topic. |

## State of the live project

Applied and verified live:

- `patrol-demo-sites` created, and the `demo-sites` service redeployed onto it
  (revision `demo-sites-00006-zth`). It holds no roles; the pages serve, and a sweep of
  `demo-atelier` crawled them and came back `noop` with `noiseCount: 0`.
- the `patrolCrawlerRunner` custom role created and bound on the `patrol-crawler` job.
- per-secret `secretAccessor` bindings (these predate the audit).

Not yet applied: the six revocations in the table above, and the two topic-level
publisher grants that replace the project-level ones. The commands are below, and they
must be run in this order, because each narrower grant has to be in place before the
wider one is removed.

```bash
export CLOUDSDK_ACTIVE_CONFIG_NAME=pixel-patrol
P=pixel-patrol-mp
AGENT=serviceAccount:patrol-agent@${P}.iam.gserviceaccount.com
CRAWL=serviceAccount:patrol-crawler@${P}.iam.gserviceaccount.com
BUILD=serviceAccount:663363395117-compute@developer.gserviceaccount.com

# 1. narrow the publish grants, then drop the project-wide ones
gcloud pubsub topics add-iam-policy-binding site-sweep --project $P --member=$AGENT --role=roles/pubsub.publisher
gcloud pubsub topics add-iam-policy-binding sweep-done --project $P --member=$CRAWL --role=roles/pubsub.publisher
gcloud projects remove-iam-policy-binding $P --member=$AGENT --role=roles/pubsub.publisher --condition=None
gcloud projects remove-iam-policy-binding $P --member=$CRAWL --role=roles/pubsub.publisher --condition=None

# 2. the job-scoped custom role is already bound, so run.developer can go
gcloud projects remove-iam-policy-binding $P --member=$AGENT --role=roles/run.developer --condition=None

# 3. grants for things the system does not do
gcloud projects remove-iam-policy-binding $P --member=$AGENT --role=roles/cloudtasks.enqueuer --condition=None
gcloud projects remove-iam-policy-binding $P --member=$AGENT --role=roles/pubsub.subscriber --condition=None

# 4. secret access stays, but only on the two secrets
gcloud projects remove-iam-policy-binding $P --member=$AGENT --role=roles/secretmanager.secretAccessor --condition=None

# 5. the build account keeps the role it actually needs
gcloud projects add-iam-policy-binding $P --member=$BUILD --role=roles/cloudbuild.builds.builder --condition=None
gcloud projects remove-iam-policy-binding $P --member=$BUILD --role=roles/editor --condition=None
```

After each numbered step, prove the chain still runs end to end rather than trusting the
policy read:

```bash
# a forced sweep exercises publish, job start, Firestore, Vertex and the analyst
api POST /sites/demo-atelier/sweep -d '{}'
sleep 120
api GET "/sites/demo-atelier/decisions?limit=1" | jq -c '.decisions[0] | {action, noiseCount}'
```

Step 4 additionally needs a new revision before it means anything, because secrets are
resolved at instance start:

```bash
gcloud run services update patrol-agent --region europe-west1 --project $P --no-traffic --tag probe
```

and step 5 needs a build:

```bash
PROJECT_ID=pixel-patrol-mp ./infra/deploy-demo-sites.sh
```

## Credentials

No credential is a file, an env var in a script, or a value in git.

- The GitHub PAT and the Resend key live in Secret Manager and are mounted with
  `--set-secrets`, not `--set-env-vars`, because `gcloud run services describe` prints
  every env var it finds and that is the first command anyone runs when a deploy looks
  wrong.
- `ADMIN_KEY` is generated on the first deploy and read back from the running service on
  every redeploy, so a redeploy never invalidates the operator's key. It is a shared
  secret on the operator endpoints only; the `/trigger/*` endpoints require a valid OIDC
  token whose audience is the exact endpoint being called, so a token minted for one
  trigger cannot be replayed against another.
- Both notifier credentials are optional at boot. A missing one disables that half of the
  notifier and nothing else, so a rotated key cannot take the watchdog offline.
