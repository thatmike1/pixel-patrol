#!/bin/bash
# REHEARSAL: sweeps demo-atelier, the control site. It never drifts and never files a
# ticket, so a rehearsal costs nothing and leaves no state behind.
RIG="$(cd "$(dirname "$0")" && pwd)"
source "$RIG/lib.sh"

say "site demo-atelier  ::  the control. four real trackers, and it must stay silent."
sleep 2
say "its last decision"
api GET "/sites/demo-atelier/decisions?limit=1" | jq -c '.decisions[0] | {action, sweepId, noiseCount}'
sleep 6
mark DRIFT_LIVE
sleep 2
say "forcing a sweep the way the scheduler forces one"
date -u '+%H:%M:%SZ  POST /sites/demo-atelier/sweep'
api POST /sites/demo-atelier/sweep -d '{}' | jq -c .
mark SWEEP_SENT

say "live from Cloud Logging while the pipeline runs:"
stream_logs 210 "analysis complete	demo-atelier"

say "verdict"
api GET "/sites/demo-atelier/decisions?limit=1" | jq '.decisions[0] | {action, noiseCount, summary}'
echo "https://github.com/thatmike1/pixel-patrol-tickets/issues/23" > "$RIG/issue-url.txt"
mark ISSUE_READY
sleep 90
