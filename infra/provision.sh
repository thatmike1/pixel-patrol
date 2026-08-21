#!/usr/bin/env bash
# provisions the whole Pixel Patrol GCP project from scratch. idempotent: re-running
# skips anything that already exists. run as a human account that owns a billing account.
#
#   PROJECT_ID=pixel-patrol-mp BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX ./infra/provision.sh
#
# after it finishes, `gcloud auth application-default login` once for local dev.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
BILLING_ACCOUNT="${BILLING_ACCOUNT:?set BILLING_ACCOUNT (gcloud billing accounts list)}"
REGION="${REGION:-europe-west1}"          # Cloud Run, Firestore, Artifact Registry, Scheduler
GEMINI_LOCATION="${GEMINI_LOCATION:-global}"  # gemini-3.5-flash is only served on the global endpoint (checked 2026-08-21)
AR_REPO="${AR_REPO:-patrol}"
AGENT_SA="patrol-agent@${PROJECT_ID}.iam.gserviceaccount.com"
CRAWL_SA="patrol-crawler@${PROJECT_ID}.iam.gserviceaccount.com"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "project ${PROJECT_ID}"
if ! gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud projects create "$PROJECT_ID" --name="Pixel Patrol"
fi
gcloud config set project "$PROJECT_ID" >/dev/null

say "billing"
if [ "$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)')" != "True" ]; then
  gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
fi

say "apis"
gcloud services enable \
  run.googleapis.com aiplatform.googleapis.com pubsub.googleapis.com firestore.googleapis.com \
  cloudscheduler.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  cloudbuild.googleapis.com cloudtasks.googleapis.com iam.googleapis.com \
  cloudresourcemanager.googleapis.com logging.googleapis.com

say "service accounts"
for SA in patrol-agent patrol-crawler; do
  gcloud iam service-accounts describe "${SA}@${PROJECT_ID}.iam.gserviceaccount.com" >/dev/null 2>&1 \
    || gcloud iam service-accounts create "$SA" --display-name="$SA"
done

say "iam (least privilege per service)"
# the ADK orchestrator: calls Gemini, reads/writes Firestore, publishes + consumes sweeps, launches the crawler job
for ROLE in roles/aiplatform.user roles/datastore.user roles/pubsub.publisher roles/pubsub.subscriber \
            roles/run.developer roles/secretmanager.secretAccessor roles/cloudtasks.enqueuer roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${AGENT_SA}" --role="$ROLE" --condition=None >/dev/null
done
# the Playwright crawler job: writes fingerprints, reports back on a topic, nothing else
for ROLE in roles/datastore.user roles/pubsub.publisher roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${CRAWL_SA}" --role="$ROLE" --condition=None >/dev/null
done
# the agent may run the crawler job as the crawler identity
gcloud iam service-accounts add-iam-policy-binding "$CRAWL_SA" \
  --member="serviceAccount:${AGENT_SA}" --role=roles/iam.serviceAccountUser >/dev/null

say "artifact registry ${AR_REPO} (${REGION})"
gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$AR_REPO" --repository-format=docker --location="$REGION"

say "firestore (native, ${REGION})"
gcloud firestore databases describe --database="(default)" >/dev/null 2>&1 \
  || gcloud firestore databases create --database="(default)" --location="$REGION" --type=firestore-native

say "pub/sub"
for T in site-sweep site-sweep-dlq; do
  gcloud pubsub topics describe "$T" >/dev/null 2>&1 || gcloud pubsub topics create "$T"
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
