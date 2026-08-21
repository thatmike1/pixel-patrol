#!/usr/bin/env bash
# runs one crawl of one site as a Cloud Run Job execution and waits for it.
# the same call the agent makes through the Cloud Run Admin API, for humans.
#
#   PROJECT_ID=pixel-patrol-mp ./infra/run-sweep.sh <site-id> <site-url> [sweep-id]
set -euo pipefail
PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-europe-west1}"
SITE_ID="${1:?site-id}"; SITE_URL="${2:?site-url}"
SWEEP_ID="${3:-manual-$(date -u +%Y%m%dT%H%M%SZ)}"

gcloud run jobs execute patrol-crawler \
  --region "$REGION" --project "$PROJECT_ID" --wait \
  --update-env-vars "SITE_ID=${SITE_ID},SITE_URL=${SITE_URL},SWEEP_ID=${SWEEP_ID}"
echo "sweep ${SWEEP_ID} for ${SITE_ID} finished; fingerprint at sites/${SITE_ID}/fingerprints/${SWEEP_ID}"
