#!/usr/bin/env bash
# provisions the whole Pixel Patrol GCP project from scratch. idempotent: re-running
# skips anything that already exists. run as a human account that owns a billing account.
#
#   PROJECT_ID=pixel-patrol-mp BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX ./infra/provision.sh
#
# after it finishes, `gcloud auth application-default login` once for local dev.
#
# what this script owns: identities, permissions, storage, topics and secrets — every
# stateful thing the three deploy scripts assume already exists. it deliberately does
# not deploy anything; see README.md for the order.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
BILLING_ACCOUNT="${BILLING_ACCOUNT:?set BILLING_ACCOUNT (gcloud billing accounts list)}"
REGION="${REGION:-europe-west1}"          # Cloud Run, Firestore, Artifact Registry, Scheduler
GEMINI_LOCATION="${GEMINI_LOCATION:-global}"  # gemini-3.5-flash is only served on the global endpoint (checked 2026-08-21)
AR_REPO="${AR_REPO:-patrol}"
AGENT_SA="patrol-agent@${PROJECT_ID}.iam.gserviceaccount.com"
CRAWL_SA="patrol-crawler@${PROJECT_ID}.iam.gserviceaccount.com"
PAGES_SA="patrol-demo-sites@${PROJECT_ID}.iam.gserviceaccount.com"
# the notifier's two credentials. created empty here; the notifier stays dormant until
# a real version is added, because an empty value reads back as "no credential"
GITHUB_TOKEN_SECRET="${GITHUB_TOKEN_SECRET:-github-tickets-token}"
RESEND_KEY_SECRET="${RESEND_KEY_SECRET:-resend-api-key}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "project ${PROJECT_ID}"
if ! gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud projects create "$PROJECT_ID" --name="Pixel Patrol"
fi
gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

say "billing"
if [ "$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)')" != "True" ]; then
  gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
fi

say "apis"
gcloud services enable \
  run.googleapis.com aiplatform.googleapis.com pubsub.googleapis.com firestore.googleapis.com \
  cloudscheduler.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  cloudbuild.googleapis.com iam.googleapis.com monitoring.googleapis.com \
  cloudresourcemanager.googleapis.com logging.googleapis.com

say "service accounts"
# three runtime identities, one per deployable. the static page server gets its own
# rather than Cloud Run's default compute account, which carries roles/editor on older
# projects — a file server with permission to delete Firestore is the kind of thing
# nobody notices until it matters
for SA in patrol-agent patrol-crawler patrol-demo-sites; do
  gcloud iam service-accounts describe "${SA}@${PROJECT_ID}.iam.gserviceaccount.com" >/dev/null 2>&1 \
    || gcloud iam service-accounts create "$SA" --display-name="$SA"
done

say "custom role: patrolCrawlerRunner"
# the agent starts crawls with per-sweep env overrides, which needs run.jobs.run AND
# run.jobs.runWithOverrides. the smallest predefined role carrying both is
# roles/run.developer, which also grants create, update and delete on every service and
# job in the project — far too much for a caller whose whole job is to press start on
# one job. deploy-crawler.sh binds this role on the job resource, not the project.
CRAWLER_RUNNER_PERMS="run.jobs.run,run.jobs.runWithOverrides,run.operations.get"
if gcloud iam roles describe patrolCrawlerRunner --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam roles update patrolCrawlerRunner --project "$PROJECT_ID" \
    --permissions "$CRAWLER_RUNNER_PERMS" --quiet >/dev/null
else
  gcloud iam roles create patrolCrawlerRunner --project "$PROJECT_ID" \
    --title="Patrol crawler runner" \
    --description="start one Cloud Run job execution with per-sweep env overrides, nothing else" \
    --permissions "$CRAWLER_RUNNER_PERMS" --stage=GA >/dev/null
fi

say "iam (least privilege per service)"
# the ADK orchestrator, project-wide: calls Gemini, reads and writes Firestore, logs.
# publishing is scoped to one topic below, running the crawler to one job in
# deploy-crawler.sh, and reading secrets to the two secrets themselves.
for ROLE in roles/aiplatform.user roles/datastore.user roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${AGENT_SA}" --role="$ROLE" --condition=None >/dev/null
done
# the Playwright crawler job: writes fingerprints, logs, and reports back on one topic
for ROLE in roles/datastore.user roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${CRAWL_SA}" --role="$ROLE" --condition=None >/dev/null
done
# the demo page server gets no roles at all. it reads files off its own disk and needs
# nothing from the project — not even logging.logWriter: Cloud Run forwards a container's
# stdout itself rather than writing it as the service identity, which was checked by
# giving this account nothing and watching its startup line still arrive in
# run.googleapis.com%2Fstdout.

# the agent may run the crawler job as the crawler identity
gcloud iam service-accounts add-iam-policy-binding "$CRAWL_SA" \
  --member="serviceAccount:${AGENT_SA}" --role=roles/iam.serviceAccountUser >/dev/null

say "artifact registry ${AR_REPO} (${REGION})"
gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$AR_REPO" --repository-format=docker --location="$REGION"

say "cloud build identity"
# `gcloud builds submit` runs as the default compute account unless told otherwise. it
# needs to pull the source archive, write build logs and push to Artifact Registry —
# which is exactly roles/cloudbuild.builds.builder. on a project old enough to have
# been given the legacy roles/editor on that account, drop it: nothing here needs it,
# and it is the widest grant in the policy.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${BUILD_SA}" --role=roles/cloudbuild.builds.builder --condition=None >/dev/null
if gcloud projects get-iam-policy "$PROJECT_ID" --flatten="bindings[].members" \
     --filter="bindings.role=roles/editor AND bindings.members:${BUILD_SA}" \
     --format='value(bindings.role)' | grep -q editor; then
  echo "dropping roles/editor from ${BUILD_SA}"
  gcloud projects remove-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${BUILD_SA}" --role=roles/editor --condition=None >/dev/null
fi

say "firestore (native, ${REGION})"
gcloud firestore databases describe --database="(default)" >/dev/null 2>&1 \
  || gcloud firestore databases create --database="(default)" --location="$REGION" --type=firestore-native

say "pub/sub topics"
# every topic the system publishes to, including the two dead-letter topics. the
# subscriptions, the scheduler and the dead-letter IAM are wire-pubsub.sh's job,
# because they need the agent's Cloud Run URL and so cannot exist until it is deployed.
for T in sweep-tick site-sweep sweep-done site-sweep-dlq sweep-done-dlq; do
  gcloud pubsub topics describe "$T" >/dev/null 2>&1 || gcloud pubsub topics create "$T"
done
# publishing is scoped to the one topic each identity actually publishes to
gcloud pubsub topics add-iam-policy-binding site-sweep \
  --member="serviceAccount:${AGENT_SA}" --role=roles/pubsub.publisher --quiet >/dev/null
gcloud pubsub topics add-iam-policy-binding sweep-done \
  --member="serviceAccount:${CRAWL_SA}" --role=roles/pubsub.publisher --quiet >/dev/null

say "secrets"
# created empty on purpose. deploy-agent.sh mounts both with `--set-secrets ...:latest`,
# which fails outright on a secret with no versions, so a fresh project needs them to
# exist before the first deploy. an empty value reads back as null in config.ts and the
# notifier skips the half it has no credential for — so the watchdog runs, crawls,
# analyses and records from the first deploy, and starts filing tickets the moment a
# real version is added. no redeploy needed: `:latest` is resolved per instance start.
for SECRET in "$GITHUB_TOKEN_SECRET" "$RESEND_KEY_SECRET"; do
  gcloud secrets describe "$SECRET" >/dev/null 2>&1 \
    || gcloud secrets create "$SECRET" --replication-policy=automatic >/dev/null
  if [ -z "$(gcloud secrets versions list "$SECRET" --limit=1 --format='value(name)')" ]; then
    printf '' | gcloud secrets versions add "$SECRET" --data-file=- >/dev/null
    echo "created ${SECRET} with an empty version — add the real one to enable that half of the notifier"
  fi
  # read access is granted on the secret itself, not project-wide
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --member="serviceAccount:${AGENT_SA}" --role=roles/secretmanager.secretAccessor --quiet >/dev/null
done

say "smoke: gemini-3.5-flash on ${GEMINI_LOCATION}"
TOK=$(gcloud auth print-access-token)
HOST=aiplatform.googleapis.com; [ "$GEMINI_LOCATION" != global ] && HOST="${GEMINI_LOCATION}-aiplatform.googleapis.com"
curl -sf -X POST "https://${HOST}/v1/projects/${PROJECT_ID}/locations/${GEMINI_LOCATION}/publishers/google/models/gemini-3.5-flash:generateContent" \
  -H "Authorization: Bearer ${TOK}" -H "Content-Type: application/json" -H "x-goog-user-project: ${PROJECT_ID}" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Reply with exactly: patrol online"}]}]}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["candidates"][0]["content"]["parts"][0]["text"].strip())'

say "done"
echo "project=${PROJECT_ID} region=${REGION} gemini_location=${GEMINI_LOCATION}"
echo "agent_sa=${AGENT_SA}"
echo "crawler_sa=${CRAWL_SA}"
echo "pages_sa=${PAGES_SA}"
echo
echo "next: ./infra/deploy-crawler.sh, ./infra/deploy-agent.sh, ./infra/wire-pubsub.sh"
