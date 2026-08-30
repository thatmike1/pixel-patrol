# shared helpers for the narrative scripts
export CLOUDSDK_ACTIVE_CONFIG_NAME=pixel-patrol PROJECT_ID=pixel-patrol-mp
AGENT_URL=https://patrol-agent-b2xhora5ka-ew.a.run.app
MARKS="$RIG/marks.txt"
mark(){ echo "$1" >> "$MARKS"; }
say(){ printf '\n\033[1;36m%s\033[0m\n' "$1"; }
ADMIN_KEY="$(gcloud run services describe patrol-agent --region europe-west1 --project pixel-patrol-mp --format json | jq -r '.spec.template.spec.containers[0].env[]? | select(.name=="ADMIN_KEY") | .value')"
# minted once: gcloud auth print-identity-token costs about a second, and api() sits on the
# take's critical path between the verdict and the filed ticket. Tokens are valid for an hour.
ID_TOKEN="$(gcloud auth print-identity-token)"
api(){ local m="$1" p="$2"; shift 2; curl -sS -X "$m" "${AGENT_URL}${p}" -H "Authorization: Bearer ${ID_TOKEN}" -H "x-admin-key: ${ADMIN_KEY}" -H 'content-type: application/json' "$@"; }
# Dedupe by whole line, not by a high-water timestamp. The two log sources reach Cloud
# Logging with different ingestion lag, so a crawler line stamped later can arrive first and
# push a monotonic cursor past the agent's verdict line - which then never prints and never
# trips the early exit. Three takes ran the full 210s timeout and came out at 4:57.
SEEN_FILE="$(mktemp -t patrol-logseen.XXXXXX)"
trap 'rm -f "$SEEN_FILE"' EXIT
# The stage strip on the architecture card ticks off these, and nothing else. Each one is a
# line the pipeline itself logged, matched against the site under test so a concurrent sweep
# of a sibling site cannot tick a stage early.
SITE_ID="${SITE_ID:-demo-boutique}"
stage_marks(){
  case "$1" in
    *"sweep starting"*"$SITE_ID"*) mark CRAWL_BOOTED ;;
    *"sweep complete"*"$SITE_ID"*) mark CRAWL_DONE ;;
    *"ticket filed"*"$SITE_ID"*)   mark TICKET_FILED ;;
  esac
}
# gcloud ignores --freshness when --order=asc is set, so pin the window explicitly.
START_TS="$(date -u -d '-2 minutes' +%Y-%m-%dT%H:%M:%SZ)"
# Call this immediately before streaming so the window starts at the sweep being watched.
# Without it the window still holds the reset's own "analysis complete" lines and the
# early exit fires on one of those instead of on this sweep's verdict.
log_window_reset(){ START_TS="$(date -u -d '-5 seconds' +%Y-%m-%dT%H:%M:%SZ)"; : > "$SEEN_FILE"; }
# Print only Cloud Logging lines newer than the last one already printed, and stop as soon
# as the pipeline says it is finished. Without the early exit the pane keeps polling an idle
# service for the rest of the window, which cost about 65 seconds of the four-minute budget.
# $1 seconds to wait at most, $2 optional substring that ends the wait when it appears.
stream_logs(){
  # NOTE: bash expands every assignment word before `local` runs, so a second
  # assignment cannot read the first one. Keep these on separate lines.
  local seconds="$1"
  local stop_on="${2:-}"
  local out line t_end t_start waiting
  t_start=$SECONDS
  waiting=0
  t_end=$(( SECONDS + seconds ))
  while (( SECONDS < t_end )); do
    # --order=asc returns the OLDEST N in the window, so a limit smaller than the window's
    # entry count hides the newest lines entirely. At 30 the verdict line the early exit
    # watches for was unreachable once crawler logs joined the stream (a sweep window holds
    # about 84 entries). A comment cannot live inside the backslash chain below: the join
    # happens before tokenising, so it would swallow every argument after it.
    out=$(gcloud logging read \
      "logName=\"projects/pixel-patrol-mp/logs/run.googleapis.com%2Fstdout\" AND (resource.labels.service_name=\"patrol-agent\" OR (resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"patrol-crawler\")) AND (jsonPayload.msg:* OR textPayload:*) AND timestamp>=\"${START_TS}\"" \
      --project pixel-patrol-mp --limit 500 --order=asc \
      --format='value(timestamp,jsonPayload.msg,jsonPayload.siteId,jsonPayload.action,textPayload)' 2>/dev/null)
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      if ! grep -Fxq -- "$line" "$SEEN_FILE" 2>/dev/null; then
        printf '%s\n' "$line" >> "$SEEN_FILE"
        (( waiting )) && { printf '\r\033[2K'; waiting=0; }
        printf '%s\n' "$line"
        stage_marks "$line"
        if [[ -n "$stop_on" && "$line" == *"$stop_on"* ]]; then sleep 2; return 0; fi
      fi
    done <<< "$out"
    # The pipeline can run for over a minute with nothing new to say - the crawler's cold
    # start alone varies between 42 and 76 seconds. Polling silently froze the pane for 72
    # seconds on one take (measured with freezedetect). Tick a carriage-returned elapsed
    # counter between polls so the pane stays visibly alive without inventing progress.
    for _ in 1 2 3 4 5; do
      printf '\r  \033[2mpipeline running, %02d:%02d elapsed\033[0m' \
        $(( (SECONDS - t_start) / 60 )) $(( (SECONDS - t_start) % 60 ))
      waiting=1
      sleep 1
    done
  done
}
