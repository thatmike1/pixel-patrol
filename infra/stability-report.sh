#!/usr/bin/env bash
# prints what the stability window thinks about a site: every registrable domain
# with how often it appeared in the last N sweeps, whether the baseline has it,
# and which class it landed in — then the decisions the analyst recorded.
#
# this is the tuning tool. the window size N and the removal threshold M are
# guesses until they are checked against real overnight data from a site with
# real ad tech on it.
#
#   PROJECT_ID=pixel-patrol-mp ./infra/stability-report.sh smoke-trackers [N]
#
# read-only: it writes nothing to Firestore. Auth is Application Default
# Credentials, same as everything else.
set -euo pipefail
SITE_ID="${1:?usage: stability-report.sh <site-id> [window-size]}"
WINDOW="${2:-${STABILITY_WINDOW:-5}}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:-${PROJECT_ID:-pixel-patrol-mp}}" \
GONE_AFTER="${GONE_AFTER:-3}" \
  npm --prefix "${ROOT}/agent" run --silent report -- "$SITE_ID" "$WINDOW"
