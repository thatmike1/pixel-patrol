#!/bin/bash
# The terminal half of the real take: the boutique drift shape, end to end.
# Run ./prepare.sh first - this script assumes all five sites sit at an approved baseline.
RIG="$(cd "$(dirname "$0")" && pwd)"
source "$RIG/lib.sh"

say "site demo-boutique  ::  https://demo-sites-b2xhora5ka-ew.a.run.app/boutique/"
sleep 1
say "its last decision: the baseline this page was approved at"
api GET "/sites/demo-boutique/decisions?limit=1" | jq -c '.decisions[0] | {action, sweepId, noiseCount, summary}'
sleep 5

say "a marketer adds a Meta Pixel to the page"
npm --prefix "$RIG/../demo-sites" run drift -- induce boutique-pixel
PROJECT_ID=pixel-patrol-mp "$RIG/../infra/deploy-demo-sites.sh" 2>&1 | tail -4
mark DRIFT_LIVE
sleep 3

say "nobody tells the watchdog. a sweep is forced the way the scheduler forces one."
date -u '+%H:%M:%SZ  POST /sites/demo-boutique/sweep'
api POST /sites/demo-boutique/sweep -d '{}' | jq -c .
mark SWEEP_SENT

log_window_reset
say "live from Cloud Logging while the pipeline runs:"
stream_logs 210 "analysis complete	demo-boutique	drift"

say "verdict"
api GET "/sites/demo-boutique/decisions?limit=1" | jq '.decisions[0] | {action, hostsAdded, classifications: [.classifications[]? | {domain, vendor, category, confidence}]}'
sleep 2
say "what left the system"
api GET "/sites/demo-boutique/notifications?limit=1" | jq -c '.notifications[0] | {issue: .issue.number, url: .issue.url, email: .email.id, to: .email.to}'
api GET "/sites/demo-boutique/notifications?limit=1" | jq -r '.notifications[0].issue.url' > "$RIG/issue-url.txt"
mark ISSUE_READY
sleep 90
