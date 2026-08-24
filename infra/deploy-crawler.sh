#!/usr/bin/env bash
# builds the crawler image with Cloud Build, pushes it to Artifact Registry and
# creates or updates the `patrol-crawler` Cloud Run Job. re-runnable.
#
#   PROJECT_ID=pixel-patrol-mp ./infra/deploy-crawler.sh
set -euo pipefail
PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-europe-west1}"
AR_REPO="${AR_REPO:-patrol}"
TAG="${TAG:-$(git -C "$(dirname "$0")/.." rev-parse --short HEAD)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/crawler:${TAG}"
CRAWL_SA="patrol-crawler@${PROJECT_ID}.iam.gserviceaccount.com"
AGENT_SA="patrol-agent@${PROJECT_ID}.iam.gserviceaccount.com"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# the context is the repo root, not crawler/: the job imports
# @pixel-patrol/shared, and `gcloud builds submit crawler` would upload only
# crawler/ and fail on the missing package inside Docker
echo "== build ${IMAGE}"
gcloud builds submit "$ROOT" \
  --config "${ROOT}/infra/cloudbuild-crawler.yaml" \
  --substitutions "_IMAGE=${IMAGE}" \
  --project "$PROJECT_ID" --quiet

echo "== job patrol-crawler"
gcloud run jobs deploy patrol-crawler \
  --image "$IMAGE" \
  --region "$REGION" --project "$PROJECT_ID" \
  --service-account "$CRAWL_SA" \
  --memory 2Gi --cpu 1 --task-timeout 10m --max-retries 0 --tasks 1 \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID},SWEEP_DONE_TOPIC=sweep-done,PAGES_TO_SCAN=5" \
  --quiet

# the agent may start this job and no other. the permission to run a job with env
# overrides only exists in roles/run.developer and above, both of which also grant
# create, update and delete across every Cloud Run resource in the project — so the
# grant is a two-permission custom role (created by provision.sh) bound here, on the
# job itself, rather than anything project-wide.
echo "== the agent may start this job"
gcloud run jobs add-iam-policy-binding patrol-crawler \
  --region "$REGION" --project "$PROJECT_ID" \
  --member "serviceAccount:${AGENT_SA}" \
  --role "projects/${PROJECT_ID}/roles/patrolCrawlerRunner" \
  --quiet >/dev/null

echo "deployed ${IMAGE}"
