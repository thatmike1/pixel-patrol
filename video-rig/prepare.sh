#!/bin/bash
# Run BEFORE a take. Resets the five demo sites to a clean approved baseline.
# Takes about four minutes, most of it waiting. See docs/demo-runbook.md section (a).
set -euo pipefail
RIG="$(cd "$(dirname "$0")" && pwd)"; REPO="$RIG/.."
export CLOUDSDK_ACTIVE_CONFIG_NAME=pixel-patrol PROJECT_ID=pixel-patrol-mp
AGENT_URL=https://patrol-agent-b2xhora5ka-ew.a.run.app
ADMIN_KEY="$(gcloud run services describe patrol-agent --region europe-west1 --project pixel-patrol-mp --format json | jq -r '.spec.template.spec.containers[0].env[]? | select(.name=="ADMIN_KEY") | .value')"
api(){ local m="$1" p="$2"; shift 2; curl -sS -X "$m" "${AGENT_URL}${p}" -H "Authorization: Bearer $(gcloud auth print-identity-token)" -H "x-admin-key: ${ADMIN_KEY}" -H 'content-type: application/json' "$@"; }
echo "1/4 pages back to unedited state"
npm --prefix "$REPO/demo-sites" run drift -- reset
PROJECT_ID=pixel-patrol-mp "$REPO/infra/deploy-demo-sites.sh"
echo "2/4 wiping sweep history"
GOOGLE_CLOUD_PROJECT=pixel-patrol-mp npm --prefix "$REPO/agent" run reset-demo-site -- \
  demo-boutique demo-magazine demo-clinic demo-bistro demo-atelier
echo "3/4 one sweep each"
for s in boutique magazine clinic bistro atelier; do api POST "/sites/demo-$s/sweep" -d '{}'; echo; done
echo "4/4 waiting 150s then confirming"
sleep 150
for s in boutique magazine clinic bistro atelier; do
  printf "%-16s " "demo-$s"; api GET "/sites/demo-$s/decisions?limit=1" | jq -r '.decisions[0].action'
done
