#!/usr/bin/env bash
# creates the one alert the system has: something is parked in a dead-letter queue.
# describe-before-create on both the channel and the policy, so it is safe to re-run.
#
#   PROJECT_ID=pixel-patrol-mp ALERT_EMAIL=you@example.com ./infra/wire-alerts.sh
#
# a DLQ that nobody watches is a slower version of the bug it exists to catch: the
# message survives, and still nobody finds out. this closes that.
set -euo pipefail
PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
ALERT_EMAIL="${ALERT_EMAIL:-thatmike.dev@gmail.com}"
CHANNEL_NAME="${CHANNEL_NAME:-Pixel Patrol operator}"
POLICY_NAME="Pixel Patrol: a message is parked in a dead-letter queue"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== notification channel for ${ALERT_EMAIL}"
CHANNEL="$(gcloud alpha monitoring channels list --project "$PROJECT_ID" \
  --filter="type=\"email\" AND labels.email_address=\"${ALERT_EMAIL}\"" \
  --format='value(name)' --limit=1)"
if [[ -z "$CHANNEL" ]]; then
  CHANNEL="$(gcloud alpha monitoring channels create --project "$PROJECT_ID" \
    --display-name="$CHANNEL_NAME" --type=email \
    --channel-labels="email_address=${ALERT_EMAIL}" \
    --format='value(name)')"
  echo "created ${CHANNEL}"
else
  echo "exists ${CHANNEL}"
fi

echo "== alert policy"
# the display name is the identity here: the policy has no user-settable id, and
# creating it twice would mean two mails per parked message
EXISTING="$(gcloud alpha monitoring policies list --project "$PROJECT_ID" \
  --filter="displayName=\"${POLICY_NAME}\"" --format='value(name)' --limit=1)"
if [[ -n "$EXISTING" ]]; then
  echo "exists ${EXISTING}"
else
  gcloud alpha monitoring policies create --project "$PROJECT_ID" \
    --policy-from-file="${ROOT}/infra/dlq-alert-policy.json" \
    --notification-channels="$CHANNEL"
fi
