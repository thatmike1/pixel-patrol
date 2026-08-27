#!/bin/bash
# REHEARSAL: sweeps demo-atelier (always noop, no ticket) to validate mechanics only.
RIG="$(dirname "$0")"; MARKS="$RIG/marks.txt"
mark(){ echo "$1" >> "$MARKS"; }
export CLOUDSDK_ACTIVE_CONFIG_NAME=pixel-patrol PROJECT_ID=pixel-patrol-mp
AGENT_URL=https://patrol-agent-b2xhora5ka-ew.a.run.app
ADMIN_KEY="$(gcloud run services describe patrol-agent --region europe-west1 --project pixel-patrol-mp --format json | jq -r '.spec.template.spec.containers[0].env[]? | select(.name=="ADMIN_KEY") | .value')"
api(){ local m="$1" p="$2"; shift 2; curl -sS -X "$m" "${AGENT_URL}${p}" -H "Authorization: Bearer $(gcloud auth print-identity-token)" -H "x-admin-key: ${ADMIN_KEY}" -H 'content-type: application/json' "$@"; }
say(){ printf '\n\033[1;36m%s\033[0m\n' "$1"; }

say "REHEARSAL TAKE  (demo-atelier, the control site - it must stay silent)"
sleep 2
say "current approved baseline"
api GET "/sites/demo-atelier/decisions?limit=1" | jq -c '.decisions[0] | {action, sweepId, noiseCount}'
sleep 3
mark DRIFT_LIVE
say "forcing a sweep - nothing is touched after this point"
date -u '+%H:%M:%SZ  POST /sites/demo-atelier/sweep'
api POST /sites/demo-atelier/sweep -d '{}' | jq -c .
mark SWEEP_SENT
say "waiting for the pipeline. live from Cloud Logging:"
for i in $(seq 1 20); do
  gcloud logging read 'logName="projects/pixel-patrol-mp/logs/run.googleapis.com%2Fstdout" AND resource.labels.service_name="patrol-agent"' \
    --project pixel-patrol-mp --limit 3 --freshness=2m \
    --format='value(timestamp,jsonPayload.msg,jsonPayload.siteId,jsonPayload.action)' 2>/dev/null | tail -3
  sleep 6
done
say "verdict"
api GET "/sites/demo-atelier/decisions?limit=1" | jq '.decisions[0] | {action, noiseCount, summary}'
echo "https://github.com/thatmike1/pixel-patrol-tickets/issues/23" > "$RIG/issue-url.txt"
mark ISSUE_READY
sleep 60
