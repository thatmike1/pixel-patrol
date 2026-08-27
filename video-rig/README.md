# Video rig

Records a single continuous 1920x1080 take of a real terminal and a real browser
doing real work, with no human at the keyboard and no portal picker. Built and
proven on 2026-08-27; a rehearsal take of 208s is the evidence.

## Why it exists

Mike's desktop is Wayland. `ffmpeg -f x11grab -i :0` returns a pure black frame
(verified: mean 0, stddev 0), OBS and the PipeWire route both need a human click in
the portal picker, and `wf-recorder` is not installed. Xvfb sidesteps all of it: a
virtual X display nobody has to look at, which x11grab captures perfectly.

## Pieces

| file | what it does |
| --- | --- |
| `stage.sh` | starts Xvfb on `:99` at 1920x1080 and paints the root window |
| `take.mjs` | the orchestrator: launches the browser, starts ffmpeg, runs the cards, tiles the panes, follows the narrative's markers, navigates to the ticket |
| `narrative-rehearsal.sh` | the terminal side of a SAFE take: sweeps `demo-atelier`, which never drifts and never files a ticket |
| `cards/title.html` | auto-advancing title cards (problem, value proposition) |
| `cards/arch.html` | the architecture diagram, shown during the sweep wait |

`take.mjs` and the narrative script stay in sync through a marker file
(`marks.txt`): the shell appends `DRIFT_LIVE`, `SWEEP_SENT`, `ISSUE_READY`, and the
orchestrator waits on each before moving the browser. Time-based sync would drift,
because the crawler cold start varies between 42 and 76 seconds.

## Run it

```bash
cd ~/git/pixel-patrol/video-rig
./stage.sh
node take.mjs rehearsal       # writes take-rehearsal.mp4 here
```

Watch it with any player; the frames are also extractable with
`ffmpeg -ss <sec> -i take-rehearsal.mp4 -frames:v 1 out.png`.

## Landmines, all of them hit at least once

**`pkill -f` kills the session.** The pattern matches the agent's own shell command
line, so `pkill -f xterm` terminates the shell issuing it (observed twice, exit 144).
Kill windows with `xdotool windowkill`, or processes by explicit PID.

**Chromium ignores `DISPLAY` when `WAYLAND_DISPLAY` is set.** It picks the Ozone
Wayland backend and the window opens on the real desktop, invisible to the recording
and visible to Mike. Every launch needs `WAYLAND_DISPLAY=` cleared *and*
`--ozone-platform=x11`.

**There is no window manager on `:99`.** Nothing maps or positions windows for you.
Place them with `xdotool windowmove`/`windowsize` after they appear. The upside is
no title bars.

**`xdotool search --name Chromium` fails in kiosk mode**, because the window title
becomes the page title. Search `--class chromium` instead.

**Set `LC_ALL=C` on the terminal.** Otherwise `date` prints Czech month names into
an English-language video.

## Browser choice, which is not obvious

The rig launches `/usr/bin/google-chrome` (Chrome 148) through Playwright's
`executablePath`, not Playwright's own bundled Chromium. Playwright 1.48 ships Chromium
130, which has no vertical tabs at all, so the flag appears to fail silently. Chrome for
Testing 151 also works but adds its own "only for automated testing" infobar, which needs
`--disable-infobars` on top.

Vertical tabs are a `chrome://flags` entry, not a feature switch. `--enable-features=VerticalTabs`
does nothing. The profile has to be seeded before launch with
`Local State` holding `browser.enabled_labs_experiments: ["vertical-tabs@1"]` and
`Default/Preferences` holding the `vertical_tabs` block. The same Preferences file is the
only thing that suppresses the Google Translate bubble on the Czech demo pages;
`--disable-features=Translate,TranslateUI` does not.

Two smaller traps in the same area: Chrome keeps only the last `--disable-features` it is
given, so every value has to be merged into one switch; and `ignoreDefaultArgs` matches by
exact string, so `'--disable-features'` will not filter Playwright's own
`--disable-features=...`.

## Old defects, both fixed

`stream_logs` used to run zero iterations. `local seconds="$1" t_end=$(( SECONDS + seconds ))`
looks right and is not: bash expands every assignment word before `local` executes, so
`seconds` was still empty and `t_end` equalled the current time. The take raced past the
sweep and printed the previous decision. Keep those on separate lines.

`gcloud logging read` ignores `--freshness` when `--order=asc` is set, which is why the log
pane once showed entries from six days earlier. The query now pins an explicit
`timestamp>=` window computed at script start.

## Still open

1. **The `--no-sandbox` banner.** Chromium shows a yellow "You are using an
   unsupported command-line flag" bar across the top of the page. It is there because
   Ubuntu's AppArmor blocks unprivileged user namespaces
   (`kernel.apparmor_restrict_unprivileged_userns = 1`), so the sandbox cannot start.
   Either ask Mike for `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`
   and then drop `--no-sandbox`, or run `npx playwright install firefox` in the repo
   (the cache holds firefox-1538 but this Playwright wants firefox-1465) and switch
   the rig to Firefox, which has no such banner.

2. **The log pane repeats itself.** `narrative-rehearsal.sh` re-runs
   `gcloud logging read --limit 3` every six seconds and reprints lines it has already
   shown. It needs to track the last timestamp it printed and only append newer lines.
