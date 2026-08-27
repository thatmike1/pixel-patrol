# shared helpers for the narrative scripts
export CLOUDSDK_ACTIVE_CONFIG_NAME=pixel-patrol PROJECT_ID=pixel-patrol-mp
AGENT_URL=https://patrol-agent-b2xhora5ka-ew.a.run.app
MARKS="$RIG/marks.txt"
mark(){ echo "$1" >> "$MARKS"; }
say(){ printf '\n\033[1;36m%s\033[0m\n' "$1"; }
ADMIN_KEY="$(gcloud run services describe patrol-agent --region europe-west1 --project pixel-patrol-mp --format json | jq -r '.spec.template.spec.containers[0].env[]? | select(.name=="ADMIN_KEY") | .value')"
api(){ local m="$1" p="$2"; shift 2; curl -sS -X "$m" "${AGENT_URL}${p}" -H "Authorization: Bearer $(gcloud auth print-identity-token)" -H "x-admin-key: ${ADMIN_KEY}" -H 'content-type: application/json' "$@"; }
LAST=""
# print only Cloud Logging lines newer than the last one already printed
stream_logs(){
  local seconds="$1" t_end=$(( SECONDS + seconds )) out ts line
  while (( SECONDS < t_end )); do
    out=$(gcloud logging read \
      'logName="projects/pixel-patrol-mp/logs/run.googleapis.com%2Fstdout" AND resource.labels.service_name="patrol-agent"' \
      --project pixel-patrol-mp --limit 20 --freshness=5m --order=asc \
      --format='value(timestamp,jsonPayload.msg,jsonPayload.siteId,jsonPayload.action)' 2>/dev/null)
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      ts="${line%%$'\t'*}"
      if [[ -z "$LAST" || "$ts" > "$LAST" ]]; then printf '%s\n' "$line"; LAST="$ts"; fi
    done <<< "$out"
    sleep 5
  done
}
