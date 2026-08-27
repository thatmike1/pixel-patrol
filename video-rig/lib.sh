# shared helpers for the narrative scripts
export CLOUDSDK_ACTIVE_CONFIG_NAME=pixel-patrol PROJECT_ID=pixel-patrol-mp
AGENT_URL=https://patrol-agent-b2xhora5ka-ew.a.run.app
MARKS="$RIG/marks.txt"
mark(){ echo "$1" >> "$MARKS"; }
say(){ printf '\n\033[1;36m%s\033[0m\n' "$1"; }
ADMIN_KEY="$(gcloud run services describe patrol-agent --region europe-west1 --project pixel-patrol-mp --format json | jq -r '.spec.template.spec.containers[0].env[]? | select(.name=="ADMIN_KEY") | .value')"
api(){ local m="$1" p="$2"; shift 2; curl -sS -X "$m" "${AGENT_URL}${p}" -H "Authorization: Bearer $(gcloud auth print-identity-token)" -H "x-admin-key: ${ADMIN_KEY}" -H 'content-type: application/json' "$@"; }
LAST=""
# gcloud ignores --freshness when --order=asc is set, so pin the window explicitly.
START_TS="$(date -u -d '-2 minutes' +%Y-%m-%dT%H:%M:%SZ)"
# Print only Cloud Logging lines newer than the last one already printed, and stop as soon
# as the pipeline says it is finished. Without the early exit the pane keeps polling an idle
# service for the rest of the window, which cost about 65 seconds of the four-minute budget.
# $1 seconds to wait at most, $2 optional substring that ends the wait when it appears.
stream_logs(){
  # NOTE: bash expands every assignment word before `local` runs, so a second
  # assignment cannot read the first one. Keep these on separate lines.
  local seconds="$1"
  local stop_on="${2:-}"
  local out ts line t_end
  t_end=$(( SECONDS + seconds ))
  while (( SECONDS < t_end )); do
    out=$(gcloud logging read \
      "logName=\"projects/pixel-patrol-mp/logs/run.googleapis.com%2Fstdout\" AND resource.labels.service_name=\"patrol-agent\" AND jsonPayload.msg:* AND timestamp>=\"${START_TS}\"" \
      --project pixel-patrol-mp --limit 20 --order=asc \
      --format='value(timestamp,jsonPayload.msg,jsonPayload.siteId,jsonPayload.action)' 2>/dev/null)
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      ts="${line%%$'\t'*}"
      if [[ -z "$LAST" || "$ts" > "$LAST" ]]; then
        printf '%s\n' "$line"; LAST="$ts"
        if [[ -n "$stop_on" && "$line" == *"$stop_on"* ]]; then sleep 2; return 0; fi
      fi
    done <<< "$out"
    sleep 5
  done
}
