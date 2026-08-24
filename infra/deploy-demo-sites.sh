#!/usr/bin/env bash
# builds the demo-sites image and creates or updates the `demo-sites` Cloud Run
# service. re-runnable, and the redeploy step of every demo: a page edit is not
# live until this has finished.
#
#   PROJECT_ID=pixel-patrol-mp ./infra/deploy-demo-sites.sh
#
# unlike patrol-agent this service is deployed --allow-unauthenticated, because
# the crawler reaches it the way a member of the public would: over the open
# internet, with no credentials. an authenticated demo target would be proving
# something easier than the real job.
set -euo pipefail
PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-europe-west1}"
AR_REPO="${AR_REPO:-patrol}"
SERVICE="demo-sites"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${TAG:-$(git -C "$ROOT" rev-parse --short HEAD)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/demo-sites:${TAG}"

echo "== build ${IMAGE}"
gcloud builds submit "$ROOT" \
  --config "${ROOT}/infra/cloudbuild-demo-sites.yaml" \
  --substitutions "_IMAGE=${IMAGE}" \
  --project "$PROJECT_ID" --quiet

echo "== service ${SERVICE}"
# min-instances 0: five pages swept once an hour do not justify a warm instance,
# and a cold start costs the crawler about a second on a 30s page timeout
gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --region "$REGION" --project "$PROJECT_ID" \
  --allow-unauthenticated \
  --memory 256Mi --cpu 1 --timeout 60 --concurrency 80 --max-instances 4 \
  --quiet

BASE_URL="$(gcloud run services describe "$SERVICE" \
  --region "$REGION" --project "$PROJECT_ID" --format='value(status.url)')"

echo
echo "deployed ${IMAGE}"
echo "pages:"
for path in boutique magazine clinic bistro atelier; do
  echo "  ${BASE_URL}/${path}/"
done
