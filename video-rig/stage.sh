#!/bin/bash
# Starts the virtual stage (Xvfb :99 at 1920x1080). Idempotent-ish: exits 0 if already up.
set -euo pipefail
DISP="${DISP:-:99}"
if DISPLAY=$DISP xdpyinfo >/dev/null 2>&1; then echo "stage already up on $DISP"; exit 0; fi
Xvfb "$DISP" -screen 0 2560x1440x24 -nolisten tcp >/tmp/xvfb$DISP.log 2>&1 &
for _ in $(seq 1 40); do DISPLAY=$DISP xdpyinfo >/dev/null 2>&1 && break; sleep 0.25; done
DISPLAY=$DISP xsetroot -solid '#0b1020' 2>/dev/null || true
DISPLAY=$DISP xdpyinfo | grep dimensions
