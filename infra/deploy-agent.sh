#!/usr/bin/env bash
# builds the agent image with Cloud Build, pushes it to Artifact Registry and
# creates or updates the `patrol-agent` Cloud Run service. re-runnable.
#
# the service is deployed twice on the first run: a Cloud Run URL is only known
# after the service exists, and the agent needs it as the expected audience of
# the OIDC tokens Pub/Sub signs its push deliveries with. the second pass is an
# env-var update, not a rebuild.
#
#   PROJECT_ID=pixel-patrol-mp ./infra/deploy-agent.sh
set -euo pipefail
PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-europe-west1}"
AR_REPO="${AR_REPO:-patrol}"
GEMINI_LOCATION="${GEMINI_LOCATION:-global}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.5-flash}"
SWEEP_TOPIC="${SWEEP_TOPIC:-site-sweep}"
CRAWLER_JOB="${CRAWLER_JOB:-patrol-crawler}"
# the stability window: N sweeps of history, M absences before a removal
STABILITY_WINDOW="${STABILITY_WINDOW:-5}"
GONE_AFTER="${GONE_AFTER:-3}"
# where a drift finding is filed and mailed
GITHUB_TICKETS_REPO="${GITHUB_TICKETS_REPO:-thatmike1/pixel-patrol-tickets}"
# ssscribe.app is a verified Resend sending domain, so mail reaches any recipient
RESEND_FROM="${RESEND_FROM:-Pixel Patrol <patrol@ssscribe.app>}"
DEFAULT_OWNER_EMAIL="${DEFAULT_OWNER_EMAIL:-thatmike.dev@gmail.com}"
# Secret Manager secret names, mounted as env vars on the service
GITHUB_TOKEN_SECRET="${GITHUB_TOKEN_SECRET:-github-tickets-token}"
RESEND_KEY_SECRET="${RESEND_KEY_SECRET:-resend-api-key}"
SERVICE="patrol-agent"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${TAG:-$(git -C "$ROOT" rev-parse --short HEAD)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/agent:${TAG}"
AGENT_SA="patrol-agent@${PROJECT_ID}.iam.gserviceaccount.com"

# ---------------------------------------------------------------------------
# admin key: reuse the deployed one so a redeploy does not invalidate the
# operator's key. only generated when there is nothing to reuse.
# ---------------------------------------------------------------------------
if [[ -z "${ADMIN_KEY:-}" ]]; then
  ADMIN_KEY="$(gcloud run services describe "$SERVICE" \
    --region "$REGION" --project "$PROJECT_ID" --format=json 2>/dev/null \
    | jq -r '.spec.template.spec.containers[0].env[]? | select(.name=="ADMIN_KEY") | .value' \
    || true)"
fi
GENERATED_KEY=false
if [[ -z "${ADMIN_KEY:-}" || "$ADMIN_KEY" == "null" ]]; then
  ADMIN_KEY="$(openssl rand -hex 24)"
  GENERATED_KEY=true
fi

# the context is the repo root, not agent/: the service imports
# @pixel-patrol/shared, and `gcloud builds submit agent` would upload only
# agent/ and fail on the missing package inside Docker
echo "== build ${IMAGE}"
gcloud builds submit "$ROOT" \
  --config "${ROOT}/infra/cloudbuild-agent.yaml" \
  --substitutions "_IMAGE=${IMAGE}" \
  --project "$PROJECT_ID" --quiet

# an existing SELF_URL is carried into the first deploy so the trigger routes are
# live immediately on a redeploy rather than 503-ing until the update below
SELF_URL="$(gcloud run services describe "$SERVICE" \
  --region "$REGION" --project "$PROJECT_ID" --format='value(status.url)' 2>/dev/null || true)"

# ^##^ picks '##' as the separator instead of ',', so a generated key containing
# a comma cannot split one variable into two
ENV_VARS="^##^GOOGLE_CLOUD_PROJECT=${PROJECT_ID}"
ENV_VARS="${ENV_VARS}##GOOGLE_CLOUD_LOCATION=${GEMINI_LOCATION}"
ENV_VARS="${ENV_VARS}##GOOGLE_GENAI_USE_ENTERPRISE=true"
ENV_VARS="${ENV_VARS}##MODEL=${GEMINI_MODEL}"
ENV_VARS="${ENV_VARS}##REGION=${REGION}"
ENV_VARS="${ENV_VARS}##CRAWLER_JOB=${CRAWLER_JOB}"
ENV_VARS="${ENV_VARS}##SITE_SWEEP_TOPIC=${SWEEP_TOPIC}"
ENV_VARS="${ENV_VARS}##STABILITY_WINDOW=${STABILITY_WINDOW}"
ENV_VARS="${ENV_VARS}##GONE_AFTER=${GONE_AFTER}"
ENV_VARS="${ENV_VARS}##ADMIN_KEY=${ADMIN_KEY}"
ENV_VARS="${ENV_VARS}##GITHUB_TICKETS_REPO=${GITHUB_TICKETS_REPO}"
ENV_VARS="${ENV_VARS}##RESEND_FROM=${RESEND_FROM}"
ENV_VARS="${ENV_VARS}##DEFAULT_OWNER_EMAIL=${DEFAULT_OWNER_EMAIL}"
if [[ -n "$SELF_URL" ]]; then
  ENV_VARS="${ENV_VARS}##SELF_URL=${SELF_URL}"
fi

# the notifier's two credentials, mounted from Secret Manager rather than set as
# env vars: a `gcloud run services describe` prints every env var it finds, and
# the service description is the first thing anyone runs when a deploy looks
# wrong. the SA needs roles/secretmanager.secretAccessor on both.
SECRETS="GITHUB_TICKETS_TOKEN=${GITHUB_TOKEN_SECRET}:latest"
SECRETS="${SECRETS},RESEND_API_KEY=${RESEND_KEY_SECRET}:latest"

echo "== service ${SERVICE}"
gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --region "$REGION" --project "$PROJECT_ID" \
  --service-account "$AGENT_SA" \
  --no-allow-unauthenticated \
  --memory 1Gi --cpu 1 --timeout 600 --concurrency 20 --max-instances 10 \
  --set-env-vars "$ENV_VARS" \
  --set-secrets "$SECRETS" \
  --quiet

SELF_URL="$(gcloud run services describe "$SERVICE" \
  --region "$REGION" --project "$PROJECT_ID" --format='value(status.url)')"

echo "== SELF_URL ${SELF_URL}"
gcloud run services update "$SERVICE" \
  --region "$REGION" --project "$PROJECT_ID" \
  --update-env-vars "SELF_URL=${SELF_URL}" \
  --quiet >/dev/null

# the push subscriptions authenticate as the agent SA, so it needs permission to
# invoke the service it is pushing into
echo "== run.invoker for ${AGENT_SA}"
gcloud run services add-iam-policy-binding "$SERVICE" \
  --region "$REGION" --project "$PROJECT_ID" \
  --member "serviceAccount:${AGENT_SA}" \
  --role roles/run.invoker \
  --quiet >/dev/null

echo
echo "deployed ${IMAGE}"
echo "service  ${SELF_URL}"
if [[ "$GENERATED_KEY" == true ]]; then
  echo
  echo "ADMIN_KEY (generated, shown once — store it now):"
  echo "  ${ADMIN_KEY}"
fi
echo
echo "next: PROJECT_ID=${PROJECT_ID} ./infra/wire-pubsub.sh"
