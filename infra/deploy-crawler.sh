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
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== build ${IMAGE}"
gcloud builds submit "${ROOT}/crawler" --tag "$IMAGE" --project "$PROJECT_ID" --quiet

echo "== job patrol-crawler"
gcloud run jobs deploy patrol-crawler \
  --image "$IMAGE" \
  --region "$REGION" --project "$PROJECT_ID" \
  --service-account "$CRAWL_SA" \
  --memory 2Gi --cpu 1 --task-timeout 10m --max-retries 0 --tasks 1 \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID},SWEEP_DONE_TOPIC=sweep-done,PAGES_TO_SCAN=5" \
  --quiet

echo "deployed ${IMAGE}"
