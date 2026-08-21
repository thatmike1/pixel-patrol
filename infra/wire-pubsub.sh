#!/usr/bin/env bash
# wires the message plumbing around a deployed `patrol-agent`: the tick topic and
# its scheduler, the three push subscriptions, and the dead-letter permissions
# Pub/Sub needs to actually use the DLQ topics. describe-before-create, so it is
# safe to re-run.
#
#   PROJECT_ID=pixel-patrol-mp ./infra/wire-pubsub.sh
set -euo pipefail
PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-patrol-agent}"
SCHEDULE="${SCHEDULE:-*/10 * * * *}"
AGENT_SA="patrol-agent@${PROJECT_ID}.iam.gserviceaccount.com"

SELF_URL="${SELF_URL:-$(gcloud run services describe "$SERVICE" \
  --region "$REGION" --project "$PROJECT_ID" --format='value(status.url)' 2>/dev/null || true)}"
if [[ -z "$SELF_URL" ]]; then
  echo "no ${SERVICE} service in ${REGION}; run ./infra/deploy-agent.sh first" >&2
  exit 1
fi
echo "== agent at ${SELF_URL}"

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
# the Pub/Sub service agent is the identity that attaches dead-letter messages
# and mints the OIDC tokens on push deliveries; it is not the same principal as
# the push service account itself
PUBSUB_SA="service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"

# the service agent is created lazily by Google, and a project that has never
# used a push subscription may not have one yet — an IAM binding for a principal
# that does not exist is rejected. idempotent.
gcloud beta services identity create --service pubsub.googleapis.com \
  --project "$PROJECT_ID" --quiet >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# topics
# ---------------------------------------------------------------------------
ensure_topic() {
  local topic="$1"
  if gcloud pubsub topics describe "$topic" --project "$PROJECT_ID" >/dev/null 2>&1; then
    echo "== topic ${topic} exists"
  else
    echo "== topic ${topic} create"
    gcloud pubsub topics create "$topic" --project "$PROJECT_ID" --quiet
  fi
}

ensure_topic sweep-tick
ensure_topic sweep-done-dlq

# ---------------------------------------------------------------------------
# push subscriptions
#
# each subscription's OIDC audience is the exact endpoint it pushes to, and the
# agent verifies the token against that same string — so a token minted for one
# trigger cannot be replayed against another.
# ---------------------------------------------------------------------------
ensure_push_subscription() {
  local name="$1" topic="$2" path="$3" ack="$4" dlq="${5:-}"
  local endpoint="${SELF_URL}${path}"

  # everything except --topic, which only the create path accepts
  local common=(
    --project "$PROJECT_ID"
    --push-endpoint "$endpoint"
    --push-auth-service-account "$AGENT_SA"
    --push-auth-token-audience "$endpoint"
    --ack-deadline "$ack"
  )
  if [[ -n "$dlq" ]]; then
    common+=(--dead-letter-topic "$dlq" --max-delivery-attempts 5)
  fi

  if gcloud pubsub subscriptions describe "$name" --project "$PROJECT_ID" >/dev/null 2>&1; then
    echo "== subscription ${name} update"
    gcloud pubsub subscriptions update "$name" "${common[@]}" --quiet
  else
    echo "== subscription ${name} create"
    gcloud pubsub subscriptions create "$name" --topic "$topic" "${common[@]}" --quiet
  fi
}

# the tick fan-out is cheap and has nothing to poison, so no DLQ
ensure_push_subscription sweep-tick-push sweep-tick /trigger/tick 60
# starting a crawl is a fast API call; 60s is plenty
ensure_push_subscription site-sweep-push site-sweep /trigger/site-sweep 60 site-sweep-dlq
# the analyst runs a model with up to four tool round-trips behind this one, so
# it gets the full 300s Pub/Sub allows before it redelivers and runs it twice
ensure_push_subscription sweep-done-push sweep-done /trigger/sweep-done 300 sweep-done-dlq

# ---------------------------------------------------------------------------
# dead-letter permissions
#
# without these the dead-letter policy is configured but inert: Pub/Sub cannot
# publish the expired message to the DLQ topic, and the failing message loops
# forever instead of being parked.
# ---------------------------------------------------------------------------
echo "== dead-letter IAM for ${PUBSUB_SA}"
for topic in site-sweep-dlq sweep-done-dlq; do
  gcloud pubsub topics add-iam-policy-binding "$topic" \
    --project "$PROJECT_ID" \
    --member "serviceAccount:${PUBSUB_SA}" \
    --role roles/pubsub.publisher \
    --quiet >/dev/null
done
for subscription in site-sweep-push sweep-done-push; do
  gcloud pubsub subscriptions add-iam-policy-binding "$subscription" \
    --project "$PROJECT_ID" \
    --member "serviceAccount:${PUBSUB_SA}" \
    --role roles/pubsub.subscriber \
    --quiet >/dev/null
done

# minting an OIDC token as the push service account is an impersonation, so the
# Pub/Sub service agent needs the token-creator role
echo "== token creator for ${PUBSUB_SA}"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${PUBSUB_SA}" \
  --role roles/iam.serviceAccountTokenCreator \
  --condition None \
  --quiet >/dev/null

# ---------------------------------------------------------------------------
# scheduler
# ---------------------------------------------------------------------------
if gcloud scheduler jobs describe sweep-tick --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "== scheduler sweep-tick exists"
else
  echo "== scheduler sweep-tick create (${SCHEDULE})"
  gcloud scheduler jobs create pubsub sweep-tick \
    --location "$REGION" --project "$PROJECT_ID" \
    --schedule "$SCHEDULE" \
    --topic sweep-tick \
    --message-body '{"tick":true}' \
    --quiet
fi

echo
gcloud pubsub subscriptions list --project "$PROJECT_ID" \
  --format="table(name,pushConfig.pushEndpoint)"
