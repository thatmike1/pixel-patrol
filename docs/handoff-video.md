# Handoff: record and submit the Pixel Patrol demo video

You are picking this up to produce the submitted video. The recording rig is built and
proven; what remains is one real take, a decision about GCP Console footage, and the
Devpost form. Submission closes **31 Aug 2026, 5pm PT**.

Read `video-rig/README.md` first. It documents the rig and five landmines that each cost
a debugging cycle already, including a `pkill -f` pattern that terminates your own shell.

## What is already true

- The demo chain was verified green end to end on 27 Aug and all five demo sites were
  left at `baseline-created`. Evidence is in the notes on bead `ccChat-general-5k6`.
- The six IAM revocations are live; `docs/iam.md` matches the project policy.
- `video-rig/` records a continuous 1920x1080 take on a virtual display with no human at
  the keyboard. A 208-second rehearsal against `demo-atelier` proved every mechanism:
  title cards, tiling a real terminal beside a real browser, streaming Cloud Logging
  output, and navigating to a live GitHub issue. That file is at
  `~/Videos/pixel-patrol-rehearsal.mp4` — watch it before changing anything.

## The rules that shape the take

From `docs/submission-checklist.md`, re-verified against the live rules page on 27 Aug:

- Four minutes maximum; only the first four are evaluated.
- Must cover the problem, the value proposition, and a demo of the app in action.
- Must show "an unedited, live execution of the agent performing its task (via terminal
  logs, database updates, or UI changes)".
- Must demonstrate the backend runs on Google Cloud. A `.run.app` URL on screen counts,
  as do terminal logs.
- English, or English subtitles. **Spoken narration is not required**, which is why this
  rig exists.
- Public on YouTube or Vimeo.

Retakes are fine. "Unedited" constrains a single take, not how many you shoot.

## What to do

**1. Fix the two known defects.** Both are described with their causes in
`video-rig/README.md`: the Chromium `--no-sandbox` banner across the top of the browser
pane, and the log pane reprinting lines it has already shown. The banner needs either a
`sysctl` from Mike or a Firefox download; ask him, do not assume.

**2. Write `narrative.sh`, the real terminal side.** `narrative-rehearsal.sh` is the
template. The real one runs the boutique drift shape from `docs/demo-runbook.md`:
reset, show the approved baseline (zero third-party hosts), induce `boutique-pixel`,
redeploy, force the sweep, stream logs while it runs, print the verdict, then write the
new issue URL to `issue-url.txt` and mark `ISSUE_READY`. Every command is already
copy-paste in the runbook.

**3. Budget the four minutes.** The rehearsal spent 31s on cards and reached the ticket
at 196s. A drift sweep costs 30 to 60 seconds more than the atelier noop did, because of
the scribe's Gemini turn. Cut the cards to three, and keep the whole thing under 3:45 so
a slow cold start does not push you over. The measured latency budget is in the bead
note: 42-76s container cold start, ~46s crawl, ~17s analyst, ~38s scribe on drift.

**4. Reset before every take.** Runbook section (a), including the history wipe in step
2. Skipping it makes a re-induced drift classify as `flapping` and the watchdog silently
does nothing, which on camera is indistinguishable from a broken product.

**5. Film between :05 and :50 past the hour.** The scheduler sweeps every enabled site at
`0 * * * *` and can report your induced drift before your forced sweep does. Do not
change the cadence.

## Two decisions that are Mike's, not yours

**GCP Console footage.** He has offered to log a browser in for you. The rules do not
require the Console — a `.run.app` URL and terminal logs satisfy the Google Cloud
criterion, and the rehearsal already shows both. Console footage is nicer to look at.
Ask before touching any browser profile of his, and never copy credentials anywhere.

**YouTube upload.** His account, his job. Hand him the finished file.

## A caution about the pages

The demo sites are Czech-language, and `/boutique/` is a candle workshop named "Ateliér
Lumen", which reads confusingly next to the separate `demo-atelier` control site. On
camera, keep the site id visible in the terminal so the two do not blur together. The
ticket and email bodies are already English-framed with the Czech redline under an
English heading, so the deliverable itself reads correctly to a judge.
